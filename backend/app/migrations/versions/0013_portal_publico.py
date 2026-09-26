"""portal publico: direccion fija, horarios estimados

``tournaments.public_slug`` (dirección fija /t/<slug>, única entre las
asignadas), ``tournaments.timezone`` y ``tournaments.match_overhead_seconds``
(horarios estimados) y ``tatamis.planned_start`` (hora planificada de inicio,
en la hora local del torneo). Todo con valor por defecto o nulo: compatible
con la versión anterior. Los torneos que ya tenían el vivo activo reciben su
dirección fija aquí mismo.

Revision ID: 0013_portal_publico
Revises: 0012_checkin_ranking
Create Date: 2026-09-26 17:22:20
"""

import re
import unicodedata

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mssql

revision = "0013_portal_publico"
down_revision = "0012_checkin_ranking"
branch_labels = None
depends_on = None


def _slug(name: str, year: int) -> str:
    """Igual que ``app.services.public.slugify`` (copiado: la migración no depende del código vivo)."""
    base = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode().lower()
    base = re.sub(r"[^a-z0-9]+", "-", base).strip("-")[:60].strip("-") or "torneo"
    return base if str(year) in base.split("-") else f"{base}-{year}"


def upgrade() -> None:
    with op.batch_alter_table("tatamis", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column("planned_start", sa.DateTime().with_variant(mssql.DATETIME2(), "mssql"), nullable=True)
        )

    with op.batch_alter_table("tournaments", schema=None) as batch_op:
        batch_op.add_column(sa.Column("public_slug", sa.String(length=80), nullable=True))
        batch_op.add_column(sa.Column("timezone", sa.String(length=40), server_default="America/Lima", nullable=False))
        batch_op.add_column(sa.Column("match_overhead_seconds", sa.Integer(), server_default="60", nullable=False))
        batch_op.create_index(
            "uq_tournaments_public_slug",
            ["public_slug"],
            unique=True,
            mssql_where=sa.text("public_slug IS NOT NULL"),
            sqlite_where=sa.text("public_slug IS NOT NULL"),
        )

    conn = op.get_bind()
    rows = conn.execute(
        sa.text("SELECT id, name, start_date FROM tournaments WHERE public_token IS NOT NULL ORDER BY id")
    ).all()
    used: set[str] = set()
    for tid, name, start in rows:
        year = start.year if hasattr(start, "year") else int(str(start)[:4])
        base = _slug(name, year)
        slug, n = base, 2
        while slug in used:
            slug, n = f"{base}-{n}", n + 1
        used.add(slug)
        conn.execute(sa.text("UPDATE tournaments SET public_slug = :s WHERE id = :id"), {"s": slug, "id": tid})


def downgrade() -> None:
    with op.batch_alter_table("tournaments", schema=None) as batch_op:
        batch_op.drop_index(
            "uq_tournaments_public_slug",
            mssql_where=sa.text("public_slug IS NOT NULL"),
            sqlite_where=sa.text("public_slug IS NOT NULL"),
        )
        batch_op.drop_column("match_overhead_seconds")
        batch_op.drop_column("timezone")
        batch_op.drop_column("public_slug")

    with op.batch_alter_table("tatamis", schema=None) as batch_op:
        batch_op.drop_column("planned_start")
