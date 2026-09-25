"""Aplica las migraciones de Alembic al arrancar (sin perder datos al actualizar)."""

from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import inspect
from sqlalchemy.engine import Engine

BASELINE = "0001"
# Base creada con create_all (sin Alembic): la revisión que corresponde según
# qué tablas ya existen. La última que coincide manda.
LEGACY_MARKERS = (("users", BASELINE), ("teams", "0002"))
# Columnas que distinguen revisiones sin tabla nueva: (tabla, columna, revisión).
LEGACY_COLUMNS = (("tournaments", "public_token", "0003"),)


def alembic_config() -> Config:
    cfg = Config()
    cfg.set_main_option("script_location", str(Path(__file__).resolve().parent.parent / "migrations"))
    return cfg


def upgrade_database(engine: Engine) -> None:
    cfg = alembic_config()
    with engine.begin() as conn:
        cfg.attributes["connection"] = conn
        tables = set(inspect(conn).get_table_names())
        if "users" in tables and "alembic_version" not in tables:
            # Base creada antes de las migraciones: se marca con la revisión
            # que ya tiene (normalmente el esquema inicial).
            rev = [r for table, r in LEGACY_MARKERS if table in tables][-1]
            for table, column, r in LEGACY_COLUMNS:
                if table in tables and column in {c["name"] for c in inspect(conn).get_columns(table)}:
                    rev = r
            command.stamp(cfg, rev)
        command.upgrade(cfg, "head")
