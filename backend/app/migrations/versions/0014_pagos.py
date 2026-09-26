"""pagos con pasarela, comprobantes electrónicos, cupones y prueba gratis

Tablas ``payments`` (cada pago de la pasarela, único por ``provider_ref``),
``invoices`` (boletas y facturas de SUNAT) y ``coupons`` (con el cupón de
ejemplo «PRIMER-TORNEO» sembrado desactivado). Columnas nuevas, todas
opcionales o con valor por defecto: datos fiscales en ``organizations``,
``trial_days`` en ``plans`` (30 para Dojo y Organizador) y el estado del cobro
en ``subscriptions`` (periodo, pasarela, gracia, cupón, titular de la boleta).

Revision ID: 0014_pagos
Revises: 0010_reglas_deportivas
Create Date: 2026-09-26 18:10:00
"""

from datetime import datetime

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mssql

revision = "0014_pagos"
down_revision = "0010_reglas_deportivas"
branch_labels = None
depends_on = None

UtcDateTime = sa.DateTime().with_variant(mssql.DATETIME2(), "mssql")


def upgrade() -> None:
    coupons = op.create_table(
        "coupons",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("code", sa.String(length=40), nullable=False),
        sa.Column("description", sa.Unicode(length=300), nullable=False),
        sa.Column("percent_off", sa.Integer(), nullable=True),
        sa.Column("amount_off_pen", sa.Integer(), nullable=True),
        sa.Column("plan_codes", sa.JSON(), nullable=False),
        sa.Column("max_redemptions", sa.Integer(), nullable=True),
        sa.Column("times_redeemed", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("expires_at", UtcDateTime, nullable=True),
        sa.Column("first_period_only", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column("active", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column("created_at", UtcDateTime, nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("code"),
    )
    op.create_table(
        "payments",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("provider", sa.String(length=20), nullable=False),
        sa.Column("provider_ref", sa.String(length=120), nullable=False),
        sa.Column("subscription_id", sa.Integer(), nullable=True),
        sa.Column("amount_pen", sa.Integer(), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("period", sa.String(length=10), nullable=True),
        sa.Column("coupon_code", sa.String(length=40), nullable=True),
        sa.Column("idempotency_key", sa.String(length=64), nullable=True),
        sa.Column("applied", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("raw", sa.JSON(), nullable=True),
        sa.Column("created_at", UtcDateTime, nullable=False),
        sa.Column("updated_at", UtcDateTime, nullable=False),
        sa.ForeignKeyConstraint(
            ["subscription_id"],
            ["subscriptions.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("provider_ref"),
    )
    with op.batch_alter_table("payments", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_payments_idempotency_key"), ["idempotency_key"], unique=False)
        batch_op.create_index(batch_op.f("ix_payments_subscription_id"), ["subscription_id"], unique=False)

    op.create_table(
        "invoices",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("payment_id", sa.Integer(), nullable=False),
        sa.Column("provider", sa.String(length=20), nullable=False),
        sa.Column("doc_type", sa.String(length=10), nullable=False),
        sa.Column("serie", sa.String(length=4), nullable=False),
        sa.Column("numero", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("customer_doc_type", sa.String(length=2), nullable=False),
        sa.Column("customer_doc", sa.String(length=15), nullable=False),
        sa.Column("customer_name", sa.Unicode(length=200), nullable=False),
        sa.Column("total_pen", sa.Integer(), nullable=False),
        sa.Column("pdf_url", sa.String(length=500), nullable=True),
        sa.Column("xml_url", sa.String(length=500), nullable=True),
        sa.Column("cdr_url", sa.String(length=500), nullable=True),
        sa.Column("message", sa.Unicode(length=500), nullable=False),
        sa.Column("raw", sa.JSON(), nullable=True),
        sa.Column("created_at", UtcDateTime, nullable=False),
        sa.Column("updated_at", UtcDateTime, nullable=False),
        sa.ForeignKeyConstraint(
            ["payment_id"],
            ["payments.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("payment_id"),
        sa.UniqueConstraint("serie", "numero", name="uq_invoice_serie_numero"),
    )
    with op.batch_alter_table("organizations", schema=None) as batch_op:
        batch_op.add_column(sa.Column("tax_id", sa.String(length=11), nullable=True))
        batch_op.add_column(sa.Column("legal_name", sa.Unicode(length=200), nullable=True))
        batch_op.add_column(sa.Column("tax_address", sa.Unicode(length=300), nullable=True))
        batch_op.add_column(sa.Column("billing_email", sa.String(length=200), nullable=True))

    with op.batch_alter_table("plans", schema=None) as batch_op:
        batch_op.add_column(sa.Column("trial_days", sa.Integer(), server_default=sa.text("0"), nullable=False))

    with op.batch_alter_table("subscriptions", schema=None) as batch_op:
        batch_op.add_column(sa.Column("period", sa.String(length=10), nullable=True))
        batch_op.add_column(sa.Column("provider", sa.String(length=20), nullable=True))
        batch_op.add_column(sa.Column("provider_subscription_id", sa.String(length=120), nullable=True))
        batch_op.add_column(sa.Column("grace_until", UtcDateTime, nullable=True))
        batch_op.add_column(sa.Column("cancel_at_period_end", sa.Boolean(), server_default=sa.false(), nullable=False))
        batch_op.add_column(sa.Column("coupon_code", sa.String(length=40), nullable=True))
        batch_op.add_column(sa.Column("amount_cents", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("billing_doc", sa.String(length=15), nullable=True))
        batch_op.add_column(sa.Column("billing_name", sa.Unicode(length=200), nullable=True))
        batch_op.add_column(sa.Column("billing_email", sa.String(length=200), nullable=True))
        batch_op.create_index(
            batch_op.f("ix_subscriptions_provider_subscription_id"), ["provider_subscription_id"], unique=False
        )

    # Prueba gratis de 30 días para las membresías de organización.
    plans = sa.table("plans", sa.column("code", sa.String), sa.column("trial_days", sa.Integer))
    op.execute(plans.update().where(plans.c.code.in_(["dojo", "organizador"])).values(trial_days=30))
    # Cupón de ejemplo «primer torneo gratis», DESACTIVADO: el Admin lo activa
    # (y ajusta) cuando decida usarlo.
    op.bulk_insert(
        coupons,
        [
            {
                "code": "PRIMER-TORNEO",
                "description": "Primer torneo gratis: el primer mes de Dojo u Organizador sin costo",
                "percent_off": 100,
                "amount_off_pen": None,
                "plan_codes": ["dojo", "organizador"],
                "max_redemptions": None,
                "times_redeemed": 0,
                "expires_at": None,
                "first_period_only": True,
                "active": False,
                "created_at": datetime(2026, 9, 26),
            }
        ],
    )


def downgrade() -> None:
    with op.batch_alter_table("subscriptions", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_subscriptions_provider_subscription_id"))
        batch_op.drop_column("billing_email")
        batch_op.drop_column("billing_name")
        batch_op.drop_column("billing_doc")
        batch_op.drop_column("amount_cents")
        batch_op.drop_column("coupon_code")
        batch_op.drop_column("cancel_at_period_end")
        batch_op.drop_column("grace_until")
        batch_op.drop_column("provider_subscription_id")
        batch_op.drop_column("provider")
        batch_op.drop_column("period")

    with op.batch_alter_table("plans", schema=None) as batch_op:
        batch_op.drop_column("trial_days")

    with op.batch_alter_table("organizations", schema=None) as batch_op:
        batch_op.drop_column("billing_email")
        batch_op.drop_column("tax_address")
        batch_op.drop_column("legal_name")
        batch_op.drop_column("tax_id")

    op.drop_table("invoices")
    with op.batch_alter_table("payments", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_payments_subscription_id"))
        batch_op.drop_index(batch_op.f("ix_payments_idempotency_key"))

    op.drop_table("payments")
    op.drop_table("coupons")
