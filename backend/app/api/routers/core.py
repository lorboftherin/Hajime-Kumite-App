"""Auth, personas, dojos, plantillas y auditoría."""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Query
from sqlalchemy import or_, select

from app.api import schemas as s
from app.api.deps import DB, AdminUser, CurrentUser, ensure_organizer
from app.api.errors import Conflict, NotFound, Unauthorized
from app.db.models import AuditEntry, CategoryTemplate, Dojo, IdentityDocument, Person, RuleOverride, User
from app.domain.identity import normalize_document, normalize_name
from app.security import create_token, hash_password, verify_password
from app.services import people
from app.services.audit import audit, bump, check_version, snapshot
from app.services.tournaments import create_template

router = APIRouter()


# --- Auth -------------------------------------------------------------------


@router.post("/auth/login", response_model=s.TokenOut, tags=["auth"])
def login(data: s.LoginIn, db: DB):
    u = db.scalar(select(User).where(User.username == data.username.strip().lower()))
    if u is None or not u.is_active or not verify_password(data.password, u.password_hash):
        raise Unauthorized("Usuario o contraseña incorrectos")
    return s.TokenOut(access_token=create_token(u.id), user=s.UserOut.model_validate(u))


@router.get("/auth/me", response_model=s.UserOut, tags=["auth"])
def me(user: CurrentUser):
    return user


@router.get("/users", response_model=list[s.UserOut], tags=["auth"])
def list_users(db: DB, _: AdminUser):
    return db.scalars(select(User).order_by(User.username)).all()


@router.post("/users", response_model=s.UserOut, status_code=201, tags=["auth"])
def create_user(data: s.UserCreate, db: DB, admin: AdminUser):
    username = data.username.strip().lower()
    if db.scalar(select(User).where(User.username == username)):
        raise Conflict("El usuario ya existe")
    u = User(
        username=username,
        password_hash=hash_password(data.password),
        display_name=data.display_name or username,
        is_admin=data.is_admin,
        person_id=data.person_id,
    )
    db.add(u)
    db.flush()
    audit(db, admin, "user", u.id, "create", after={"username": username, "is_admin": data.is_admin})
    db.commit()
    return u


# --- Dojos --------------------------------------------------------------------


@router.get("/dojos", response_model=list[s.DojoOut], tags=["dojos"])
def list_dojos(db: DB, _: CurrentUser, q: str | None = None):
    rows = db.scalars(select(Dojo).order_by(Dojo.name)).all()
    if q:
        nq = normalize_name(q)
        rows = [d for d in rows if nq in normalize_name(d.name) or nq in normalize_name(d.short_name)]
    return rows


@router.post("/dojos", response_model=s.DojoOut, status_code=201, tags=["dojos"])
def create_dojo(data: s.DojoCreate, db: DB, user: CurrentUser):
    return people.create_dojo(db, user, data)


@router.get("/dojos/{dojo_id}", response_model=s.DojoOut, tags=["dojos"])
def get_dojo(dojo_id: int, db: DB, _: CurrentUser):
    return people.get_dojo(db, dojo_id)


@router.patch("/dojos/{dojo_id}", response_model=s.DojoOut, tags=["dojos"])
def update_dojo(dojo_id: int, data: s.DojoUpdate, db: DB, user: CurrentUser):
    d = people.get_dojo(db, dojo_id)
    check_version(d, data.version, "El dojo")
    before = snapshot(d)
    for k, v in data.model_dump(exclude_unset=True, exclude={"version"}).items():
        setattr(d, k, v)
    bump(d, user)
    audit(db, user, "dojo", d.id, "update", before, snapshot(d))
    db.commit()
    db.refresh(d)
    return d


@router.post("/dojos/{dojo_id}/branches", response_model=s.DojoOut, status_code=201, tags=["dojos"])
def add_branch(dojo_id: int, data: s.BranchIn, db: DB, user: CurrentUser):
    from app.db.models import Branch

    d = people.get_dojo(db, dojo_id)
    db.add(Branch(dojo_id=d.id, name=data.name.strip()))
    audit(db, user, "dojo", d.id, "add_branch", after={"name": data.name})
    db.commit()
    db.refresh(d)
    return d


# --- Personas -----------------------------------------------------------------


@router.get("/persons", response_model=list[s.PersonOut], tags=["persons"])
def list_persons(
    db: DB,
    _: CurrentUser,
    q: str | None = None,
    dojo_id: int | None = None,
    limit: int = Query(50, le=500),
):
    stmt = select(Person).where(Person.merged_into_id.is_(None))
    if q:
        nq = normalize_name(q)
        doc = normalize_document(q)
        stmt = stmt.outerjoin(IdentityDocument).where(
            or_(Person.normalized_name.contains(nq), IdentityDocument.normalized_number == doc)
        )
    rows = list(db.scalars(stmt.order_by(Person.last_names, Person.first_names).limit(limit * 3)).unique().all())
    out = [people.person_out(db, p) for p in rows]
    if dojo_id:
        out = [p for p in out if p.current_dojo_id == dojo_id]
    return out[:limit]


@router.get("/persons/duplicates", response_model=list[s.DuplicateOut], tags=["persons"])
def check_duplicates(
    db: DB,
    _: CurrentUser,
    first_names: str,
    last_names: str,
    birth_date: date | None = None,
    doc_type: str | None = None,
    doc_number: str | None = None,
):
    return people.detect_duplicates(db, first_names, last_names, birth_date, doc_type, doc_number)


@router.post("/persons", response_model=s.PersonOut, status_code=201, tags=["persons"])
def create_person(data: s.PersonCreate, db: DB, user: CurrentUser):
    return people.person_out(db, people.create_person(db, user, data))


@router.get("/persons/{person_id}", response_model=s.PersonOut, tags=["persons"])
def get_person(person_id: int, db: DB, _: CurrentUser):
    return people.person_out(db, people.get_person(db, person_id))


@router.patch("/persons/{person_id}", response_model=s.PersonOut, tags=["persons"])
def update_person(person_id: int, data: s.PersonUpdate, db: DB, user: CurrentUser):
    return people.person_out(db, people.update_person(db, user, person_id, data))


@router.post("/persons/{person_id}/grades", status_code=201, tags=["persons"])
def add_grade(person_id: int, data: s.GradeIn, db: DB, user: CurrentUser):
    g = people.add_grade(db, user, person_id, data)
    return {"id": g.id, "grade": g.grade, "awarded_on": g.awarded_on}


@router.post("/persons/{person_id}/memberships", status_code=201, tags=["persons"])
def change_dojo(person_id: int, data: s.MembershipIn, db: DB, user: CurrentUser):
    m = people.change_dojo(db, user, person_id, data)
    return {"id": m.id, "dojo_id": m.dojo_id, "start_date": m.start_date}


@router.post("/persons/merge", tags=["persons"])
def merge_persons(data: s.PersonMergeIn, db: DB, admin: AdminUser):
    pm = people.merge_persons(db, admin, data)
    return {
        "id": pm.id,
        "kept_person_id": pm.kept_person_id,
        "merged_person_id": pm.merged_person_id,
        "moved": pm.moved,
    }


@router.post("/persons/merges/{merge_id}/revert", tags=["persons"])
def revert_merge(merge_id: int, db: DB, admin: AdminUser):
    pm = people.revert_merge(db, admin, merge_id)
    return {"id": pm.id, "reverted_at": pm.reverted_at}


# --- Plantillas -----------------------------------------------------------------


@router.get("/templates", response_model=list[s.TemplateOut], tags=["templates"])
def list_templates(db: DB, _: CurrentUser):
    return db.scalars(select(CategoryTemplate).order_by(CategoryTemplate.name)).all()


@router.post("/templates", response_model=s.TemplateOut, status_code=201, tags=["templates"])
def new_template(data: s.TemplateCreate, db: DB, admin: AdminUser):
    return create_template(db, admin, data)


@router.get("/templates/{template_id}", response_model=s.TemplateOut, tags=["templates"])
def get_template(template_id: int, db: DB, _: CurrentUser):
    t = db.get(CategoryTemplate, template_id)
    if t is None:
        raise NotFound("Plantilla no encontrada")
    return t


# --- Auditoría ------------------------------------------------------------------


@router.get("/audit", tags=["audit"])
def audit_log(
    db: DB,
    user: CurrentUser,
    tournament_id: int | None = None,
    entity: str | None = None,
    entity_id: str | None = None,
    limit: int = Query(200, le=1000),
):
    if tournament_id is not None:
        ensure_organizer(db, user, tournament_id)
    elif not user.is_admin:
        ensure_organizer(db, user, -1)
    stmt = select(AuditEntry).order_by(AuditEntry.id.desc()).limit(limit)
    if tournament_id is not None:
        stmt = stmt.where(AuditEntry.tournament_id == tournament_id)
    if entity:
        stmt = stmt.where(AuditEntry.entity == entity)
    if entity_id:
        stmt = stmt.where(AuditEntry.entity_id == entity_id)
    users = {u.id: u.username for u in db.scalars(select(User)).all()}
    return [
        {
            "id": a.id,
            "at": a.at,
            "user": users.get(a.user_id),
            "entity": a.entity,
            "entity_id": a.entity_id,
            "action": a.action,
            "before": a.before,
            "after": a.after,
            "reason": a.reason,
        }
        for a in db.scalars(stmt).all()
    ]


@router.get("/overrides", tags=["audit"])
def overrides(db: DB, _: CurrentUser, entity: str, entity_id: int):
    rows = db.scalars(
        select(RuleOverride).where(RuleOverride.entity == entity, RuleOverride.entity_id == entity_id)
    ).all()
    return [
        {"code": r.code, "message": r.message, "reason": r.reason, "user_id": r.user_id, "at": r.created_at}
        for r in rows
    ]
