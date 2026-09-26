"""reglas deportivas configurables

Rango de peso numérico, cupo y overrides por categoría; modo de edad y reglas
de competencia del torneo; divisiones de categoría; tipo de falta y escalera
en las sanciones; notas atléticas y grupos en kata.

Las categorías y plantillas existentes reciben su rango de peso a partir de
la etiqueta ("-45" = hasta 45 kg, "+84" = más de 84 kg, "45-50").

Revision ID: 0005_reglas_deportivas
Revises: 0004
Create Date: 2026-09-26 16:44:39.562930
"""

import re
from decimal import Decimal

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mssql

revision = "0005_reglas_deportivas"
down_revision = "0004"
branch_labels = None
depends_on = None

_NUM = r"(\d+(?:[.,]\d+)?)"


def _weight_range(label):
    """Copia de app.domain.categories.parse_weight_range (una migración no
    debe depender del código que cambia después)."""
    if not label:
        return None, None
    txt = re.sub(r"\s*kg\s*$", "", str(label).strip().lower())

    def num(x):
        return Decimal(x.replace(",", "."))

    if m := re.match(rf"^-\s*{_NUM}$", txt):
        return None, num(m.group(1))
    if m := re.match(rf"^\+\s*{_NUM}$", txt):
        return num(m.group(1)), None
    if m := re.match(rf"^{_NUM}\s*-\s*{_NUM}$", txt):
        lo, hi = num(m.group(1)), num(m.group(2))
        return (lo, hi) if lo <= hi else (hi, lo)
    return None, None


def _category_columns(batch_op) -> None:
    batch_op.add_column(sa.Column("max_entrants", sa.Integer(), nullable=True))
    batch_op.add_column(sa.Column("weight_min_kg", sa.Numeric(precision=5, scale=1), nullable=True))
    batch_op.add_column(sa.Column("weight_max_kg", sa.Numeric(precision=5, scale=1), nullable=True))
    batch_op.add_column(sa.Column("kata_rules", sa.JSON(), nullable=True))
    batch_op.add_column(sa.Column("competition_rules", sa.JSON(), nullable=True))


def _fill_weight_ranges(table: str) -> None:
    conn = op.get_bind()
    t = sa.table(
        table,
        sa.column("id", sa.Integer()),
        sa.column("weight_class", sa.String()),
        sa.column("weight_min_kg", sa.Numeric(5, 1)),
        sa.column("weight_max_kg", sa.Numeric(5, 1)),
    )
    rows = conn.execute(sa.select(t.c.id, t.c.weight_class).where(t.c.weight_class.is_not(None))).all()
    for rid, label in rows:
        lo, hi = _weight_range(label)
        if lo is None and hi is None:
            continue
        conn.execute(t.update().where(t.c.id == rid).values(weight_min_kg=lo, weight_max_kg=hi))


def upgrade() -> None:
    op.create_table(
        "category_splits",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("source_category_id", sa.Integer(), nullable=False),
        sa.Column("new_category_id", sa.Integer(), nullable=False),
        sa.Column("criterion", sa.String(length=20), nullable=False),
        sa.Column("moved_registration_ids", sa.JSON(), nullable=False),
        sa.Column("before", sa.JSON(), nullable=False),
        sa.Column("reason", sa.Unicode(length=500), nullable=False),
        sa.Column("created_at", sa.DateTime().with_variant(mssql.DATETIME2(), "mssql"), nullable=False),
        sa.Column("created_by_id", sa.Integer(), nullable=True),
        sa.Column("undone_at", sa.DateTime().with_variant(mssql.DATETIME2(), "mssql"), nullable=True),
        sa.ForeignKeyConstraint(
            ["created_by_id"],
            ["users.id"],
        ),
        sa.ForeignKeyConstraint(
            ["new_category_id"],
            ["categories.id"],
        ),
        sa.ForeignKeyConstraint(
            ["source_category_id"],
            ["categories.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("categories", schema=None) as batch_op:
        _category_columns(batch_op)
    with op.batch_alter_table("template_categories", schema=None) as batch_op:
        _category_columns(batch_op)

    with op.batch_alter_table("kata_performances", schema=None) as batch_op:
        batch_op.add_column(sa.Column("athletic_scores", sa.JSON(), nullable=True))
        batch_op.add_column(sa.Column("group_number", sa.Integer(), nullable=True))
        batch_op.alter_column(
            "total",
            existing_type=sa.NUMERIC(precision=6, scale=1),
            type_=sa.Numeric(precision=7, scale=2),
            existing_nullable=True,
        )

    with op.batch_alter_table("match_events", schema=None) as batch_op:
        batch_op.add_column(sa.Column("infraction", sa.String(length=30), nullable=True))
        batch_op.add_column(sa.Column("ladder", sa.String(length=2), nullable=True))

    with op.batch_alter_table("tournaments", schema=None) as batch_op:
        batch_op.add_column(sa.Column("competition_rules", sa.JSON(), nullable=True))
        batch_op.add_column(sa.Column("age_mode", sa.String(length=10), server_default="date", nullable=False))

    _fill_weight_ranges("categories")
    _fill_weight_ranges("template_categories")


def downgrade() -> None:
    with op.batch_alter_table("tournaments", schema=None) as batch_op:
        batch_op.drop_column("age_mode")
        batch_op.drop_column("competition_rules")

    for table in ("template_categories", "categories"):
        with op.batch_alter_table(table, schema=None) as batch_op:
            batch_op.drop_column("competition_rules")
            batch_op.drop_column("kata_rules")
            batch_op.drop_column("weight_max_kg")
            batch_op.drop_column("weight_min_kg")
            batch_op.drop_column("max_entrants")

    with op.batch_alter_table("match_events", schema=None) as batch_op:
        batch_op.drop_column("ladder")
        batch_op.drop_column("infraction")

    with op.batch_alter_table("kata_performances", schema=None) as batch_op:
        batch_op.alter_column(
            "total",
            existing_type=sa.Numeric(precision=7, scale=2),
            type_=sa.NUMERIC(precision=6, scale=1),
            existing_nullable=True,
        )
        batch_op.drop_column("group_number")
        batch_op.drop_column("athletic_scores")

    op.drop_table("category_splits")
