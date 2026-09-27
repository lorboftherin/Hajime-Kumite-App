from __future__ import annotations

import logging
from contextlib import asynccontextmanager

import anyio
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app import __version__
from app.api.errors import install_handlers
from app.api.routers import (
    accounts,
    billing,
    certificates,
    checkin,
    competition,
    core,
    dojo_portal,
    history,
    horarios,
    organizations,
    organizer,
    public,
    public_profiles,
    push,
    ranking,
    templates,
    tournaments,
)
from app.config import DEFAULT_SECRET, get_settings
from app.db.base import get_engine
from app.observability import RequestContextMiddleware, configure_azure_monitor, configure_logging
from app.prepare import prepare_database
from app.services import entitlements

# Rutas de la interfaz que se pueden incrustar en un marco: el overlay para OBS
# (frontend/src/app/features/public/overlay.ts, /overlay/<token>/<tatami>).
FRAMEABLE_PATHS = ("/overlay/",)
READY_TIMEOUT_SECONDS = 2.0


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings = get_settings()
    # Las rutas son síncronas y corren en un grupo de hilos; se limita su tamaño (ver config).
    anyio.to_thread.current_default_thread_limiter().total_tokens = settings.worker_threads
    if settings.environment not in ("dev", "test") and (
        settings.jwt_secret == DEFAULT_SECRET or len(settings.jwt_secret) < 32
    ):
        raise RuntimeError(
            "HAJIME_JWT_SECRET (mínimo 32 caracteres) o HAJIME_SECRET_FILE debe configurarse fuera de dev/test"
        )
    if aviso := entitlements.billing_mode_warning():
        logging.getLogger("hajime.pagos").warning(aviso)
    if settings.migrate_on_startup:
        # Desarrollo (uvicorn a mano): cada proceso prepara la base al arrancar,
        # con un candado para que varios no choquen. En el contenedor viene en
        # false: el entrypoint ya lo hizo una vez (python -m app.prepare).
        prepare_database(settings, get_engine())
    dispatcher = _start_mail_dispatcher(settings)
    push_service = _start_push_service(settings)
    try:
        yield
    finally:
        if dispatcher is not None:
            dispatcher.stop()
        if push_service is not None:
            push_service.stop()


def _start_mail_dispatcher(settings):
    """Hilo que envía los correos de la bandeja de salida (ver app/services/mail.py).

    No arranca con una base SQLite en memoria (las pruebas): ahí todos los hilos
    comparten una sola conexión y el despachador chocaría con las peticiones.
    """
    if not settings.mail_dispatcher:
        return None
    engine = get_engine()
    if engine.url.get_backend_name() == "sqlite" and engine.url.database in (None, "", ":memory:"):
        return None
    if settings.environment == "prod" and settings.mail_provider == "console":
        logging.getLogger("hajime.mail").warning(
            "HAJIME_MAIL_PROVIDER=console en producción: los correos solo quedan en el log"
        )
    from app.db.base import session_factory
    from app.services.mail import MailDispatcher

    dispatcher = MailDispatcher(session_factory(), settings)
    dispatcher.start()
    return dispatcher


def _start_push_service(settings):
    """Hilo de avisos push: recorre los torneos que cambian y envía la bandeja
    (ver app/services/push.py). Solo con claves VAPID y, como el de correo, no
    con SQLite en memoria (las pruebas)."""
    from app.services import push as push_svc
    from app.services import push_eval  # noqa: F401 - registra el oyente de cambios

    if not settings.push_dispatcher or not push_svc.enabled(settings):
        return None
    engine = get_engine()
    if engine.url.get_backend_name() == "sqlite" and engine.url.database in (None, "", ":memory:"):
        return None
    from app.db.base import session_factory

    service = push_svc.PushService(session_factory(), settings)
    service.start()
    return service


def _ping_database() -> None:
    with get_engine().connect() as conn:
        conn.exec_driver_sql("SELECT 1")


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging(settings.log_level, settings.log_format)
    configure_azure_monitor()  # antes de crear la app, para que instrumente FastAPI
    docs = settings.docs_enabled()
    app = FastAPI(
        title="Hajime — API de torneos de karate",
        version=__version__,
        description="API First: toda acción es un endpoint. Errores con formato uniforme; "
        "advertencias de negocio con código WARNINGS que se aceptan reenviando `override`.",
        lifespan=lifespan,
        docs_url="/docs" if docs else None,
        redoc_url="/redoc" if docs else None,
        openapi_url="/openapi.json" if docs else None,
    )
    # El orden importa: el último agregado envuelve a los demás. CORS queda por
    # fuera para que también los errores 500 lleven sus cabeceras.
    app.add_middleware(
        RequestContextMiddleware,
        hsts=settings.environment != "dev",
        frame_allowed_prefixes=FRAMEABLE_PATHS,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_cors_origins(),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["X-Request-ID", "Retry-After"],
    )
    install_handlers(app)
    routers = (
        core.router,
        accounts.router,
        templates.router,
        tournaments.router,
        competition.router,
        organizer.router,
        checkin.router,
        certificates.router,
        ranking.router,
        history.router,
        horarios.router,
        organizations.router,
        billing.router,
        dojo_portal.router,
        public_profiles.router,
        public.router,
        push.router,
    )
    for r in routers:
        app.include_router(r, prefix="/api/v1")

    @app.get("/health/live", tags=["meta"])
    def health_live():
        """El proceso responde. No toca la base: si esta se pausa, el contenedor no se reinicia."""
        return {"status": "ok", "environment": settings.environment}

    # Alias de siempre (Dockerfile, CI y el ambiente de Azure lo usan).
    app.add_api_route("/health", health_live, methods=["GET"], tags=["meta"])

    # Hilos propios para /health/ready: si los de las peticiones están todos
    # ocupados, la sonda no debe quedarse esperando turno. Se crea dentro del
    # bucle de eventos, en la primera sonda.
    ready_limiter: list[anyio.CapacityLimiter] = []

    @app.get("/health/ready", tags=["meta"])
    async def health_ready():
        """Lista para atender: la base responde a SELECT 1 en menos de 2 s."""
        if not ready_limiter:
            ready_limiter.append(anyio.CapacityLimiter(2))
        ok = False
        with anyio.move_on_after(READY_TIMEOUT_SECONDS):
            try:
                await anyio.to_thread.run_sync(_ping_database, abandon_on_cancel=True, limiter=ready_limiter[0])
                ok = True
            except Exception as e:  # noqa: BLE001 - cualquier fallo es «no lista»
                logging.getLogger("hajime.health").warning("La base no responde: %s", str(e)[:300])
        if ok:
            return {"status": "ok", "database": "ok"}
        return JSONResponse(
            {"status": "unavailable", "database": "unavailable"}, status_code=503, headers={"Retry-After": "10"}
        )

    if settings.static_dir:
        mount_frontend(app, settings.static_dir)
    return app


def mount_frontend(app: FastAPI, directory: str) -> None:
    """Sirve el frontend compilado desde la misma URL que la API.

    Las rutas de Angular (p. ej. /mesa/12) devuelven index.html; /api y /docs
    siguen siendo de la API.
    """
    from functools import partial
    from pathlib import Path

    from fastapi import Request, Response
    from fastapi.responses import FileResponse, HTMLResponse
    from starlette.exceptions import HTTPException as StarletteHTTPException
    from starlette.staticfiles import StaticFiles

    from app.services import share_preview

    root = Path(directory)
    index = root / "index.html"
    if not index.exists():
        raise RuntimeError(f"No se encontró {index}; compile el frontend (npx ng build)")

    class SPAStaticFiles(StaticFiles):
        async def get_response(self, path, scope):
            try:
                return await super().get_response(path, scope)
            except StarletteHTTPException as e:
                if e.status_code != 404 or path.startswith(("api/", "docs", "openapi")):
                    raise
                preview = await _share_preview(path, scope)
                if preview is not None:
                    return preview
                return FileResponse(index)

    async def _share_preview(path: str, scope) -> Response | None:
        """Rutas públicas (/t/<slug>, /competidor/<id>…): index.html con las
        etiquetas para la vista previa al compartir (app.services.share_preview)."""
        if not share_preview.is_public_path(path):
            return None
        base_url = str(Request(scope).base_url).rstrip("/")
        render = partial(share_preview.render, index, path, base_url, share_preview.session)
        try:
            doc = await anyio.to_thread.run_sync(render)
        except Exception:  # noqa: BLE001 - sin vista previa, la página igual funciona
            logging.getLogger("hajime.share").warning("No se pudo armar la vista previa de %s", path, exc_info=True)
            return None
        if doc is None:
            return None
        return HTMLResponse(doc, headers={"Cache-Control": "public, max-age=60"})

    app.mount("/", SPAStaticFiles(directory=root, html=True), name="frontend")


app = create_app()
