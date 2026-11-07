"""sesiones con token de renovacion

Revision ID: 0006_sesiones
Revises: 0005_intentos_login
Create Date: 2026-09-26 16:39:11.509743
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mssql

revision = "0006_sesiones"
down_revision = "0005_intentos_login"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "user_sessions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("previous_token_hash", sa.String(length=64), nullable=True),
        sa.Column("rotated_at", sa.DateTime().with_variant(mssql.DATETIME2(), "mssql"), nullable=True),
        sa.Column("created_at", sa.DateTime().with_variant(mssql.DATETIME2(), "mssql"), nullable=False),
        sa.Column("last_used_at", sa.DateTime().with_variant(mssql.DATETIME2(), "mssql"), nullable=False),
        sa.Column("expires_at", sa.DateTime().with_variant(mssql.DATETIME2(), "mssql"), nullable=False),
        sa.Column("revoked_at", sa.DateTime().with_variant(mssql.DATETIME2(), "mssql"), nullable=True),
        sa.Column("user_agent", sa.Unicode(length=255), nullable=False),
        sa.Column("ip", sa.String(length=45), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("token_hash"),
    )
    with op.batch_alter_table("user_sessions", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_user_sessions_previous_token_hash"), ["previous_token_hash"], unique=False)
        batch_op.create_index(batch_op.f("ix_user_sessions_user_id"), ["user_id"], unique=False)


def downgrade() -> None:
    with op.batch_alter_table("user_sessions", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_user_sessions_user_id"))
        batch_op.drop_index(batch_op.f("ix_user_sessions_previous_token_hash"))

    op.drop_table("user_sessions")
