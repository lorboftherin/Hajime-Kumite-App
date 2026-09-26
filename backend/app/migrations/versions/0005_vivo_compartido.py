"""instantanea compartida del vivo e indices

Tabla ``public_snapshots`` (respuesta del vivo público compartida entre
procesos y copias) e índices para las lecturas calientes: cola del tatami,
vivo, estadísticas y permisos. El token público pasa a ser único (solo entre
los que no son NULL, para SQL Server).

Revision ID: 0005_vivo_compartido
Revises: 0004
Create Date: 2026-09-26 16:40:47.314142
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mssql

revision = "0005_vivo_compartido"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "public_snapshots",
        sa.Column("tournament_id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=40), nullable=False),
        sa.Column("payload", sa.UnicodeText(), nullable=True),
        sa.Column("etag", sa.String(length=40), nullable=True),
        sa.Column("computed_at", sa.DateTime().with_variant(mssql.DATETIME2(), "mssql"), nullable=True),
        sa.Column("dirty", sa.Boolean(), server_default=sa.text("0"), nullable=False),
        sa.Column("lease_until", sa.DateTime().with_variant(mssql.DATETIME2(), "mssql"), nullable=True),
        sa.ForeignKeyConstraint(
            ["tournament_id"],
            ["tournaments.id"],
        ),
        sa.PrimaryKeyConstraint("tournament_id", "kind"),
    )
    with op.batch_alter_table("categories", schema=None) as batch_op:
        batch_op.create_index("ix_categories_tatami", ["tatami_id", "status", "queue_position"], unique=False)

    with op.batch_alter_table("category_results", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_category_results_registration_id"), ["registration_id"], unique=False)

    with op.batch_alter_table("kata_performances", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_kata_performances_registration_id"), ["registration_id"], unique=False)

    with op.batch_alter_table("matches", schema=None) as batch_op:
        batch_op.create_index("ix_matches_aka_registration", ["aka_registration_id"], unique=False)
        batch_op.create_index("ix_matches_ao_registration", ["ao_registration_id"], unique=False)
        batch_op.create_index("ix_matches_category_current", ["category_id", "is_current"], unique=False)

    with op.batch_alter_table("person_roles", schema=None) as batch_op:
        batch_op.create_index("ix_person_roles_scope", ["role", "scope_type", "scope_id"], unique=False)

    with op.batch_alter_table("registrations", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_registrations_dojo_id"), ["dojo_id"], unique=False)

    with op.batch_alter_table("rule_overrides", schema=None) as batch_op:
        batch_op.create_index("ix_rule_overrides_entity", ["entity", "entity_id"], unique=False)

    with op.batch_alter_table("tournaments", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_tournaments_public_token"))
        batch_op.create_index(
            "uq_tournaments_public_token",
            ["public_token"],
            unique=True,
            mssql_where=sa.text("public_token IS NOT NULL"),
            sqlite_where=sa.text("public_token IS NOT NULL"),
        )


def downgrade() -> None:
    with op.batch_alter_table("tournaments", schema=None) as batch_op:
        batch_op.drop_index(
            "uq_tournaments_public_token",
            mssql_where=sa.text("public_token IS NOT NULL"),
            sqlite_where=sa.text("public_token IS NOT NULL"),
        )
        batch_op.create_index(batch_op.f("ix_tournaments_public_token"), ["public_token"], unique=False)

    with op.batch_alter_table("rule_overrides", schema=None) as batch_op:
        batch_op.drop_index("ix_rule_overrides_entity")

    with op.batch_alter_table("registrations", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_registrations_dojo_id"))

    with op.batch_alter_table("person_roles", schema=None) as batch_op:
        batch_op.drop_index("ix_person_roles_scope")

    with op.batch_alter_table("matches", schema=None) as batch_op:
        batch_op.drop_index("ix_matches_category_current")
        batch_op.drop_index("ix_matches_ao_registration")
        batch_op.drop_index("ix_matches_aka_registration")

    with op.batch_alter_table("kata_performances", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_kata_performances_registration_id"))

    with op.batch_alter_table("category_results", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_category_results_registration_id"))

    with op.batch_alter_table("categories", schema=None) as batch_op:
        batch_op.drop_index("ix_categories_tatami")

    op.drop_table("public_snapshots")
