from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.errors import install_handlers
from app.api.routers import competition, core, history, tournaments
from app.config import get_settings
from app.db.base import Base, get_engine


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings = get_settings()
    if settings.environment == "prod" and (
        settings.jwt_secret == "cambiar-en-produccion" or len(settings.jwt_secret) < 32
    ):
        raise RuntimeError("HAJIME_JWT_SECRET debe configurarse (mínimo 32 caracteres) en producción")
    if settings.environment in ("dev", "test") and get_engine().url.get_backend_name() == "sqlite":
        # En DEV con SQLite se crean las tablas al iniciar. En SQL Server se
        # usa el script versionado de sql/ (ver README).
        import app.db.models  # noqa: F401

        Base.metadata.create_all(get_engine())
    yield


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

    return app


app = create_app()
