"""Las migraciones crean exactamente el esquema de los modelos."""

from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import create_engine, inspect

import app.db.models  # noqa: F401
from app.db.base import Base
from app.db.migrate import upgrade_database


def test_migrations_match_models(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'm.db'}")
    upgrade_database(engine)
    with engine.connect() as conn:
        diff = compare_metadata(MigrationContext.configure(conn, opts={"compare_type": True}), Base.metadata)
    assert diff == [], f"Falta una migración: {diff}"


def test_legacy_database_is_stamped(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'legacy.db'}")
    Base.metadata.create_all(engine)  # base creada antes de existir las migraciones
    upgrade_database(engine)
    assert "alembic_version" in inspect(engine).get_table_names()


def _fill(conn, table: str, **values):
    """Inserta una fila completando las columnas obligatorias con valores simples."""
    from datetime import date, datetime

    from sqlalchemy import Boolean, Date, DateTime, Integer, MetaData, Numeric, Table

    t = Table(table, MetaData(), autoload_with=conn)
    row = {}
    for c in t.columns:
        if c.name in values:
            row[c.name] = values[c.name]
        elif c.primary_key or c.nullable or c.server_default is not None:
            continue
        elif isinstance(c.type, Boolean):
            row[c.name] = False
        elif isinstance(c.type, Integer | Numeric):
            row[c.name] = 1
        elif isinstance(c.type, DateTime):
            row[c.name] = datetime(2026, 1, 1)
        elif isinstance(c.type, Date):
            row[c.name] = date(2026, 1, 1)
        elif c.name in (
            "slots",
            "moved",
            "data",
            "errors",
            "duplicates",
            "suggested_category_ids",
            "moved_registration_ids",
        ):
            row[c.name] = []
        elif c.type.__class__.__name__ == "JSON":
            row[c.name] = {}
        else:
            row[c.name] = "x"
    return conn.execute(t.insert().values(**row)).inserted_primary_key[0]


def test_upgrade_keeps_existing_data(tmp_path):
    """Una base SQLite con combates y eventos se actualiza sin perder filas
    (el modo batch recrea tablas referenciadas por claves foráneas)."""
    from alembic import command
    from sqlalchemy import text

    from app.db.base import make_engine
    from app.db.migrate import alembic_config

    engine = make_engine(f"sqlite:///{tmp_path / 'data.db'}")
    cfg = alembic_config()
    with engine.begin() as conn:
        cfg.attributes["connection"] = conn
        command.upgrade(cfg, "0001")
    with engine.begin() as conn:
        tid = _fill(conn, "tournaments")
        cid = _fill(conn, "categories", tournament_id=tid)
        bid = _fill(conn, "brackets", category_id=cid)
        vid = _fill(conn, "bracket_versions", bracket_id=bid)
        mid = _fill(conn, "matches", category_id=cid, bracket_version_id=vid, code="R1-1")
        _fill(conn, "match_events", id="e1", match_id=mid, type="start")
        _fill(conn, "judge_votes", match_id=mid)
    upgrade_database(engine)
    with engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM matches")).scalar() == 1
        assert conn.execute(text("SELECT count(*) FROM match_events")).scalar() == 1
        assert conn.execute(text("PRAGMA foreign_keys")).scalar() == 1
        assert "parent_match_id" in {c["name"] for c in inspect(conn).get_columns("matches")}


def test_portal_publico_da_direccion_a_los_torneos_ya_publicos(tmp_path):
    """0009: los torneos con el vivo activo reciben su dirección fija, única."""
    from datetime import date

    from alembic import command
    from sqlalchemy import text

    from app.db.base import make_engine
    from app.db.migrate import alembic_config

    engine = make_engine(f"sqlite:///{tmp_path / 'slug.db'}")
    cfg = alembic_config()
    with engine.begin() as conn:
        cfg.attributes["connection"] = conn
        command.upgrade(cfg, "0008_mesa_principal")
    with engine.begin() as conn:
        d = date(2026, 10, 17)
        _fill(conn, "tournaments", name="Copa Perú Ñandú", start_date=d, public_token="a" * 32)
        _fill(conn, "tournaments", name="Copa Perú Ñandú", start_date=d, public_token="b" * 32)
        _fill(conn, "tournaments", name="Privado", start_date=d)
        _fill(conn, "tatamis", tournament_id=1, number=1, name="Tatami 1")
    upgrade_database(engine)
    with engine.connect() as conn:
        rows = conn.execute(text("SELECT public_slug, timezone, match_overhead_seconds FROM tournaments ORDER BY id"))
        assert [tuple(r) for r in rows] == [
            ("copa-peru-nandu-2026", "America/Lima", 60),
            ("copa-peru-nandu-2026-2", "America/Lima", 60),
            (None, "America/Lima", 60),
        ]
        assert conn.execute(text("SELECT planned_start FROM tatamis")).scalar() is None


def test_wait_for_database_retries_until_it_answers(monkeypatch):
    """Azure SQL serverless en pausa: la primera conexión falla y la app reintenta."""
    from sqlalchemy.exc import OperationalError

    from app.db import base

    engine = create_engine("sqlite://")
    real_connect = engine.connect
    calls = {"n": 0}

    def flaky_connect():
        calls["n"] += 1
        if calls["n"] < 3:
            raise OperationalError("SELECT 1", {}, Exception("Database is not currently available"))
        return real_connect()

    monkeypatch.setattr(engine, "connect", flaky_connect)
    base.wait_for_database(engine, attempts=5, delay=0)
    assert calls["n"] == 3
