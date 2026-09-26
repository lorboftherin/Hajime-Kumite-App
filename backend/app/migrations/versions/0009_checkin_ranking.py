"""acreditación y pesaje, plantillas archivadas, diplomas y ranking por temporada

Revision ID: 0009_checkin_ranking
Revises: 0008_mesa_principal
Create Date: 2026-09-26 17:18:50.455762
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mssql

revision = "0009_checkin_ranking"
down_revision = "0008_mesa_principal"
branch_labels = None
depends_on = None

FK_CHECKED_IN_BY = "fk_registrations_checked_in_by_id_users"


def upgrade() -> None:
    op.create_table(
        "ranking_seasons",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.Unicode(length=200), nullable=False),
        sa.Column("slug", sa.String(length=80), nullable=False),
        sa.Column("year", sa.Integer(), nullable=False),
        sa.Column("date_from", sa.Date(), nullable=True),
        sa.Column("date_to", sa.Date(), nullable=True),
        sa.Column("tournament_ids", sa.JSON(), nullable=False),
        sa.Column("points", sa.JSON(), nullable=False),
        sa.Column("multipliers", sa.JSON(), nullable=False),
        sa.Column("min_entrants_walkover_gold", sa.Integer(), nullable=False),
        sa.Column("is_public", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("computed_at", sa.DateTime().with_variant(mssql.DATETIME2(), "mssql"), nullable=True),
        sa.Column("source_fingerprint", sa.String(length=120), nullable=True),
        sa.Column("created_at", sa.DateTime().with_variant(mssql.DATETIME2(), "mssql"), nullable=False),
        sa.Column("updated_at", sa.DateTime().with_variant(mssql.DATETIME2(), "mssql"), nullable=False),
        sa.Column("updated_by_id", sa.Integer(), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(
            ["updated_by_id"],
            ["users.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("slug"),
    )
    op.create_table(
        "ranking_entries",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("season_id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=10), nullable=False),
        sa.Column("group_key", sa.String(length=200), nullable=False),
        sa.Column("group_label", sa.Unicode(length=200), nullable=False),
        sa.Column("modality", sa.String(length=10), nullable=False),
        sa.Column("person_id", sa.Integer(), nullable=True),
        sa.Column("dojo_id", sa.Integer(), nullable=True),
        sa.Column("points", sa.Numeric(precision=9, scale=2), nullable=False),
        sa.Column("rank", sa.Integer(), nullable=False),
        sa.Column("golds", sa.Integer(), nullable=False),
        sa.Column("silvers", sa.Integer(), nullable=False),
        sa.Column("bronzes", sa.Integer(), nullable=False),
        sa.Column("participations", sa.Integer(), nullable=False),
        sa.Column("tournaments", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(
            ["dojo_id"],
            ["dojos.id"],
        ),
        sa.ForeignKeyConstraint(
            ["person_id"],
            ["persons.id"],
        ),
        sa.ForeignKeyConstraint(
            ["season_id"],
            ["ranking_seasons.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("ranking_entries", schema=None) as batch_op:
        batch_op.create_index("ix_ranking_entries_person", ["person_id"], unique=False)
        batch_op.create_index("ix_ranking_entries_season", ["season_id", "kind", "group_key"], unique=False)

    with op.batch_alter_table("category_templates", schema=None) as batch_op:
        batch_op.add_column(sa.Column("is_archived", sa.Boolean(), server_default=sa.false(), nullable=False))

    with op.batch_alter_table("registrations", schema=None) as batch_op:
        batch_op.add_column(sa.Column("checkin_status", sa.String(length=10), server_default="pending", nullable=False))
        batch_op.add_column(
            sa.Column("checked_in_at", sa.DateTime().with_variant(mssql.DATETIME2(), "mssql"), nullable=True)
        )
        batch_op.add_column(sa.Column("checked_in_by_id", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("weight_kg", sa.Numeric(precision=5, scale=2), nullable=True))
        batch_op.add_column(
            sa.Column("weighed_at", sa.DateTime().with_variant(mssql.DATETIME2(), "mssql"), nullable=True)
        )
        batch_op.add_column(sa.Column("weigh_in_result", sa.String(length=10), nullable=True))
        batch_op.add_column(sa.Column("credential_code", sa.String(length=12), nullable=True))
        batch_op.create_index(
            "uq_registrations_credential_code",
            ["credential_code"],
            unique=True,
            mssql_where=sa.text("credential_code IS NOT NULL"),
            sqlite_where=sa.text("credential_code IS NOT NULL"),
        )
        batch_op.create_foreign_key(FK_CHECKED_IN_BY, "users", ["checked_in_by_id"], ["id"])

    with op.batch_alter_table("tournaments", schema=None) as batch_op:
        batch_op.add_column(sa.Column("checkin_required", sa.Boolean(), server_default=sa.false(), nullable=False))
        batch_op.add_column(
            sa.Column("weigh_in_tolerance_kg", sa.Numeric(precision=4, scale=2), server_default="0", nullable=False)
        )
        batch_op.add_column(
            sa.Column("certificate_organizer", sa.Unicode(length=200), server_default="", nullable=False)
        )
        batch_op.add_column(
            sa.Column("certificate_signer_name", sa.Unicode(length=200), server_default="", nullable=False)
        )
        batch_op.add_column(
            sa.Column("certificate_signer_title", sa.Unicode(length=200), server_default="", nullable=False)
        )


def downgrade() -> None:
    with op.batch_alter_table("tournaments", schema=None) as batch_op:
        batch_op.drop_column("certificate_signer_title")
        batch_op.drop_column("certificate_signer_name")
        batch_op.drop_column("certificate_organizer")
        batch_op.drop_column("weigh_in_tolerance_kg")
        batch_op.drop_column("checkin_required")

    with op.batch_alter_table("registrations", schema=None) as batch_op:
        batch_op.drop_constraint(FK_CHECKED_IN_BY, type_="foreignkey")
        batch_op.drop_index(
            "uq_registrations_credential_code",
            mssql_where=sa.text("credential_code IS NOT NULL"),
            sqlite_where=sa.text("credential_code IS NOT NULL"),
        )
        batch_op.drop_column("credential_code")
        batch_op.drop_column("weigh_in_result")
        batch_op.drop_column("weighed_at")
        batch_op.drop_column("weight_kg")
        batch_op.drop_column("checked_in_by_id")
        batch_op.drop_column("checked_in_at")
        batch_op.drop_column("checkin_status")

    with op.batch_alter_table("category_templates", schema=None) as batch_op:
        batch_op.drop_column("is_archived")

    with op.batch_alter_table("ranking_entries", schema=None) as batch_op:
        batch_op.drop_index("ix_ranking_entries_season")
        batch_op.drop_index("ix_ranking_entries_person")

    op.drop_table("ranking_entries")
    op.drop_table("ranking_seasons")
