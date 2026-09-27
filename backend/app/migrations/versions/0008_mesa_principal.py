"""mesa principal: la tablet que lleva la mesa de un combate

Revision ID: 0008_mesa_principal
Revises: 0007_vivo_compartido
Create Date: 2026-09-26 12:00:00
"""

import sqlalchemy as sa
from alembic import op

revision = "0008_mesa_principal"
down_revision = "0007_vivo_compartido"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("match_presence", schema=None) as batch_op:
        batch_op.add_column(sa.Column("is_primary", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    with op.batch_alter_table("match_presence", schema=None) as batch_op:
        batch_op.drop_column("is_primary")
