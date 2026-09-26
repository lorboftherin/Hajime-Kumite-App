from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime

from sqlalchemy import DateTime, ForeignKey, Integer, create_engine, event
from sqlalchemy.dialects.mssql import DATETIME2
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

from app.config import get_settings


def utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)  # UTC naive: igual en SQL Server y SQLite


# Fechas en UTC; en SQL Server, DATETIME2 (mayor rango y precisión que DATETIME).
UtcDateTime = DateTime().with_variant(DATETIME2(), "mssql")


class Base(DeclarativeBase):
    pass


class Timestamped:
    """Toda entidad lleva fechas de creación/modificación y usuario que modificó."""

    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow, onupdate=utcnow)
    updated_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)


class Versioned:
    """Entidades editables: control de concurrencia optimista."""

    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)


def make_engine(url: str) -> Engine:
    kwargs: dict = {"future": True}
    if url.startswith("sqlite"):
        kwargs["connect_args"] = {"check_same_thread": False}
        if url in ("sqlite://", "sqlite:///:memory:"):
            from sqlalchemy.pool import StaticPool

            kwargs["poolclass"] = StaticPool
        else:
            # Varias mesas y muchos espectadores a la vez: más conexiones que
            # hilos atendiendo peticiones, para que nadie espere una libre.
            kwargs.update(pool_size=20, max_overflow=40)
    else:
        # Pool por proceso, pequeño y configurable (ver db_pool_size en config.py).
        # pool_pre_ping descarta las conexiones que Azure SQL cerró al pausarse.
        s = get_settings()
        kwargs.update(
            pool_pre_ping=True,
            pool_size=s.db_pool_size,
            max_overflow=s.db_max_overflow,
            pool_timeout=s.db_pool_timeout,
            pool_recycle=1800,
        )
    engine = create_engine(url, **kwargs)
    if url.startswith("sqlite"):
        file_db = url not in ("sqlite://", "sqlite:///:memory:")

        @event.listens_for(engine, "connect")
        def _fk_on(dbapi_conn, _):  # pragma: no cover - trivial
            dbapi_conn.execute("PRAGMA foreign_keys=ON")
            if file_db:
                # Varias mesas a la vez (MVP-3): WAL deja leer mientras otra
                # mesa escribe, y la espera evita «database is locked».
                dbapi_conn.execute("PRAGMA journal_mode=WAL")
                dbapi_conn.execute("PRAGMA synchronous=NORMAL")
                dbapi_conn.execute("PRAGMA busy_timeout=15000")

    return engine


def wait_for_database(engine: Engine, attempts: int = 12, delay: float = 10.0) -> None:
    """Espera a que la base responda antes de arrancar.

    Azure SQL serverless se pausa sola cuando nadie la usa y tarda cerca de un
    minuto en despertar: la primera conexión falla mientras tanto. En lugar de
    caerse, la app reintenta durante unos dos minutos.
    """
    import logging
    import time

    from sqlalchemy.exc import DBAPIError

    log = logging.getLogger("hajime.db")
    for i in range(1, attempts + 1):
        try:
            with engine.connect() as conn:
                conn.exec_driver_sql("SELECT 1")
            return
        except DBAPIError as e:
            if i == attempts:
                raise
            log.warning("La base de datos aún no responde (intento %s de %s): %s", i, attempts, str(e)[:200])
            time.sleep(delay)


_engine: Engine | None = None
_SessionLocal: sessionmaker[Session] | None = None


def init_engine(url: str | None = None) -> Engine:
    global _engine, _SessionLocal
    _engine = make_engine(url or get_settings().database_url)
    _SessionLocal = sessionmaker(bind=_engine, autoflush=False, expire_on_commit=False)
    return _engine


def get_engine() -> Engine:
    return _engine or init_engine()


def get_session() -> Iterator[Session]:
    if _SessionLocal is None:
        init_engine()
    assert _SessionLocal is not None
    db = _SessionLocal()
    try:
        yield db
    finally:
        db.close()
