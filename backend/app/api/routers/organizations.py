"""Organizaciones, miembros, planes, suscripciones y cobros.

Ver docs/organizaciones-y-planes.md.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.api import schemas as s
from app.api.deps import DB, AdminUser, CurrentUser, is_org_admin, is_org_member
from app.api.errors import Forbidden, NotFound
from app.db.models import Organization, Subscription
from app.services import entitlements, payments
from app.services import organizations as svc
from app.services.audit import audit

router = APIRouter()


def _ensure_member(db, user, oid: int) -> Organization:
    o = svc.get_organization(db, oid)
    if not is_org_member(db, user, oid):
        raise Forbidden("No eres miembro de esta organización")
    return o


def _ensure_manager(db, user, oid: int) -> Organization:
    o = svc.get_organization(db, oid)
    if not is_org_admin(db, user, oid):
        raise Forbidden("Solo el dueño o un administrador de la organización puede hacer esto")
    return o


# --- Organizaciones ----------------------------------------------------------------


@router.get("/organizations", response_model=list[s.OrganizationOut], tags=["organizations"])
def list_organizations(db: DB, user: CurrentUser):
    """Las organizaciones del usuario (todas para el Admin Global)."""
    return [svc.organization_out(db, user, o) for o in svc.list_for(db, user)]


@router.post("/organizations", response_model=s.OrganizationOut, status_code=201, tags=["organizations"])
def create_organization(data: s.OrganizationCreate, db: DB, admin: AdminUser):
    return svc.organization_out(db, admin, svc.create(db, admin, data))


@router.get("/organizations/{oid}", response_model=s.OrganizationOut, tags=["organizations"])
def get_organization(oid: int, db: DB, user: CurrentUser):
    return svc.organization_out(db, user, _ensure_member(db, user, oid))


@router.patch("/organizations/{oid}", response_model=s.OrganizationOut, tags=["organizations"])
def update_organization(oid: int, data: s.OrganizationUpdate, db: DB, user: CurrentUser):
    _ensure_manager(db, user, oid)
    return svc.organization_out(db, user, svc.update(db, user, oid, data))


@router.get("/organizations/{oid}/members", response_model=list[s.MemberOut], tags=["organizations"])
def list_members(oid: int, db: DB, user: CurrentUser):
    _ensure_member(db, user, oid)
    return svc.members(db, oid)


@router.post("/organizations/{oid}/members", response_model=list[s.MemberOut], status_code=201, tags=["organizations"])
def add_member(oid: int, data: s.MemberIn, db: DB, user: CurrentUser):
    """Invita a una cuenta existente (por usuario o id) con un rol."""
    _ensure_manager(db, user, oid)
    return svc.add_member(db, user, oid, data)


@router.patch("/organizations/{oid}/members/{user_id}", response_model=list[s.MemberOut], tags=["organizations"])
def update_member(oid: int, user_id: int, data: s.MemberUpdate, db: DB, user: CurrentUser):
    _ensure_manager(db, user, oid)
    return svc.update_member(db, user, oid, user_id, data.role)


@router.delete("/organizations/{oid}/members/{user_id}", response_model=list[s.MemberOut], tags=["organizations"])
def remove_member(oid: int, user_id: int, db: DB, user: CurrentUser):
    _ensure_manager(db, user, oid)
    return svc.remove_member(db, user, oid, user_id)


@router.get(
    "/organizations/{oid}/subscriptions", response_model=list[s.SubscriptionOut], tags=["organizations", "billing"]
)
def organization_subscriptions(oid: int, db: DB, user: CurrentUser):
    o = _ensure_member(db, user, oid)
    return [svc.subscription_out(db, x) for x in entitlements._subscriptions(db, o)]


# --- Planes ---------------------------------------------------------------------------


@router.get("/plans", response_model=s.PlansOut, tags=["billing"])
def list_plans(db: DB):
    """Niveles y precios (públicos). ``mode``: marcha_blanca (todo gratis) o enforced."""
    return s.PlansOut(
        mode=entitlements.billing_mode(),
        plans=[s.PlanOut.model_validate(p) for p in entitlements.plans(db)],
        features=entitlements.FEATURES,
    )


@router.patch("/plans/{code}", response_model=s.PlanOut, tags=["billing"])
def update_plan_prices(code: str, data: s.PlanPriceUpdate, db: DB, admin: AdminUser):
    """Cambia los precios de un plan (son configuración, no código)."""
    p = entitlements.get_plan(db, code)
    if p is None:
        raise NotFound("Plan no encontrado")

    def foto() -> dict:
        return {
            "month": float(p.price_pen_month or 0),
            "year": float(p.price_pen_year or 0),
            "trial_days": p.trial_days,
        }

    before = foto()
    for k, v in data.model_dump(exclude_unset=True).items():
        if k == "trial_days" and v is None:
            continue
        setattr(p, k, v)
    audit(db, admin, "plan", code, "update_prices", before, foto())
    db.commit()
    db.refresh(p)
    return p


# --- Suscripciones ------------------------------------------------------------------------


@router.get("/subscriptions", response_model=list[s.SubscriptionOut], tags=["billing"])
def list_subscriptions(
    db: DB, _: AdminUser, organization_id: int | None = None, person_id: int | None = None, user_id: int | None = None
):
    from sqlalchemy import select

    stmt = select(Subscription).order_by(Subscription.id.desc())
    if organization_id is not None:
        stmt = stmt.where(Subscription.organization_id == organization_id)
    if person_id is not None:
        stmt = stmt.where(Subscription.person_id == person_id)
    if user_id is not None:
        stmt = stmt.where(Subscription.user_id == user_id)
    return [svc.subscription_out(db, x) for x in db.scalars(stmt.limit(500)).all()]


@router.post("/subscriptions", response_model=s.SubscriptionOut, status_code=201, tags=["billing"])
def create_subscription(data: s.SubscriptionCreate, db: DB, admin: AdminUser):
    """Suscripción manual: el Admin Global asigna un plan a una organización, persona o cuenta."""
    return svc.subscription_out(db, svc.create_subscription(db, admin, data))


@router.patch("/subscriptions/{sid}", response_model=s.SubscriptionOut, tags=["billing"])
def update_subscription(sid: int, data: s.SubscriptionUpdate, db: DB, admin: AdminUser):
    return svc.subscription_out(db, svc.update_subscription(db, admin, sid, data))


@router.post("/subscriptions/{sid}/mark-paid", response_model=s.SubscriptionOut, tags=["billing"])
def mark_paid(sid: int, data: s.MarkPaidIn, db: DB, admin: AdminUser):
    """Proveedor manual: el Admin confirma el pago y la suscripción queda activa un mes o un año."""
    sub = svc.get_subscription(db, sid)
    payments.mark_paid(db, admin, sub, data.period, data.reference)
    db.commit()
    db.refresh(sub)
    return svc.subscription_out(db, sub)
