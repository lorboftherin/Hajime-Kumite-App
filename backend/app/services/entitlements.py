"""Planes y derechos (*entitlements*) verificados en la API.

Cada función de pago tiene un nombre (``FEATURES``). ``has(db, sujeto, función)``
responde si el sujeto la tiene:

* ``HAJIME_BILLING_MODE=marcha_blanca`` (por defecto): toda cuenta tiene todo.
* ``enforced``: una organización necesita una suscripción vigente a un plan que
  incluya la función; una persona (o su cuenta), para Competidor Plus.

El Admin Global no se bloquea nunca (opera la plataforma). Ver
``docs/organizaciones-y-planes.md``.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal

from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.errors import PlanRequired
from app.config import get_settings
from app.db.base import utcnow
from app.db.models import Organization, Person, Plan, Subscription, User

# Funciones con derecho propio.
FEATURES = {
    "organize_tournaments": "Organizar torneos",
    "multi_tatami": "Varios tatamis",
    "live_overlay": "Overlay para transmisiones en vivo",
    "shadow_mode": "Shadow Mode",
    "excel_import": "Importar inscripciones desde Excel",
    "dojo_self_registration": "Autoinscripción por dojo",
    "plus_insights": "Análisis de Competidor Plus",
    "certificates": "Certificados descargables",
}
ORG_FEATURES = [
    "organize_tournaments",
    "multi_tatami",
    "live_overlay",
    "shadow_mode",
    "excel_import",
    "dojo_self_registration",
    "certificates",
]
PERSON_FEATURES = ["plus_insights", "certificates"]


@dataclass(frozen=True)
class PlanSpec:
    code: str
    name: str
    audience: str  # organization | person | all
    price_pen_month: Decimal | None
    price_pen_year: Decimal | None
    features: tuple[str, ...]
    sort_order: int


# Catálogo inicial. Los precios son PROVISIONALES y se cambian en la tabla
# ``plans`` (o con PATCH /plans/{code}), no aquí: al arrancar solo se agregan
# los planes que falten.
CATALOG = (
    PlanSpec("marcha_blanca", "Marcha blanca", "all", None, None, tuple(FEATURES), 0),
    PlanSpec("publico", "Público", "all", Decimal(0), Decimal(0), (), 1),
    PlanSpec("competidor", "Competidor", "person", Decimal(0), Decimal(0), (), 2),
    PlanSpec(
        "competidor_plus", "Competidor Plus", "person", Decimal("9.90"), Decimal("49.00"), tuple(PERSON_FEATURES), 3
    ),
    PlanSpec("dojo", "Dojo", "organization", Decimal("69.00"), Decimal("690.00"), tuple(ORG_FEATURES), 4),
    PlanSpec(
        "organizador", "Organizador", "organization", Decimal("149.00"), Decimal("1490.00"), tuple(ORG_FEATURES), 5
    ),
)
# Estados de suscripción que dan acceso (con el periodo vigente).
VALID_STATUSES = ("trial", "active")


def billing_mode() -> str:
    return get_settings().billing_mode


def ensure_plans(db: Session) -> None:
    """Agrega los planes del catálogo que falten (idempotente; no toca precios)."""
    existing = set(db.scalars(select(Plan.code)).all())
    missing = [p for p in CATALOG if p.code not in existing]
    if not missing:
        return
    for p in missing:
        db.add(
            Plan(
                code=p.code,
                name=p.name,
                audience=p.audience,
                price_pen_month=p.price_pen_month,
                price_pen_year=p.price_pen_year,
                features=list(p.features),
                sort_order=p.sort_order,
            )
        )
    try:
        db.commit()
    except IntegrityError:  # otro proceso los sembró a la vez
        db.rollback()


def plans(db: Session) -> list[Plan]:
    ensure_plans(db)
    return list(db.scalars(select(Plan).order_by(Plan.sort_order, Plan.code)).all())


def get_plan(db: Session, code: str) -> Plan | None:
    ensure_plans(db)
    return db.get(Plan, code)


def is_current(sub: Subscription, now: datetime | None = None) -> bool:
    """Vigente: en prueba o activa y sin periodo vencido."""
    if sub.status not in VALID_STATUSES:
        return False
    return sub.current_period_end is None or sub.current_period_end > (now or utcnow())


def _subscriptions(db: Session, subject: Organization | Person | User) -> list[Subscription]:
    stmt = select(Subscription)
    if isinstance(subject, Organization):
        stmt = stmt.where(Subscription.organization_id == subject.id)
    elif isinstance(subject, Person):
        stmt = stmt.where(Subscription.person_id == subject.id)
    else:
        conds = [Subscription.user_id == subject.id]
        if subject.person_id is not None:
            conds.append(Subscription.person_id == subject.person_id)
        stmt = stmt.where(or_(*conds))
    return list(db.scalars(stmt.order_by(Subscription.id.desc())).all())


def current_subscription(db: Session, subject: Organization | Person | User) -> Subscription | None:
    """La suscripción vigente más reciente del sujeto (None si no tiene)."""
    now = utcnow()
    return next((s for s in _subscriptions(db, subject) if is_current(s, now)), None)


def features_of(db: Session, subject: Organization | Person | User) -> set[str]:
    """Funciones que el sujeto tiene por sus suscripciones vigentes (sin mirar el modo)."""
    now = utcnow()
    out: set[str] = set()
    for sub in _subscriptions(db, subject):
        if is_current(sub, now):
            plan = get_plan(db, sub.plan_code)
            out.update(plan.features if plan else [])
    return out


def has(db: Session, subject: Organization | Person | User | None, feature: str) -> bool:
    """¿El sujeto tiene la función? En marcha blanca, siempre."""
    if feature not in FEATURES:
        raise ValueError(f"Función desconocida: {feature}")
    if billing_mode() != "enforced":
        return True
    if subject is None:
        return False
    return feature in features_of(db, subject)


def required_plan(db: Session, feature: str, audience: str = "organization") -> Plan | None:
    """El plan más económico (que no sea la marcha blanca) que incluye la función."""
    for p in plans(db):
        if p.code != "marcha_blanca" and feature in (p.features or []) and p.audience in (audience, "all"):
            return p
    return None


def require(db: Session, user: User | None, subject: Organization | Person | None, feature: str) -> None:
    """Lanza 402 PLAN_REQUIRED si el sujeto no tiene la función (el Admin Global pasa siempre)."""
    if user is not None and user.is_admin:
        return
    if has(db, subject, feature):
        return
    audience = "person" if isinstance(subject, Person) else "organization"
    plan = required_plan(db, feature, audience)
    label = FEATURES[feature]
    who = f"la organización «{subject.name}»" if isinstance(subject, Organization) else "tu cuenta"
    raise PlanRequired(
        f"{label} requiere el plan {plan.name if plan else 'de pago'}: "
        f"{who} no tiene una suscripción vigente que lo incluya.",
        details={
            "feature": feature,
            "feature_name": label,
            "plan": plan.code if plan else None,
            "plan_name": plan.name if plan else None,
            "organization_id": subject.id if isinstance(subject, Organization) else None,
        },
    )


def require_for_tournament(db: Session, user: User | None, tournament, feature: str) -> None:
    """Atajo: la función se cobra a la organización dueña del torneo."""
    require(db, user, db.get(Organization, tournament.organization_id), feature)
