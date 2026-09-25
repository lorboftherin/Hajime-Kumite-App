"""presencia en mesa y arbitros

Revision ID: 0004
Revises: 0003
Create Date: 2026-09-25 14:50:20.163232
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mssql

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "referee_assignments",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("tournament_id", sa.Integer(), nullable=False),
        sa.Column("person_id", sa.Integer(), nullable=False),
        sa.Column("target_type", sa.String(length=20), nullable=False),
        sa.Column("target_id", sa.Integer(), nullable=False),
        sa.Column("position", sa.Unicode(length=40), nullable=False),
        sa.Column("created_at", sa.DateTime().with_variant(mssql.DATETIME2(), "mssql"), nullable=False),
        sa.Column("created_by_id", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(
            ["created_by_id"],
            ["users.id"],
        ),
        sa.ForeignKeyConstraint(
            ["person_id"],
            ["persons.id"],
        ),
        sa.ForeignKeyConstraint(
            ["tournament_id"],
            ["tournaments.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("referee_assignments", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_referee_assignments_person_id"), ["person_id"], unique=False)
        batch_op.create_index(
            "ix_referee_assignments_target", ["tournament_id", "target_type", "target_id"], unique=False
        )

    op.create_table(
        "match_presence",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("match_id", sa.Integer(), nullable=False),
        sa.Column("device_id", sa.String(length=40), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=True),
        sa.Column("first_seen", sa.DateTime().with_variant(mssql.DATETIME2(), "mssql"), nullable=False),
        sa.Column("last_seen", sa.DateTime().with_variant(mssql.DATETIME2(), "mssql"), nullable=False),
        sa.ForeignKeyConstraint(
            ["match_id"],
            ["matches.id"],
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("match_id", "device_id"),
    )
    with op.batch_alter_table("match_presence", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_match_presence_last_seen"), ["last_seen"], unique=False)
        batch_op.create_index(batch_op.f("ix_match_presence_match_id"), ["match_id"], unique=False)


def downgrade() -> None:
    with op.batch_alter_table("match_presence", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_match_presence_match_id"))
        batch_op.drop_index(batch_op.f("ix_match_presence_last_seen"))

    op.drop_table("match_presence")
    with op.batch_alter_table("referee_assignments", schema=None) as batch_op:
        batch_op.drop_index("ix_referee_assignments_target")
        batch_op.drop_index(batch_op.f("ix_referee_assignments_person_id"))

    op.drop_table("referee_assignments")
