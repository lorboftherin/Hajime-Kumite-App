"""Organizaciones (multi-organizador), sus miembros y sus suscripciones."""

from __future__ import annotations

import re
import unicodedata

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api import schemas as s
from app.api.deps import ORG_ADMIN_ROLES, forget_roles, is_org_admin, memberships_of
from app.api.errors import Conflict, Forbidden, InvalidState, NotFound
from app.db.models import Organization, OrganizationMember, Person, Subscription, Tournament, User
from app.services import entitlements
from app.services.audit import audit, bump, check_version, snapshot

DEFAULT_SLUG = "principal"
DEFAULT_NAME = "Organización principal"


def slugify(text: str) -> str:
    t = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    t = re.sub(r"[^a-z0-9]+", "-", t).strip("-")
    return (t or "organizacion")[:70]


def _unique_slug(db: Session, base: str, exclude_id: int | None = None) -> str:
    slug, n = base, 1
    while True:
        stmt = select(Organization.id).where(Organization.slug == slug)
        found = db.scalar(stmt)
        if found is None or found == exclude_id:
            return slug
        n += 1
        slug = f"{base[:70]}-{n}"


def get_organization(db: Session, oid: int) -> Organization:
    o = db.get(Organization, oid)
    if o is None:
        raise NotFound("Organización no encontrada")
    return o


def default_organization(db: Session) -> Organization:
    """La organización principal (la crea la migración; si falta, se crea aquí)."""
    o = db.scalar(select(Organization).where(Organization.slug == DEFAULT_SLUG))
    if o is None:
        o = Organization(name=DEFAULT_NAME, slug=DEFAULT_SLUG, kind="organizer")
        db.add(o)
        db.flush()
    return o


def resolve_for_new_tournament(db: Session, user: User, organization_id: int | None) -> Organization:
    """Organización del torneo nuevo: la elegida o, si se omitió y no hay duda,
    la única que el usuario administra (Admin Global: la principal)."""
    from app.api.deps import can_create_tournament_in, is_organizer

    if organization_id is not None:
        org = get_organization(db, organization_id)
    else:
        mine = [oid for oid, role in memberships_of(db, user).items() if role in ORG_ADMIN_ROLES]
        if len(mine) == 1:
            org = get_organization(db, mine[0])
        elif not mine and is_organizer(db, user, None):
            # Admin u organizador global (compatibilidad): la organización principal.
            org = default_organization(db)
        elif not mine:
            raise Forbidden("Para crear torneos necesitas administrar una organización")
        else:
            raise InvalidState("Elige la organización del torneo", code="ORGANIZATION_REQUIRED")
    if not can_create_tournament_in(db, user, org.id):
        raise Forbidden("No administras esa organización: no puedes crear torneos en ella")
    return org


def subscription_out(db: Session, sub: Subscription) -> s.SubscriptionOut:
    out = s.SubscriptionOut.model_validate(sub)
    plan = entitlements.get_plan(db, sub.plan_code)
    out.plan_name = plan.name if plan else sub.plan_code
    out.is_current = entitlements.is_current(sub)
    out.recurring = entitlements.auto_renews(sub)
    out.in_grace = entitlements.in_grace(sub)
    out.access_until = entitlements.access_until(sub) if out.is_current else None
    return out


def organization_out(db: Session, user: User, o: Organization) -> s.OrganizationOut:
    out = s.OrganizationOut.model_validate(o)
    out.my_role = memberships_of(db, user).get(o.id)
    out.can_manage = is_org_admin(db, user, o.id)
    sub = entitlements.current_subscription(db, o)
    out.subscription = subscription_out(db, sub) if sub else None
    if entitlements.billing_mode() == "enforced":
        out.features = sorted(entitlements.features_of(db, o))
    else:
        out.features = sorted(entitlements.FEATURES)
    out.tournament_count = (
        db.scalar(select(func.count()).select_from(Tournament).where(Tournament.organization_id == o.id)) or 0
    )
    return out


def list_for(db: Session, user: User) -> list[Organization]:
    stmt = select(Organization).order_by(Organization.name)
    if not user.is_admin:
        ids = set(memberships_of(db, user))
        if not ids:
            return []
        stmt = stmt.where(Organization.id.in_(ids))
    return list(db.scalars(stmt).all())


def create(db: Session, user: User, data: s.OrganizationCreate) -> Organization:
    slug = data.slug or slugify(data.name)
    if data.slug and db.scalar(select(Organization.id).where(Organization.slug == slug)):
        raise Conflict("Ya existe una organización con ese identificador (slug)")
    slug = _unique_slug(db, slug)
    o = Organization(
        name=data.name.strip(),
        slug=slug,
        kind=data.kind,
        country=data.country.upper(),
        timezone=data.timezone,
        currency=data.currency.upper(),
        logo=data.logo or None,
        updated_by_id=user.id,
    )
    db.add(o)
    db.flush()
    if data.owner_user_id is not None:
        owner = db.get(User, data.owner_user_id)
        if owner is None:
            raise NotFound("Usuario no encontrado")
        db.add(OrganizationMember(organization_id=o.id, user_id=owner.id, role="owner"))
    audit(db, user, "organization", o.id, "create", after=snapshot(o))
    db.commit()
    forget_roles(db)
    db.refresh(o)
    return o


def update(db: Session, user: User, oid: int, data: s.OrganizationUpdate) -> Organization:
    o = get_organization(db, oid)
    check_version(o, data.version, "La organización")
    before = snapshot(o)
    changes = data.model_dump(exclude_unset=True, exclude={"version"})
    if "slug" in changes and changes["slug"] and changes["slug"] != o.slug:
        if db.scalar(select(Organization.id).where(Organization.slug == changes["slug"])):
            raise Conflict("Ya existe una organización con ese identificador (slug)")
    for k, v in changes.items():
        if v is None and k != "logo":
            continue
        if k in ("country", "currency"):
            v = v.upper()
        setattr(o, k, v)
    bump(o, user)
    audit(db, user, "organization", o.id, "update", before, snapshot(o))
    db.commit()
    db.refresh(o)
    return o


# --- Miembros --------------------------------------------------------------------


def members(db: Session, oid: int) -> list[s.MemberOut]:
    rows = db.execute(
        select(OrganizationMember, User)
        .join(User, User.id == OrganizationMember.user_id)
        .where(OrganizationMember.organization_id == oid)
        .order_by(User.username)
    ).all()
    return [s.MemberOut(user_id=u.id, username=u.username, display_name=u.display_name, role=m.role) for m, u in rows]


def _member(db: Session, oid: int, user_id: int) -> OrganizationMember:
    m = db.scalar(
        select(OrganizationMember).where(
            OrganizationMember.organization_id == oid, OrganizationMember.user_id == user_id
        )
    )
    if m is None:
        raise NotFound("El usuario no es miembro de la organización")
    return m


def _ensure_can_grant(db: Session, actor: User, oid: int, role: str) -> None:
    """Solo un owner (o el Admin Global) nombra o cambia owners."""
    if role == "owner" and not actor.is_admin and memberships_of(db, actor).get(oid) != "owner":
        raise Forbidden("Solo un dueño (owner) de la organización puede nombrar otro dueño")


def _owners(db: Session, oid: int) -> int:
    return (
        db.scalar(
            select(func.count())
            .select_from(OrganizationMember)
            .where(OrganizationMember.organization_id == oid, OrganizationMember.role == "owner")
        )
        or 0
    )


def add_member(db: Session, actor: User, oid: int, data: s.MemberIn) -> list[s.MemberOut]:
    get_organization(db, oid)
    if data.user_id is not None:
        u = db.get(User, data.user_id)
    elif data.username:
        u = db.scalar(select(User).where(User.username == data.username.strip().lower()))
    else:
        raise InvalidState("Indica el usuario a invitar")
    if u is None or not u.is_active:
        raise NotFound("No existe una cuenta activa con ese usuario")
    _ensure_can_grant(db, actor, oid, data.role)
    if db.scalar(
        select(OrganizationMember.id).where(
            OrganizationMember.organization_id == oid, OrganizationMember.user_id == u.id
        )
    ):
        raise Conflict("El usuario ya es miembro de la organización")
    db.add(OrganizationMember(organization_id=oid, user_id=u.id, role=data.role))
    audit(db, actor, "organization", oid, "add_member", after={"user_id": u.id, "role": data.role})
    db.commit()
    forget_roles(db)
    return members(db, oid)


def update_member(db: Session, actor: User, oid: int, user_id: int, role: str) -> list[s.MemberOut]:
    m = _member(db, oid, user_id)
    _ensure_can_grant(db, actor, oid, role)
    if m.role == "owner" and role != "owner":
        _ensure_can_grant(db, actor, oid, "owner")
        if _owners(db, oid) <= 1:
            raise Conflict("La organización debe tener al menos un dueño (owner)")
    before = m.role
    m.role = role
    audit(db, actor, "organization", oid, "update_member", {"user_id": user_id, "role": before}, {"role": role})
    db.commit()
    forget_roles(db)
    return members(db, oid)


def remove_member(db: Session, actor: User, oid: int, user_id: int) -> list[s.MemberOut]:
    m = _member(db, oid, user_id)
    if m.role == "owner":
        _ensure_can_grant(db, actor, oid, "owner")
        if _owners(db, oid) <= 1:
            raise Conflict("La organización debe tener al menos un dueño (owner)")
    audit(db, actor, "organization", oid, "remove_member", before={"user_id": user_id, "role": m.role})
    db.delete(m)
    db.commit()
    forget_roles(db)
    return members(db, oid)


# --- Suscripciones (manuales, Admin Global) -----------------------------------------


def create_subscription(db: Session, admin: User, data: s.SubscriptionCreate) -> Subscription:
    subjects = [x for x in (data.organization_id, data.person_id, data.user_id) if x is not None]
    if len(subjects) != 1:
        raise InvalidState("Indica una sola organización, persona o cuenta")
    plan = entitlements.get_plan(db, data.plan_code)
    if plan is None:
        raise NotFound("Plan no encontrado")
    if data.organization_id is not None:
        get_organization(db, data.organization_id)
        if plan.audience == "person":
            raise InvalidState("Ese plan es para personas, no para organizaciones")
    if data.person_id is not None and db.get(Person, data.person_id) is None:
        raise NotFound("Persona no encontrada")
    if data.user_id is not None and db.get(User, data.user_id) is None:
        raise NotFound("Usuario no encontrado")
    if (data.person_id is not None or data.user_id is not None) and plan.audience == "organization":
        raise InvalidState("Ese plan es para organizaciones")
    sub = Subscription(
        organization_id=data.organization_id,
        person_id=data.person_id,
        user_id=data.user_id,
        plan_code=plan.code,
        status=data.status,
        current_period_end=data.current_period_end,
        source="manual",
        notes=data.notes,
        created_by_id=admin.id,
    )
    db.add(sub)
    db.flush()
    audit(db, admin, "subscription", sub.id, "create", after=snapshot(sub))
    db.commit()
    db.refresh(sub)
    return sub


def update_subscription(db: Session, admin: User, sid: int, data: s.SubscriptionUpdate) -> Subscription:
    sub = get_subscription(db, sid)
    before = snapshot(sub)
    changes = data.model_dump(exclude_unset=True)
    if "plan_code" in changes and entitlements.get_plan(db, changes["plan_code"]) is None:
        raise NotFound("Plan no encontrado")
    for k, v in changes.items():
        if v is None and k != "current_period_end":
            continue
        setattr(sub, k, v)
    audit(db, admin, "subscription", sub.id, "update", before, snapshot(sub))
    db.commit()
    db.refresh(sub)
    return sub


def get_subscription(db: Session, sid: int) -> Subscription:
    sub = db.get(Subscription, sid)
    if sub is None:
        raise NotFound("Suscripción no encontrada")
    return sub
