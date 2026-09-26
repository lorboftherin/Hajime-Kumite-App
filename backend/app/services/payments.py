"""Cobros: interfaz de la pasarela de pagos.

Hoy solo existe el proveedor ``manual``: el Admin Global coordina el pago por
fuera (transferencia, Yape…) y lo marca como pagado. La pasarela real (Culqi,
Mercado Pago o Izipay) se agrega después implementando :class:`Provider` y
registrándola en ``PROVIDERS``; nada del resto de la app cambia.

Nunca hay credenciales en el código: la pasarela real leerá las suyas de la
configuración (variables de entorno o Key Vault).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any, Literal, Protocol

from sqlalchemy.orm import Session

from app.api.errors import AppError, InvalidState, NotFound
from app.config import get_settings
from app.db.base import utcnow
from app.db.models import Subscription, User
from app.services.audit import audit

Period = Literal["month", "year"]


@dataclass
class Checkout:
    """Lo que la interfaz necesita para que el cliente pague."""

    provider: str
    subscription_id: int
    # URL de pago de la pasarela (None en el proveedor manual).
    url: str | None = None
    instructions: str = ""
    reference: str | None = None


@dataclass
class WebhookResult:
    """Evento de la pasarela ya verificado: qué suscripción y a qué estado pasa."""

    subscription_id: int | None
    status: str | None  # active | past_due | canceled
    period: Period | None = None
    reference: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)


class Provider(Protocol):
    name: str

    def create_checkout(self, db: Session, sub: Subscription, period: Period) -> Checkout:
        """Crea el cobro de una suscripción (pendiente) y devuelve cómo pagarlo."""
        ...

    def handle_webhook(self, db: Session, body: bytes, headers: dict[str, str]) -> WebhookResult:
        """Verifica la firma del aviso de la pasarela y lo traduce. Lanza AppError si no es válido."""
        ...


class ManualProvider:
    """Sin pasarela: el Admin marca pagado (POST /subscriptions/{id}/mark-paid)."""

    name = "manual"

    def create_checkout(self, db: Session, sub: Subscription, period: Period) -> Checkout:
        return Checkout(
            provider=self.name,
            subscription_id=sub.id,
            instructions=(
                "El pago se coordina con el equipo de Hajime (transferencia o Yape). "
                "Cuando se confirme, el administrador activa la suscripción."
            ),
        )

    def handle_webhook(self, db: Session, body: bytes, headers: dict[str, str]) -> WebhookResult:
        raise AppError("El proveedor manual no recibe avisos de pago", code="WEBHOOK_NOT_SUPPORTED")


PROVIDERS: dict[str, Provider] = {"manual": ManualProvider()}


def provider(name: str | None = None) -> Provider:
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


def apply_webhook(db: Session, result: WebhookResult) -> Subscription | None:
    """Aplica un aviso ya verificado de la pasarela."""
    if result.subscription_id is None or result.status is None:
        return None
    sub = db.get(Subscription, result.subscription_id)
    if sub is None:
        return None
    if result.status == "active":
        mark_paid(db, None, sub, result.period or "month", result.reference)
    else:
        audit(db, None, "subscription", sub.id, "webhook", {"status": sub.status}, {"status": result.status})
        sub.status = result.status
    sub.source = "payment"
    return sub
