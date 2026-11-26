"""tiempo por tatami: modo de reloj del tatami y el fijado en cada combate

``tatamis.time_mode`` (lo elige la mesa: efectivo o corrido) y
``matches.time_mode`` (el modo vigente al empezar el combate, para no
reinterpretar combates ya empezados). Solo columnas nuevas y opcionales:
compatible con la versión anterior.

Revision ID: 0016_tiempo_por_tatami
Revises: 0015_avisos_push
Create Date: 2026-11-26 12:00:00
"""

import sqlalchemy as sa
from alembic import op

revision = "0016_tiempo_por_tatami"
down_revision = "0015_avisos_push"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("tatamis") as batch_op:
        batch_op.add_column(sa.Column("time_mode", sa.String(length=10), nullable=True))
    with op.batch_alter_table("matches") as batch_op:
        batch_op.add_column(sa.Column("time_mode", sa.String(length=10), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("matches") as batch_op:
        batch_op.drop_column("time_mode")
    with op.batch_alter_table("tatamis") as batch_op:
        batch_op.drop_column("time_mode")
