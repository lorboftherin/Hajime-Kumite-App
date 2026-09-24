"""Auth, personas, dojos, plantillas y auditoría."""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Query, Request
from sqlalchemy import or_, select

from app.api import schemas as s
from app.api.deps import (
    DB,
    ROLES,
    AdminUser,
    CurrentUser,
    can_view_documents,
    ensure_organizer,
    ensure_staff,
    roles_of,
)
from app.api.errors import Conflict, NotFound, TooManyRequests, Unauthorized
from app.db.models import AuditEntry, CategoryTemplate, Dojo, IdentityDocument, Person, PersonRole, RuleOverride, User
from app.domain.identity import normalize_document, normalize_name
from app.security import (
    clear_login_failures,
    create_token,
    hash_password,
    login_locked_for,
    register_login_failure,
    verify_password,
)
from app.services import people
from app.services.audit import audit, bump, check_version, snapshot
from app.services.tournaments import create_template

router = APIRouter()


# --- Auth -------------------------------------------------------------------


@router.post("/auth/login", response_model=s.TokenOut, tags=["auth"])
def login(data: s.LoginIn, db: DB, request: Request):
    username = data.username.strip().lower()
    key = f"{username}|{request.client.host if request.client else '-'}"
    wait = login_locked_for(key)
    if wait:
        raise TooManyRequests(f"Demasiados intentos fallidos. Intenta de nuevo en {wait // 60 + 1} min.")
    u = db.scalar(select(User).where(User.username == username))
    if u is None or not u.is_active or not verify_password(data.password, u.password_hash):
        register_login_failure(key)
        raise Unauthorized("Usuario o contraseña incorrectos")
    clear_login_failures(key)
    return s.TokenOut(access_token=create_token(u.id, u.token_version or 0), user=user_out(db, u))


@router.post("/auth/change-password", response_model=s.TokenOut, tags=["auth"])
def change_password(data: s.PasswordChange, db: DB, user: CurrentUser):
    """Cambia la contraseña propia. Invalida las demás sesiones y devuelve un token nuevo."""
    if not verify_password(data.current_password, user.password_hash):
        raise Unauthorized("La contraseña actual no es correcta")
    if data.new_password == data.current_password:
        raise Conflict("La nueva contraseña debe ser distinta")
    user.password_hash = hash_password(data.new_password)
    user.token_version = (user.token_version or 0) + 1
    user.must_change_password = False
    audit(db, user, "user", user.id, "change_password")
    db.commit()
    return s.TokenOut(access_token=create_token(user.id, user.token_version), user=user_out(db, user))


def user_out(db, u: User) -> s.UserOut:
    out = s.UserOut.model_validate(u)
    out.roles = [s.RoleOut.model_validate(r) for r in roles_of(db, u)]
    out.can_view_documents = can_view_documents(db, u)
    return out


@router.get("/auth/me", response_model=s.UserOut, tags=["auth"])
def me(user: CurrentUser, db: DB):
    return user_out(db, user)


@router.get("/persons/{person_id}/roles", response_model=list[s.RoleOut], tags=["auth"])
def list_roles(person_id: int, db: DB, _: AdminUser):
    people.get_person(db, person_id)
    return db.scalars(select(PersonRole).where(PersonRole.person_id == person_id)).all()


@router.post("/persons/{person_id}/roles", response_model=s.RoleOut, status_code=201, tags=["auth"])
def add_role(person_id: int, data: s.RoleIn, db: DB, admin: AdminUser):
    people.get_person(db, person_id)
    if data.scope_type != "global" and data.scope_id is None:
        raise Conflict("Un rol por torneo o por dojo necesita scope_id")
    if data.role not in ROLES:
        raise Conflict("Rol desconocido")
    r = PersonRole(person_id=person_id, role=data.role, scope_type=data.scope_type, scope_id=data.scope_id)
    db.add(r)
    db.flush()
    audit(db, admin, "person", person_id, "add_role", after=data.model_dump())
    db.commit()
    return r


@router.delete("/roles/{role_id}", status_code=204, tags=["auth"])
def remove_role(role_id: int, db: DB, admin: AdminUser):
    r = db.get(PersonRole, role_id)
    if r is None:
        raise NotFound("Rol no encontrado")
    audit(db, admin, "person", r.person_id, "remove_role", before={"role": r.role, "scope": r.scope_type})
    db.delete(r)
    db.commit()


@router.get("/users", response_model=list[s.UserOut], tags=["auth"])
def list_users(db: DB, _: AdminUser):
    return [user_out(db, u) for u in db.scalars(select(User).order_by(User.username)).all()]


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
        must_change_password=True,  # la clave la eligió el Admin
    )
    db.add(u)
    db.flush()
    audit(db, admin, "user", u.id, "create", after={"username": username, "is_admin": data.is_admin})
    db.commit()
    return user_out(db, u)


@router.patch("/users/{user_id}", response_model=s.UserOut, tags=["auth"])
def update_user(user_id: int, data: s.UserAdminUpdate, db: DB, admin: AdminUser):
    u = db.get(User, user_id)
    if u is None:
        raise NotFound("Usuario no encontrado")
    changes = data.model_dump(exclude_unset=True)
    if u.id == admin.id and (changes.get("is_active") is False or changes.get("is_admin") is False):
        raise Conflict("No puedes desactivarte ni quitarte el rol de Admin a ti mismo")
    before = {k: getattr(u, k) for k in ("is_active", "is_admin", "display_name", "person_id")}
    for k in ("is_active", "is_admin", "display_name", "person_id"):
        if k in changes:
            setattr(u, k, changes[k])
    if data.reset_password:
        u.password_hash = hash_password(data.reset_password)
        u.must_change_password = True
    if data.reset_password or changes.get("is_active") is False:
        u.token_version = (u.token_version or 0) + 1  # cierra sus sesiones abiertas
    after = {k: getattr(u, k) for k in ("is_active", "is_admin", "display_name", "person_id")}
    if data.reset_password:
        after["password"] = "reseteada"
    audit(db, admin, "user", u.id, "update", before, after)
    db.commit()
    return user_out(db, u)


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
    ensure_staff(db, user)
    return people.create_dojo(db, user, data)


@router.get("/dojos/{dojo_id}", response_model=s.DojoOut, tags=["dojos"])
def get_dojo(dojo_id: int, db: DB, _: CurrentUser):
    return people.get_dojo(db, dojo_id)


@router.patch("/dojos/{dojo_id}", response_model=s.DojoOut, tags=["dojos"])
def update_dojo(dojo_id: int, data: s.DojoUpdate, db: DB, user: CurrentUser):
    ensure_staff(db, user)
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

    ensure_staff(db, user)
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
    user: CurrentUser,
    q: str | None = None,
    dojo_id: int | None = None,
    limit: int = Query(50, le=500),
):
    privileged = can_view_documents(db, user)
    stmt = select(Person).where(Person.merged_into_id.is_(None))
    if q:
        nq = normalize_name(q)
        if privileged:
            # Solo quien puede ver documentos puede buscar por documento.
            doc = normalize_document(q)
            stmt = stmt.outerjoin(IdentityDocument).where(
                or_(Person.normalized_name.contains(nq), IdentityDocument.normalized_number == doc)
            )
        else:
            stmt = stmt.where(Person.normalized_name.contains(nq))
    rows = list(db.scalars(stmt.order_by(Person.last_names, Person.first_names).limit(limit * 3)).unique().all())
    out = people.persons_out(db, rows, privileged)
    if dojo_id:
        out = [p for p in out if p.current_dojo_id == dojo_id]
    return out[:limit]


@router.get("/persons/duplicates", response_model=list[s.DuplicateOut], tags=["persons"])
def check_duplicates(
    db: DB,
    user: CurrentUser,
    first_names: str,
    last_names: str,
    birth_date: date | None = None,
    doc_type: str | None = None,
    doc_number: str | None = None,
):
    ensure_staff(db, user)
    return people.detect_duplicates(db, first_names, last_names, birth_date, doc_type, doc_number)


@router.post("/persons", response_model=s.PersonOut, status_code=201, tags=["persons"])
def create_person(data: s.PersonCreate, db: DB, user: CurrentUser):
    ensure_staff(db, user)
    return people.person_out(db, people.create_person(db, user, data), True)


@router.get("/persons/{person_id}", response_model=s.PersonOut, tags=["persons"])
def get_person(person_id: int, db: DB, user: CurrentUser):
    return people.person_out(db, people.get_person(db, person_id), can_view_documents(db, user))


@router.patch("/persons/{person_id}", response_model=s.PersonOut, tags=["persons"])
def update_person(person_id: int, data: s.PersonUpdate, db: DB, user: CurrentUser):
    ensure_staff(db, user)
    return people.person_out(db, people.update_person(db, user, person_id, data), True)


@router.post("/persons/{person_id}/grades", status_code=201, tags=["persons"])
def add_grade(person_id: int, data: s.GradeIn, db: DB, user: CurrentUser):
    ensure_staff(db, user)
    g = people.add_grade(db, user, person_id, data)
    return {"id": g.id, "grade": g.grade, "awarded_on": g.awarded_on}


@router.post("/persons/{person_id}/memberships", status_code=201, tags=["persons"])
def change_dojo(person_id: int, data: s.MembershipIn, db: DB, user: CurrentUser):
    ensure_staff(db, user)
    m = people.change_dojo(db, user, person_id, data)
    return {"id": m.id, "dojo_id": m.dojo_id, "start_date": m.start_date}


@router.post("/persons/{person_id}/consents", response_model=s.ConsentOut, status_code=201, tags=["persons"])
def add_consent(person_id: int, data: s.ConsentIn, db: DB, user: CurrentUser):
    ensure_staff(db, user)
    return people.add_consent(db, user, person_id, data)


@router.post("/persons/{person_id}/anonymize", response_model=s.PersonOut, tags=["persons"])
def anonymize(person_id: int, data: s.AnonymizeIn, db: DB, admin: AdminUser):
    """Derecho de cancelación (ARCO): anonimiza sin borrar combates."""
    return people.person_out(db, people.anonymize_person(db, admin, person_id, data.reason), True)


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
    else:
        ensure_staff(db, user)
    stmt = select(AuditEntry).order_by(AuditEntry.id.desc()).limit(limit)
    if not user.is_admin:
        # Las fotos antes/después de personas contienen datos personales.
        stmt = stmt.where(AuditEntry.entity != "person")
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
def overrides(db: DB, user: CurrentUser, entity: str, entity_id: int):
    ensure_staff(db, user)
    rows = db.scalars(
        select(RuleOverride).where(RuleOverride.entity == entity, RuleOverride.entity_id == entity_id)
    ).all()
    return [
        {"code": r.code, "message": r.message, "reason": r.reason, "user_id": r.user_id, "at": r.created_at}
        for r in rows
    ]
