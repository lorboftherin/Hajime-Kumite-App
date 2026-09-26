"""organizaciones, planes, suscripciones y autoinscripcion por dojo

Tablas ``organizations`` y ``organization_members`` (multi-organizador),
``plans`` (sembrada con los niveles del modelo de negocio) y
``subscriptions``; invitaciones de autoinscripción y pedidos de admin de dojo.

Compatible hacia atrás: se crea la «Organización principal» y se le asignan
todos los torneos existentes antes de volver obligatoria la columna
``tournaments.organization_id``. Las demás columnas nuevas son opcionales o
tienen valor por defecto.

Revision ID: 0009_organizaciones
Revises: 0008_mesa_principal
Create Date: 2026-09-26 18:00:00
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mssql

revision = "0009_organizaciones"
down_revision = "0008_mesa_principal"
branch_labels = None
depends_on = None

UtcDateTime = sa.DateTime().with_variant(mssql.DATETIME2(), "mssql")

# Foto de los planes al crear la tabla (el catálogo vigente vive en
# app/services/entitlements.py; al arrancar se agregan los que falten).
ORG_FEATURES = [
    "organize_tournaments",
    "multi_tatami",
    "live_overlay",
    "shadow_mode",
    "excel_import",
    "dojo_self_registration",
    "certificates",
]
ALL_FEATURES = [*ORG_FEATURES, "plus_insights"]
PLANS = [
    ("marcha_blanca", "Marcha blanca", "all", None, None, ALL_FEATURES, 0),
    ("publico", "Público", "all", 0, 0, [], 1),
    ("competidor", "Competidor", "person", 0, 0, [], 2),
    ("competidor_plus", "Competidor Plus", "person", 9.90, 49.00, ["plus_insights", "certificates"], 3),
    ("dojo", "Dojo", "organization", 69.00, 690.00, ORG_FEATURES, 4),
    ("organizador", "Organizador", "organization", 149.00, 1490.00, ORG_FEATURES, 5),
]


def upgrade() -> None:
    organizations = op.create_table(
        "organizations",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.Unicode(length=200), nullable=False),
        sa.Column("slug", sa.String(length=80), nullable=False),
        sa.Column("kind", sa.String(length=20), nullable=False),
        sa.Column("country", sa.String(length=2), server_default="PE", nullable=False),
        sa.Column("timezone", sa.String(length=60), server_default="America/Lima", nullable=False),
        sa.Column("currency", sa.String(length=3), server_default="PEN", nullable=False),
        sa.Column("logo", sa.Unicode(length=500), nullable=True),
        sa.Column("created_at", UtcDateTime, nullable=False),
        sa.Column("updated_at", UtcDateTime, nullable=False),
        sa.Column("updated_by_id", sa.Integer(), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["updated_by_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("slug"),
    )
    op.create_table(
        "organization_members",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("organization_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("role", sa.String(length=20), nullable=False),
        sa.Column("created_at", UtcDateTime, nullable=False),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("organization_id", "user_id", name="uq_organization_member"),
    )
    with op.batch_alter_table("organization_members", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_organization_members_user_id"), ["user_id"], unique=False)

    plans = op.create_table(
        "plans",
        sa.Column("code", sa.String(length=40), nullable=False),
        sa.Column("name", sa.Unicode(length=120), nullable=False),
        sa.Column("audience", sa.String(length=20), nullable=False),
        sa.Column("price_pen_month", sa.Numeric(precision=10, scale=2), nullable=True),
        sa.Column("price_pen_year", sa.Numeric(precision=10, scale=2), nullable=True),
        sa.Column("features", sa.JSON(), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint("code"),
    )
    op.bulk_insert(
        plans,
        [
            {
                "code": code,
                "name": name,
                "audience": audience,
                "price_pen_month": month,
                "price_pen_year": year,
                "features": features,
                "sort_order": order,
            }
            for code, name, audience, month, year, features, order in PLANS
        ],
    )

    op.create_table(
        "subscriptions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("organization_id", sa.Integer(), nullable=True),
        sa.Column("person_id", sa.Integer(), nullable=True),
        sa.Column("user_id", sa.Integer(), nullable=True),
        sa.Column("plan_code", sa.String(length=40), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("current_period_end", UtcDateTime, nullable=True),
        sa.Column("source", sa.String(length=20), nullable=False),
        sa.Column("reference", sa.String(length=120), nullable=True),
        sa.Column("notes", sa.Unicode(length=500), nullable=False),
        sa.Column("created_at", UtcDateTime, nullable=False),
        sa.Column("created_by_id", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["created_by_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"]),
        sa.ForeignKeyConstraint(["person_id"], ["persons.id"]),
        sa.ForeignKeyConstraint(["plan_code"], ["plans.code"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("subscriptions", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_subscriptions_organization_id"), ["organization_id"], unique=False)
        batch_op.create_index(batch_op.f("ix_subscriptions_person_id"), ["person_id"], unique=False)
        batch_op.create_index(batch_op.f("ix_subscriptions_user_id"), ["user_id"], unique=False)

    op.create_table(
        "tournament_invitations",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("tournament_id", sa.Integer(), nullable=False),
        sa.Column("dojo_id", sa.Integer(), nullable=True),
        sa.Column("token", sa.String(length=64), nullable=False),
        sa.Column("created_at", UtcDateTime, nullable=False),
        sa.Column("created_by_id", sa.Integer(), nullable=True),
        sa.Column("revoked_at", UtcDateTime, nullable=True),
        sa.Column("uses", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["created_by_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["dojo_id"], ["dojos.id"]),
        sa.ForeignKeyConstraint(["tournament_id"], ["tournaments.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("token"),
    )
    with op.batch_alter_table("tournament_invitations", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_tournament_invitations_tournament_id"), ["tournament_id"], unique=False)

    op.create_table(
        "dojo_admin_requests",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("tournament_id", sa.Integer(), nullable=False),
        sa.Column("invitation_id", sa.Integer(), nullable=True),
        sa.Column("dojo_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("created_at", UtcDateTime, nullable=False),
        sa.Column("decided_at", UtcDateTime, nullable=True),
        sa.Column("decided_by_id", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["decided_by_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["dojo_id"], ["dojos.id"]),
        sa.ForeignKeyConstraint(["invitation_id"], ["tournament_invitations.id"]),
        sa.ForeignKeyConstraint(["tournament_id"], ["tournaments.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("dojo_admin_requests", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_dojo_admin_requests_tournament_id"), ["tournament_id"], unique=False)

    # --- Columnas nuevas en tablas existentes ---
    with op.batch_alter_table("category_templates", schema=None) as batch_op:
        batch_op.add_column(sa.Column("organization_id", sa.Integer(), nullable=True))
        batch_op.create_index(batch_op.f("ix_category_templates_organization_id"), ["organization_id"], unique=False)
        batch_op.create_foreign_key("fk_category_templates_organization", "organizations", ["organization_id"], ["id"])

    with op.batch_alter_table("dojos", schema=None) as batch_op:
        batch_op.add_column(sa.Column("organization_id", sa.Integer(), nullable=True))
        batch_op.create_index(batch_op.f("ix_dojos_organization_id"), ["organization_id"], unique=False)
        batch_op.create_foreign_key("fk_dojos_organization", "organizations", ["organization_id"], ["id"])

    with op.batch_alter_table("registrations", schema=None) as batch_op:
        batch_op.add_column(sa.Column("requested_by_id", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("rejection_reason", sa.Unicode(length=500), nullable=True))
        batch_op.create_foreign_key("fk_registrations_requested_by", "users", ["requested_by_id"], ["id"])

    with op.batch_alter_table("tournaments", schema=None) as batch_op:
        batch_op.add_column(sa.Column("organization_id", sa.Integer(), nullable=True))
        batch_op.add_column(
            sa.Column("self_registration_open", sa.Boolean(), server_default=sa.false(), nullable=False)
        )
        batch_op.add_column(sa.Column("self_registration_closes_at", UtcDateTime, nullable=True))

    # Backfill: la organización principal se queda con todos los torneos existentes.
    conn = op.get_bind()
    now = sa.func.current_timestamp()
    conn.execute(
        organizations.insert().values(
            name="Organización principal",
            slug="principal",
            kind="organizer",
            country="PE",
            timezone="America/Lima",
            currency="PEN",
            created_at=now,
            updated_at=now,
            version=1,
        )
    )
    org_id = conn.execute(sa.text("SELECT id FROM organizations WHERE slug = 'principal'")).scalar_one()
    conn.execute(sa.text("UPDATE tournaments SET organization_id = :org"), {"org": org_id})

    # Recién con todos los torneos asignados la columna pasa a ser obligatoria.
    # En SQL Server el índice y la clave foránea se crean después del ALTER
    # COLUMN (no se puede cambiar una columna que ya tiene un índice).
    with op.batch_alter_table("tournaments", schema=None) as batch_op:
        batch_op.alter_column("organization_id", existing_type=sa.Integer(), nullable=False)
    with op.batch_alter_table("tournaments", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_tournaments_organization_id"), ["organization_id"], unique=False)
        batch_op.create_foreign_key("fk_tournaments_organization", "organizations", ["organization_id"], ["id"])


def downgrade() -> None:
    with op.batch_alter_table("tournaments", schema=None) as batch_op:
        batch_op.drop_constraint("fk_tournaments_organization", type_="foreignkey")
        batch_op.drop_index(batch_op.f("ix_tournaments_organization_id"))
        batch_op.drop_column("self_registration_closes_at")
        batch_op.drop_column("self_registration_open")
        batch_op.drop_column("organization_id")

    with op.batch_alter_table("registrations", schema=None) as batch_op:
        batch_op.drop_constraint("fk_registrations_requested_by", type_="foreignkey")
        batch_op.drop_column("rejection_reason")
        batch_op.drop_column("requested_by_id")

    with op.batch_alter_table("dojos", schema=None) as batch_op:
        batch_op.drop_constraint("fk_dojos_organization", type_="foreignkey")
        batch_op.drop_index(batch_op.f("ix_dojos_organization_id"))
        batch_op.drop_column("organization_id")

    with op.batch_alter_table("category_templates", schema=None) as batch_op:
        batch_op.drop_constraint("fk_category_templates_organization", type_="foreignkey")
        batch_op.drop_index(batch_op.f("ix_category_templates_organization_id"))
        batch_op.drop_column("organization_id")

    op.drop_table("dojo_admin_requests")
    op.drop_table("tournament_invitations")
    op.drop_table("subscriptions")
    op.drop_table("plans")
    op.drop_table("organization_members")
    op.drop_table("organizations")
