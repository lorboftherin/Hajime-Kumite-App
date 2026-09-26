"""Contratar un plan: precio con cupón, periodo de prueba, checkout, cancelación y reembolso.

El titular es una organización (membresía Dojo u Organizador) o una cuenta de
usuario (Competidor Plus). Los montos se manejan en céntimos de sol.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import timedelta
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.api.errors import Forbidden, InvalidState, NotFound
from app.config import get_settings
from app.db.base import utcnow
from app.db.models import Coupon, Organization, Payment, Plan, Subscription, User
from app.services import entitlements, payments
from app.services.audit import audit, snapshot


@dataclass
class Quote:
    plan: Plan
    period: payments.Period
    list_cents: int
    discount_cents: int
    first_cents: int
    recurring_cents: int
    coupon: Coupon | None


def plan_price_cents(db: Session, plan_code: str, period: str) -> int:
    plan = entitlements.get_plan(db, plan_code)
    if plan is None:
        raise NotFound("Plan no encontrado")
    price = plan.price_pen_year if period == "year" else plan.price_pen_month
    if price is None:
        raise InvalidState(f"El plan {plan.name} no tiene precio {'anual' if period == 'year' else 'mensual'}")
    return int((Decimal(str(price)) * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def find_coupon(db: Session, code: str | None, plan_code: str) -> Coupon | None:
    """El cupón vigente para el plan, o 409 con el motivo si no se puede usar."""
    if not code or not code.strip():
        return None
    c = db.scalar(select(Coupon).where(Coupon.code == code.strip().upper()))
    if c is None or not c.active:
        raise InvalidState("El cupón no existe o no está activo", code="COUPON_INVALID")
    if c.expires_at is not None and c.expires_at <= utcnow():
        raise InvalidState("El cupón venció", code="COUPON_INVALID")
    if c.max_redemptions is not None and (c.times_redeemed or 0) >= c.max_redemptions:
        raise InvalidState("El cupón ya se usó todas las veces permitidas", code="COUPON_INVALID")
    if c.plan_codes and plan_code not in c.plan_codes:
        raise InvalidState("El cupón no aplica a este plan", code="COUPON_INVALID")
    return c


def quote(db: Session, plan: Plan, period: payments.Period, coupon_code: str | None) -> Quote:
    list_cents = plan_price_cents(db, plan.code, period)
    coupon = find_coupon(db, coupon_code, plan.code)
    discount = 0
    if coupon is not None:
        if coupon.percent_off:
            discount = list_cents * coupon.percent_off // 100
        elif coupon.amount_off_pen:
            discount = coupon.amount_off_pen
        discount = min(discount, list_cents)
    first = list_cents - discount
    recurring = list_cents if (coupon is None or coupon.first_period_only) else first
    return Quote(plan, period, list_cents, discount, first, recurring, coupon)


def _check_plan(db: Session, plan_code: str, audience: str) -> Plan:
    plan = entitlements.get_plan(db, plan_code)
    if plan is None:
        raise NotFound("Plan no encontrado")
    if plan.code == "marcha_blanca" or plan.audience not in (audience, "all"):
        raise InvalidState(
            "Ese plan no se contrata para una organización"
            if audience == "organization"
            else "Ese plan es para organizaciones"
        )
    if not (plan.price_pen_month or plan.price_pen_year):
        raise InvalidState("Ese plan es gratis: no hace falta contratarlo")
    return plan


def _subject_filter(organization_id: int | None, user_id: int | None):
    if organization_id is not None:
        return Subscription.organization_id == organization_id
    return Subscription.user_id == user_id


def _reusable(db: Session, organization_id: int | None, user_id: int | None, plan_code: str) -> Subscription | None:
    """Suscripción del mismo plan que se renueva en vez de crear otra (vigente o pendiente)."""
    return db.scalar(
        select(Subscription)
        .where(
            _subject_filter(organization_id, user_id),
            Subscription.plan_code == plan_code,
            Subscription.status != "canceled",
        )
        .order_by(Subscription.id.desc())
    )


def base_url(request_base: str) -> str:
    return (get_settings().public_url or request_base).rstrip("/")


def start_checkout(
    db: Session,
    user: User,
    *,
    organization_id: int | None,
    user_id: int | None,
    plan_code: str,
    period: payments.Period,
    coupon_code: str | None,
    payer_email: str | None,
    billing_doc: str | None,
    billing_name: str | None,
    request_base: str,
) -> tuple[Subscription, payments.Checkout, Quote]:
    """Crea (o reutiliza) la suscripción pendiente y el cobro de la pasarela."""
    plan = _check_plan(db, plan_code, "organization" if organization_id is not None else "person")
    q = quote(db, plan, period, coupon_code)
    sub = _reusable(db, organization_id, user_id, plan.code)
    if sub is not None and entitlements.auto_renews(sub):
        raise InvalidState("Esta suscripción ya se renueva automáticamente; no hace falta pagarla otra vez")
    if sub is None:
        sub = Subscription(
            organization_id=organization_id,
            user_id=user_id,
            plan_code=plan.code,
            status="past_due",  # sin pagar todavía: no da acceso
            source="payment",
            notes=f"Pedido por {user.username}",
            created_by_id=user.id,
        )
        db.add(sub)
        db.flush()
    prov = payments.provider()
    sub.period = period
    sub.provider = prov.name
    sub.coupon_code = q.coupon.code if q.coupon else None
    sub.amount_cents = q.first_cents
    sub.cancel_at_period_end = False
    sub.reference = f"hjm-{sub.id}-{secrets.token_hex(6)}"
    if payer_email:
        sub.billing_email = payer_email
    if billing_doc is not None:
        sub.billing_doc = billing_doc or None
    if billing_name is not None:
        sub.billing_name = billing_name.strip() or None
    audit(
        db,
        user,
        "subscription",
        sub.id,
        "checkout",
        after={"plan": plan.code, "period": period, "amount": q.first_cents, "coupon": sub.coupon_code},
    )
    if q.first_cents == 0:
        # Un cupón cubre todo el primer periodo: se activa sin pasar por la pasarela.
        payments.record_payment(
            db,
            "coupon",
            payments.PaymentUpdate(
                provider_ref=f"coupon-{sub.reference}",
                status="approved",
                amount_cents=0,
                subscription_id=sub.id,
            ),
        )
        co = payments.Checkout(
            provider="coupon",
            subscription_id=sub.id,
            instructions=f"El cupón {sub.coupon_code} cubre el primer periodo: la suscripción ya está activa.",
        )
        return sub, co, q
    # Mensual automático solo si el precio es el mismo en todas las renovaciones.
    recurring = period == "month" and q.first_cents == q.recurring_cents
    who = f"org. {organization_id}" if organization_id is not None else f"cuenta {user.username}"
    ctx = payments.CheckoutContext(
        amount_cents=q.first_cents,
        description=f"Hajime {plan.name} ({'anual' if period == 'year' else 'mensual'}) · {who}"[:120],
        external_reference=sub.reference,
        base_url=base_url(request_base),
        recurring=recurring,
        payer_email=payer_email,
    )
    co = prov.create_checkout(db, sub, period, ctx)
    if co.provider_subscription_id:
        sub.provider_subscription_id = co.provider_subscription_id
    return sub, co, q


def start_trial(db: Session, user: User, org: Organization, plan_code: str) -> Subscription:
    """Periodo de prueba gratis, una vez por organización."""
    plan = _check_plan(db, plan_code, "organization")
    if not plan.trial_days:
        raise InvalidState(f"El plan {plan.name} no tiene periodo de prueba")
    used = db.scalar(
        select(Subscription.id).where(
            Subscription.organization_id == org.id,
            or_(Subscription.status != "past_due", Subscription.current_period_end.is_not(None)),
        )
    )
    if used:
        raise InvalidState("La organización ya usó su periodo de prueba o ya tuvo un plan", code="TRIAL_USED")
    sub = Subscription(
        organization_id=org.id,
        plan_code=plan.code,
        status="trial",
        current_period_end=utcnow() + timedelta(days=plan.trial_days),
        source="payment",
        notes=f"Prueba de {plan.trial_days} días pedida por {user.username}",
        created_by_id=user.id,
    )
    db.add(sub)
    db.flush()
    audit(db, user, "subscription", sub.id, "trial", after=snapshot(sub))
    return sub


def can_manage_subscription(db: Session, user: User, sub: Subscription) -> bool:
    from app.api.deps import is_org_admin

    if user.is_admin:
        return True
    if sub.organization_id is not None:
        return is_org_admin(db, user, sub.organization_id)
    return sub.user_id == user.id or (sub.person_id is not None and sub.person_id == user.person_id)


def cancel(db: Session, user: User, sub: Subscription) -> Subscription:
    """El titular cancela: se detiene el cobro automático y conserva el acceso hasta el fin del periodo."""
    if not can_manage_subscription(db, user, sub):
        raise Forbidden("Solo el titular o un administrador puede cancelar esta suscripción")
    if sub.status == "canceled":
        raise InvalidState("La suscripción ya está cancelada")
    before = snapshot(sub)
    if sub.provider_subscription_id and sub.provider:
        # Si la pasarela falla se lanza el error y no se marca nada: el titular reintenta.
        payments.provider(sub.provider).cancel_recurring(db, sub)
    sub.cancel_at_period_end = True
    if not entitlements.is_current(sub) or sub.current_period_end is None or sub.status == "past_due":
        # Sin periodo pagado que conservar (o en gracia): se corta ya.
        sub.status = "canceled"
        sub.grace_until = None
    audit(db, user, "subscription", sub.id, "cancel", before, snapshot(sub))
    return sub


def refund(db: Session, admin: User, pay: Payment, reason: str, cancel_subscription: bool) -> Payment:
    """Reembolso (Admin Global): llama a la pasarela y marca el pago como devuelto."""
    if pay.status != "approved":
        raise InvalidState("Solo se reembolsa un pago aprobado")
    if pay.amount_pen > 0:
        payments.provider(pay.provider if pay.provider in ("mercadopago", "culqi") else "manual").refund(db, pay)
    before = {"status": pay.status}
    pay.status = "refunded"
    audit(db, admin, "payment", pay.id, "refund", before, {"status": "refunded"}, reason=reason)
    sub = db.get(Subscription, pay.subscription_id) if pay.subscription_id else None
    if sub is not None and cancel_subscription and sub.status != "canceled":
        sb = snapshot(sub)
        if sub.provider_subscription_id and sub.provider in ("mercadopago", "culqi"):
            payments.provider(sub.provider).cancel_recurring(db, sub)
        sub.status = "canceled"
        sub.cancel_at_period_end = True
        sub.grace_until = None
        audit(db, admin, "subscription", sub.id, "cancel_by_refund", sb, snapshot(sub), reason=reason)
    return pay


def payments_query(organization_id: int | None = None, user_id: int | None = None):
    stmt = select(Payment).join(Subscription, Subscription.id == Payment.subscription_id, isouter=True)
    if organization_id is not None:
        stmt = stmt.where(Subscription.organization_id == organization_id)
    if user_id is not None:
        stmt = stmt.where(Subscription.user_id == user_id)
    return stmt.order_by(Payment.id.desc())
