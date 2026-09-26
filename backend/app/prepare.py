"""Prepara la base antes de atender: espera a que responda, migra y crea lo inicial.

    python -m app.prepare

Lo ejecuta el entrypoint del contenedor UNA vez, antes de levantar los procesos
de uvicorn. Antes lo hacía cada proceso al arrancar: con `--workers 2` sobre una
base vacía los dos creaban las tablas a la vez y uno moría con «table users
already exists».

Aun así se toma un candado entre procesos, porque también pueden chocar varias
copias del contenedor que arrancan juntas (Azure escala de 0 a 3) o alguien que
active HAJIME_MIGRATE_ON_STARTUP con varios procesos:

- SQL Server: `sp_getapplock`, un candado con nombre que vive en la propia base.
- SQLite: un archivo `<base>.lock` con `fcntl.flock` junto al archivo de la base.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError

log = logging.getLogger("hajime.prepare")

LOCK_NAME = "hajime_preparar_base"
LOCK_TIMEOUT_SECONDS = 300


@contextmanager
def preparation_lock(engine: Engine) -> Iterator[None]:
    backend = engine.url.get_backend_name()
    if backend == "mssql":
        with _mssql_lock(engine):
            yield
    elif backend == "sqlite" and engine.url.database not in (None, "", ":memory:"):
        with _file_lock(Path(engine.url.database).with_name(Path(engine.url.database).name + ".lock")):
            yield
    else:
        yield  # base en memoria: un solo proceso por definición


@contextmanager
def _mssql_lock(engine: Engine) -> Iterator[None]:
    conn = engine.connect()
    try:
        # Candado de sesión: dura mientras esta conexión lo tenga, aunque las
        # migraciones usen otra. Devuelve >= 0 si se obtuvo.
        result = conn.exec_driver_sql(
            "SET NOCOUNT ON; DECLARE @r int; "
            f"EXEC @r = sp_getapplock @Resource = N'{LOCK_NAME}', @LockMode = 'Exclusive', "
            f"@LockOwner = 'Session', @LockTimeout = {LOCK_TIMEOUT_SECONDS * 1000}; SELECT @r"
        ).scalar()
        if result is None or result < 0:
            raise RuntimeError(f"No se obtuvo el candado de preparación de la base (sp_getapplock = {result})")
        try:
            yield
        finally:
            try:
                conn.exec_driver_sql(f"EXEC sp_releaseapplock @Resource = N'{LOCK_NAME}', @LockOwner = 'Session'")
                conn.commit()
            except Exception:  # noqa: BLE001
                # Si no se pudo soltar, la conexión no vuelve al pool: al cerrarla
                # de verdad SQL Server libera el candado.
                conn.invalidate()
    finally:
        conn.close()


@contextmanager
def _file_lock(path: Path) -> Iterator[None]:
    try:
        import fcntl
    except ImportError:  # Windows: allí se usa un solo proceso de desarrollo
        yield
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a+") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def prepare_database(settings, engine: Engine) -> None:
    """Espera la base, aplica migraciones (si corresponde) y crea el admin y la plantilla."""
    from app.db.base import wait_for_database

    sqlite = engine.url.get_backend_name() == "sqlite"
    if not sqlite:
        wait_for_database(engine)  # Azure SQL serverless puede estar en pausa
    with preparation_lock(engine):
        if sqlite or settings.auto_create_schema:
            # SQLite (desarrollo, pruebas, instalación local): siempre. SQL Server:
            # solo con HAJIME_AUTO_CREATE_SCHEMA; si no, con `alembic upgrade head`.
            from app.db.migrate import upgrade_database

            upgrade_database(engine)
        bootstrap(settings)


def bootstrap(settings) -> None:
    """Primer arranque: crea el admin y la plantilla base si no existen.

    Idempotente: si otro proceso crea el admin al mismo tiempo, el choque de
    nombre único se ignora.
    """
    from app.db.base import get_session
    from app.db.models import CategoryTemplate, User
    from app.security import hash_password

    gen = get_session()
    db = next(gen)
    try:
        if settings.admin_password and not db.scalar(select(func.count()).select_from(User)):
            name = settings.admin_username.lower()
            db.add(
                User(
                    username=name,
                    password_hash=hash_password(settings.admin_password),
                    is_admin=True,
                    display_name=settings.admin_username,
                )
            )
            try:
                db.commit()
                log.info("Admin %s creado", name)
            except IntegrityError:
                db.rollback()
                log.info("El admin %s ya lo creó otro proceso", name)
        from app.services.entitlements import ensure_plans

        ensure_plans(db)  # planes nuevos del catálogo (no toca precios existentes)
        if settings.load_base_template and db.scalar(select(func.count()).select_from(User)):
            if not db.scalar(select(func.count()).select_from(CategoryTemplate)):
                from app.seed import cmd_template

                cmd_template()
    finally:
        gen.close()


def main() -> None:
    from app.config import get_settings
    from app.db.base import get_engine
    from app.observability import configure_logging

    settings = get_settings()
    configure_logging(settings.log_level, settings.log_format)
    engine = get_engine()
    log.info("Preparando la base (%s)", engine.url.get_backend_name())
    prepare_database(settings, engine)
    engine.dispose()  # los procesos de uvicorn abren sus propias conexiones
    log.info("Base lista")


if __name__ == "__main__":
    main()
