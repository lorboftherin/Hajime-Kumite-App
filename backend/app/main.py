from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.errors import install_handlers
from app.api.routers import competition, core, history, tournaments
from app.config import DEFAULT_SECRET, get_settings
from app.db.base import get_engine


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings = get_settings()
    if settings.environment not in ("dev", "test") and (
        settings.jwt_secret == DEFAULT_SECRET or len(settings.jwt_secret) < 32
    ):
        raise RuntimeError(
            "HAJIME_JWT_SECRET (mínimo 32 caracteres) o HAJIME_SECRET_FILE debe configurarse fuera de dev/test"
        )
    if get_engine().url.get_backend_name() == "sqlite" or settings.auto_create_schema:
        # SQLite (desarrollo, pruebas, instalación local): se aplican las
        # migraciones al iniciar, así una actualización no pierde datos.
        # En SQL Server se aplican con `alembic upgrade head` (ver docs).
        from app.db.migrate import upgrade_database

        upgrade_database(get_engine())
    bootstrap(settings)
    yield


def bootstrap(settings) -> None:
    """Primer arranque: crea el admin y la plantilla base si no existen."""
    from sqlalchemy import func, select

    from app.db.base import get_session
    from app.db.models import CategoryTemplate, User

    db = next(get_session())
    try:
        if settings.admin_password and not db.scalar(select(func.count()).select_from(User)):
            from app.seed import cmd_admin

            cmd_admin(settings.admin_username, settings.admin_password)
        if settings.load_base_template and db.scalar(select(func.count()).select_from(User)):
            if not db.scalar(select(func.count()).select_from(CategoryTemplate)):
                from app.seed import cmd_template

                cmd_template()
    finally:
        db.close()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="Hajime — API de torneos de karate",
        version="0.1.0",
        description="API First: toda acción es un endpoint. Errores con formato uniforme; "
        "advertencias de negocio con código WARNINGS que se aceptan reenviando `override`.",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    install_handlers(app)
    for r in (core.router, tournaments.router, competition.router, history.router):
        app.include_router(r, prefix="/api/v1")

    @app.get("/health", tags=["meta"])
    def health():
        return {"status": "ok", "environment": settings.environment}

    if settings.static_dir:
        mount_frontend(app, settings.static_dir)
    return app


def mount_frontend(app: FastAPI, directory: str) -> None:
    """Sirve el frontend compilado desde la misma URL que la API.

    Las rutas de Angular (p. ej. /mesa/12) devuelven index.html; /api y /docs
    siguen siendo de la API.
    """
    from pathlib import Path

    from fastapi.responses import FileResponse
    from starlette.exceptions import HTTPException as StarletteHTTPException
    from starlette.staticfiles import StaticFiles

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
                return FileResponse(index)

    app.mount("/", SPAStaticFiles(directory=root, html=True), name="frontend")


app = create_app()
