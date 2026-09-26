"""Cobros: interfaz de la pasarela de pagos y cómo se aplica cada pago.

Proveedores (``HAJIME_PAYMENT_PROVIDER``):

* ``manual`` (por defecto): el Admin Global coordina el pago por fuera
  (transferencia, Yape…) y lo marca como pagado.
* ``mercadopago``: Checkout Pro (pago único) y ``preapproval`` (mensual
  automático). Ver :mod:`app.services.gateways.mercadopago`.
* ``culqi``: Culqi Checkout en el navegador genera un token; el servidor crea
  el cargo o la suscripción. Ver :mod:`app.services.gateways.culqi`.

Reglas comunes (docs/cobros.md):

* Nunca se confía solo en el cuerpo del aviso (webhook): se verifica la firma
  y se consulta el pago a la API de la pasarela.
* Cada pago queda en ``payments`` con el id de la pasarela (``provider_ref``,
  único): un aviso repetido no duplica ni extiende dos veces el periodo.
* Pago aprobado → suscripción ``active`` y el periodo se extiende un mes o un
  año (desde hoy o desde el fin vigente). Rechazado o vencido → ``past_due``
  con gracia (``HAJIME_BILLING_GRACE_DAYS``) antes de quitar el acceso.
* Nada de datos de tarjeta en el servidor ni credenciales en el código.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any, Literal, Protocol

from sqlalchemy import select, true
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.errors import AppError, InvalidState, NotFound
from app.config import get_settings
from app.db.base import utcnow
from app.db.models import Coupon, Payment, Subscription, User
from app.services.audit import audit

log = logging.getLogger("hajime.pagos")

Period = Literal["month", "year"]
PAYMENT_STATUSES = ("pending", "approved", "rejected", "refunded")
# Orden de los estados de un pago: nunca se retrocede (un aviso viejo que llega
# tarde no deshace uno nuevo).
_RANK = {"pending": 0, "rejected": 1, "approved": 1, "refunded": 2}


class GatewayNotConfigured(AppError):
    status_code = 503
    code = "PAYMENTS_NOT_CONFIGURED"


class GatewayFailed(AppError):
    status_code = 502
    code = "PAYMENT_GATEWAY_ERROR"


@dataclass
class CheckoutContext:
    """Lo que la pasarela necesita para crear el cobro."""

    amount_cents: int
    description: str
    external_reference: str
    base_url: str
    # Cobro mensual automático (si la pasarela lo soporta).
    recurring: bool = False
    payer_email: str | None = None


@dataclass
class Checkout:
    """Lo que la interfaz necesita para que el cliente pague."""

    provider: str
    subscription_id: int
    # URL de pago de la pasarela (None en el proveedor manual y en Culqi).
    url: str | None = None
    instructions: str = ""
    reference: str | None = None
    provider_subscription_id: str | None = None
    public_key: str | None = None
    recurring: bool = False


@dataclass
class PaymentUpdate:
    """Estado de un pago según la API de la pasarela (ya verificado)."""

    provider_ref: str
    status: str  # pending | approved | rejected | refunded
    amount_cents: int
    currency: str = "PEN"
    subscription_id: int | None = None
    external_reference: str | None = None
    provider_subscription_id: str | None = None
    idempotency_key: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass
class WebhookResult:
    """Aviso de la pasarela ya verificado: un pago o un cambio de la suscripción."""

    subscription_id: int | None = None
    status: str | None = None  # active | past_due | canceled (cambio directo de la suscripción)
    period: Period | None = None
    reference: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)
    payment: PaymentUpdate | None = None
    # Suscripción recurrente en la pasarela: authorized | cancelled
    provider_subscription_id: str | None = None
    recurring_status: str | None = None
    ignored: bool = False


class Provider(Protocol):
    name: str

    def create_checkout(self, db: Session, sub: Subscription, period: Period, ctx: CheckoutContext) -> Checkout:
        """Crea el cobro de una suscripción (pendiente) y devuelve cómo pagarlo."""
        ...

    def handle_webhook(self, db: Session, body: bytes, headers: dict[str, str], query: dict[str, str]) -> WebhookResult:
        """Verifica el aviso (firma) y consulta el pago a la API. Lanza AppError si no es válido."""
        ...

    def refund(self, db: Session, payment: Payment) -> None:
        """Devuelve el pago en la pasarela (lanza AppError si no se pudo)."""
        ...

    def cancel_recurring(self, db: Session, sub: Subscription) -> None:
        """Detiene el cobro automático en la pasarela."""
        ...


class ManualProvider:
    """Sin pasarela: el Admin marca pagado (POST /subscriptions/{id}/mark-paid)."""

    name = "manual"

    def create_checkout(self, db: Session, sub: Subscription, period: Period, ctx: CheckoutContext) -> Checkout:
        return Checkout(
            provider=self.name,
            subscription_id=sub.id,
            reference=ctx.external_reference,
            instructions=(
                "El pago se coordina con el equipo de Hajime (transferencia o Yape). "
                "Cuando se confirme, el administrador activa la suscripción."
            ),
        )

    def handle_webhook(self, db: Session, body: bytes, headers: dict[str, str], query: dict[str, str]) -> WebhookResult:
        raise AppError("El proveedor manual no recibe avisos de pago", code="WEBHOOK_NOT_SUPPORTED")

    def refund(self, db: Session, payment: Payment) -> None:
        return None  # la devolución se hace por fuera; aquí solo se registra

    def cancel_recurring(self, db: Session, sub: Subscription) -> None:
        return None


def _registry() -> dict[str, Provider]:
    from app.services.gateways.culqi import CulqiProvider
    from app.services.gateways.mercadopago import MercadoPagoProvider

    return {"manual": ManualProvider(), "mercadopago": MercadoPagoProvider(), "culqi": CulqiProvider()}


PROVIDERS: dict[str, Provider] = {}


def provider(name: str | None = None) -> Provider:
    if not PROVIDERS:
        PROVIDERS.update(_registry())
    name = name or get_settings().payment_provider
    p = PROVIDERS.get(name)
    if p is None:
        raise NotFound(f"Proveedor de pagos desconocido: {name}")
    return p


def period_delta(period: Period) -> timedelta:
    return timedelta(days=365 if period == "year" else 30)


def mark_paid(db: Session, user: User | None, sub: Subscription, period: Period, reference: str | None = None) -> None:
    """Activa la suscripción y extiende su periodo (desde hoy o desde el fin vigente)."""
    if sub.status == "canceled":
        raise InvalidState("La suscripción está cancelada; crea una nueva")
    now = utcnow()
    start = sub.current_period_end if sub.current_period_end and sub.current_period_end > now else now
    before = {"status": sub.status, "current_period_end": str(sub.current_period_end)}
    sub.status = "active"
    sub.current_period_end = start + period_delta(period)
    sub.grace_until = None
    if reference:
        sub.reference = reference
    audit(
        db,
        user,
        "subscription",
        sub.id,
        "mark_paid",
        before,
        {"status": sub.status, "current_period_end": str(sub.current_period_end), "period": period},
    )


def start_grace(db: Session, sub: Subscription, reason: str) -> None:
    """Pago rechazado o vencido: ``past_due`` con gracia antes de quitar el acceso.

    Si la suscripción nunca dio acceso (checkout sin pagar), queda ``past_due``
    sin gracia.
    """
    if sub.status == "canceled":
        return
    now = utcnow()
    before = {"status": sub.status, "grace_until": str(sub.grace_until)}
    had_access = sub.status in ("active", "trial") and sub.current_period_end is not None
    if had_access and sub.grace_until is None:
        base = max(now, sub.current_period_end)
        sub.grace_until = base + timedelta(days=get_settings().billing_grace_days)
    sub.status = "past_due"
    audit(db, None, "subscription", sub.id, "past_due", before, {"grace_until": str(sub.grace_until), "why": reason})


def parse_reference(ref: str | None) -> int | None:
    """Id de la suscripción en la referencia externa ``hjm-<id>-<azar>``."""
    if not ref or not ref.startswith("hjm-"):
        return None
    parts = ref.split("-")
    return int(parts[1]) if len(parts) >= 3 and parts[1].isdigit() else None


def resolve_subscription(
    db: Session,
    subscription_id: int | None,
    external_reference: str | None,
    provider_subscription_id: str | None,
) -> Subscription | None:
    """La suscripción de un pago: por id, por referencia externa o por la suscripción de la pasarela."""
    if subscription_id is not None:
        sub = db.get(Subscription, subscription_id)
        if sub is not None:
            return sub
    if external_reference:
        sub = db.scalar(select(Subscription).where(Subscription.reference == external_reference))
        if sub is not None:
            return sub
        sid = parse_reference(external_reference)
        if sid is not None and (sub := db.get(Subscription, sid)) is not None:
            return sub
    if provider_subscription_id:
        return db.scalar(
            select(Subscription)
            .where(Subscription.provider_subscription_id == provider_subscription_id)
            .order_by(Subscription.id.desc())
        )
    return None


def record_payment(db: Session, provider_name: str, upd: PaymentUpdate) -> Payment:
    """Registra (o actualiza) un pago y aplica su efecto una sola vez.

    Idempotente: el mismo ``provider_ref`` dos veces no crea otra fila ni
    extiende otra vez el periodo. Los pagos recién aprobados quedan en
    ``db.info["approved_payments"]`` para emitir el comprobante y avisar
    después del commit (:func:`after_commit`).
    """
    if upd.status not in PAYMENT_STATUSES:
        raise ValueError(f"Estado de pago desconocido: {upd.status}")
    sub = resolve_subscription(db, upd.subscription_id, upd.external_reference, upd.provider_subscription_id)
    pay = db.scalar(select(Payment).where(Payment.provider_ref == upd.provider_ref))
    if pay is None:
        pay = Payment(
            provider=provider_name,
            provider_ref=upd.provider_ref,
            subscription_id=sub.id if sub else None,
            amount_pen=upd.amount_cents,
            currency=upd.currency,
            status=upd.status,
            period=sub.period if sub else None,
            idempotency_key=upd.idempotency_key,
            raw=upd.raw,
        )
        try:
            with db.begin_nested():
                db.add(pay)
        except IntegrityError:  # el mismo aviso llegó dos veces a la vez
            pay = db.scalar(select(Payment).where(Payment.provider_ref == upd.provider_ref))
            assert pay is not None
            return pay
        changed = True
    else:
        changed = _RANK[upd.status] > _RANK[pay.status] or (
            _RANK[upd.status] == _RANK[pay.status] and upd.status != pay.status and pay.status == "rejected"
        )
        if not changed:
            return pay  # aviso repetido o viejo: nada que hacer
        pay.status = upd.status
        pay.amount_pen = upd.amount_cents or pay.amount_pen
        pay.raw = upd.raw or pay.raw
        if pay.subscription_id is None and sub is not None:
            pay.subscription_id = sub.id
    if sub is None:
        log.warning("Pago %s de %s sin suscripción conocida", upd.provider_ref, provider_name)
        return pay
    if upd.provider_subscription_id and not sub.provider_subscription_id:
        sub.provider_subscription_id = upd.provider_subscription_id
    if changed and pay.status == "approved" and not pay.applied:
        _approve(db, sub, pay)
    elif changed and pay.status == "rejected":
        start_grace(db, sub, f"pago {pay.provider_ref} rechazado")
    elif changed and pay.status == "refunded":
        audit(db, None, "payment", pay.id, "refunded", after={"provider_ref": pay.provider_ref})
    return pay


def _approve(db: Session, sub: Subscription, pay: Payment) -> None:
    if pay.currency != "PEN" or (sub.amount_cents is not None and pay.amount_pen < sub.amount_cents):
        # Defensa: el monto no es el esperado. Queda registrado para revisión.
        log.warning("Pago %s con monto %s %s distinto del esperado", pay.provider_ref, pay.amount_pen, pay.currency)
        audit(
            db,
            None,
            "payment",
            pay.id,
            "amount_mismatch",
            after={"amount": pay.amount_pen, "expected": sub.amount_cents, "currency": pay.currency},
        )
        return
    if sub.status == "canceled":
        audit(db, None, "payment", pay.id, "approved_on_canceled", after={"subscription_id": sub.id})
        return
    first = not db.scalar(
        select(Payment.id).where(Payment.subscription_id == sub.id, Payment.applied == true(), Payment.id != pay.id)
    )
    mark_paid(db, None, sub, sub.period or pay.period or "month", pay.provider_ref)  # type: ignore[arg-type]
    sub.source = "payment"
    pay.applied = True
    pay.period = pay.period or sub.period
    coupon = _coupon(db, sub.coupon_code)
    if coupon is not None and (first or not coupon.first_period_only):
        pay.coupon_code = coupon.code
        if first:
            coupon.times_redeemed = (coupon.times_redeemed or 0) + 1
    if coupon is not None and coupon.first_period_only:
        # Las renovaciones van a precio completo.
        from app.services import checkout

        sub.amount_cents = checkout.plan_price_cents(db, sub.plan_code, sub.period or "month")
    db.info.setdefault("approved_payments", []).append(pay.id)


def _coupon(db: Session, code: str | None) -> Coupon | None:
    if not code:
        return None
    return db.scalar(select(Coupon).where(Coupon.code == code))


def apply_webhook(db: Session, result: WebhookResult, provider_name: str | None = None) -> Subscription | None:
    """Aplica un aviso ya verificado de la pasarela."""
    if result.ignored:
        return None
    if result.payment is not None:
        pay = record_payment(db, provider_name or "manual", result.payment)
        return db.get(Subscription, pay.subscription_id) if pay.subscription_id else None
    sub = resolve_subscription(db, result.subscription_id, result.reference, result.provider_subscription_id)
    if sub is None:
        return None
    if result.recurring_status == "authorized":
        if result.provider_subscription_id and sub.provider_subscription_id != result.provider_subscription_id:
            sub.provider_subscription_id = result.provider_subscription_id
        return sub
    if result.recurring_status == "cancelled":
        if not sub.cancel_at_period_end:
            sub.cancel_at_period_end = True
            audit(db, None, "subscription", sub.id, "recurring_cancelled", after={"by": provider_name})
        return sub
    if result.status == "active":
        mark_paid(db, None, sub, result.period or "month", result.reference)
    elif result.status == "past_due":
        start_grace(db, sub, "aviso de la pasarela")
    elif result.status:
        audit(db, None, "subscription", sub.id, "webhook", {"status": sub.status}, {"status": result.status})
        sub.status = result.status
    sub.source = "payment"
    return sub


def after_commit(db: Session) -> None:
    """Tras confirmar los pagos aprobados: comprobante electrónico y aviso al titular.

    Un error aquí no deshace el pago (ya está guardado): el comprobante queda
    con estado ``error`` y el Admin lo reintenta.
    """
    from app.services import invoicing

    ids = db.info.pop("approved_payments", [])
    for pid in ids:
        pay = db.get(Payment, pid)
        if pay is None:
            continue
        try:
            invoicing.emit_for_payment(db, pay)
            db.commit()
        except Exception:  # noqa: BLE001 - el pago ya está confirmado
            db.rollback()
            log.exception("No se pudo emitir el comprobante del pago %s", pid)
        notify_payment(db, pay)


def notify_payment(db: Session, pay: Payment) -> None:
    """Aviso al titular del pago aprobado (recibo).

    Todavía no hay servicio de correo en esta base: solo se registra en el log
    (sin datos personales). Cuando exista ``app.services.mail`` con
    ``mail.enqueue``, se encola el recibo; un fallo del correo nunca afecta al
    pago ya confirmado.
    """
    try:
        from app.services import mail  # type: ignore[attr-defined]
    except ImportError:
        log.info("Pago %s aprobado (suscripción %s): recibo pendiente de correo", pay.id, pay.subscription_id)
        return
    try:  # pragma: no cover - depende del servicio de correo
        sub = db.get(Subscription, pay.subscription_id) if pay.subscription_id else None
        email = sub.billing_email if sub else None
        if not email and sub and sub.organization_id:
            from app.db.models import Organization

            org = db.get(Organization, sub.organization_id)
            email = org.billing_email if org else None
        if email:
            mail.enqueue(
                to=email,
                subject="Hajime: pago recibido",
                body=f"Recibimos tu pago de S/ {pay.amount_pen / 100:.2f}. Gracias.",
            )
    except Exception:  # noqa: BLE001
        log.exception("No se pudo encolar el recibo del pago %s", pay.id)
