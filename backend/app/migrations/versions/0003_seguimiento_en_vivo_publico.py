"""seguimiento en vivo publico

Revision ID: 0003
Revises: 0002
Create Date: 2026-09-25 14:28:06.245477
"""

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("tournaments", schema=None) as batch_op:
        batch_op.add_column(sa.Column("public_token", sa.String(length=40), nullable=True))
        batch_op.add_column(sa.Column("public_names", sa.String(length=10), server_default="short", nullable=False))
        batch_op.create_index(batch_op.f("ix_tournaments_public_token"), ["public_token"], unique=False)


def downgrade() -> None:
    with op.batch_alter_table("tournaments", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_tournaments_public_token"))
        batch_op.drop_column("public_names")
        batch_op.drop_column("public_token")
