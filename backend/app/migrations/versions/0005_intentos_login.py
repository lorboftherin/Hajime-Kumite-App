"""intentos de inicio de sesion compartidos entre procesos

Revision ID: 0005_intentos_login
Revises: 0004
Create Date: 2026-09-26 10:00:00
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mssql

revision = "0005_intentos_login"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "login_attempts",
        sa.Column("key", sa.String(length=160), nullable=False),
        sa.Column("failures", sa.Integer(), nullable=False),
        sa.Column("window_start", sa.DateTime().with_variant(mssql.DATETIME2(), "mssql"), nullable=False),
        sa.Column("locked_until", sa.DateTime().with_variant(mssql.DATETIME2(), "mssql"), nullable=True),
        sa.PrimaryKeyConstraint("key"),
    )


def downgrade() -> None:
    op.drop_table("login_attempts")
