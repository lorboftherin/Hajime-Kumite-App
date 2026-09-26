"""Auth, personas, dojos, plantillas y auditoría."""

from __future__ import annotations

import secrets
from datetime import date

from fastapi import APIRouter, Depends, Query, Request
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy import delete, func, or_, select

from app.api import schemas as s
from app.api.deps import (
    DB,
    ROLES,
    AdminUser,
    CurrentUser,
    StaffUser,
    _bearer,
    can_view_documents,
    dojo_admin_ids,
    ensure_organizer,
    ensure_staff,
    forget_roles,
    memberships_of,
    roles_of,
)
from app.api.errors import Conflict, Forbidden, NotFound, TooManyRequests, Unauthorized
from app.db.models import (
    AuditEntry,
    Bracket,
    Category,
    Dojo,
    Guardianship,
    IdentityDocument,
    Match,
    Organization,
    Person,
    PersonRole,
    Registration,
    RuleOverride,
    Tatami,
    Tournament,
    User,
    UserSession,
)
from app.domain.identity import normalize_document, normalize_name
from app.security import burn_password_check, decode_token, hash_password, password_needs_rehash, verify_password
from app.services import accounts, people, sessions
from app.services.audit import audit, bump, check_version, snapshot
from app.services.login_guard import clear_login_failures, login_locked_for, register_login_failure

router = APIRouter()


# --- Auth -------------------------------------------------------------------


@router.post("/auth/login", response_model=s.TokenOut, tags=["auth"])
def login(data: s.LoginIn, db: DB, request: Request):
    username = data.username.strip().lower()
    # IP real del cliente: uvicorn la toma de X-Forwarded-For (--forwarded-allow-ips).
    ip = request.client.host if request.client else "-"
    wait = login_locked_for(db, username, ip)
    if wait:
        raise TooManyRequests(f"Demasiados intentos fallidos. Intenta de nuevo en {wait // 60 + 1} min.")
    u = db.scalar(select(User).where(User.username == username))
    if u is None and "@" in username:
        # Las cuentas de competidor entran con su correo.
        u = db.scalar(select(User).where(User.email == username))
    if u is None:
        burn_password_check(data.password)  # mismo tiempo de respuesta que con un usuario real
    if u is None or not u.is_active or not verify_password(data.password, u.password_hash):
        register_login_failure(db, username, ip)
        raise Unauthorized("Usuario o contraseña incorrectos")
    if password_needs_rehash(u.password_hash):
        # Hash con otro coste (p. ej. de antes de bajar las iteraciones): se rehace ahora
        # que se conoce la contraseña; el usuario no nota nada.
        u.password_hash = hash_password(data.password)
    clear_login_failures(db, username, ip)
    return issue_tokens(db, u, request)


def issue_tokens(db, u: User, request: Request | None) -> s.TokenOut:
    """Abre una sesión (fila en ``user_sessions``) y devuelve sus tokens."""
    sess, refresh_token = sessions.open_session(db, u, request)
    db.commit()
    return sessions.tokens_out(u, sess, refresh_token, user_out(db, u))


@router.post("/auth/refresh", response_model=s.TokenOut, tags=["auth"])
def refresh(data: s.RefreshIn, db: DB, request: Request):
    """Renueva el token de acceso. El token de renovación se rota: guarda el nuevo."""
    u, sess, refresh_token = sessions.refresh(db, data.refresh_token, request)
    return sessions.tokens_out(u, sess, refresh_token, user_out(db, u))


@router.post("/auth/logout", status_code=204, tags=["auth"])
def logout(
    db: DB,
    data: s.LogoutIn | None = None,
    cred: HTTPAuthorizationCredentials | None = Depends(_bearer),
):
    """Cierra esta sesión. Sirve con el token de acceso, con el de renovación o con ambos
    (el de acceso puede haber vencido)."""
    targets = []
    claims = decode_token(cred.credentials) if cred else None
    if claims and claims.session_id is not None:
        sess = db.get(UserSession, claims.session_id)
        if sess is not None and sess.user_id == claims.user_id:
            targets.append(sess)
    if data and data.refresh_token:
        sess = sessions.by_refresh_token(db, data.refresh_token)
        if sess is not None:
            targets.append(sess)
    for sess in targets:
        sessions.revoke(db, sess)
    db.commit()


@router.get("/auth/sessions", response_model=list[s.SessionOut], tags=["auth"])
def my_sessions(db: DB, user: CurrentUser, request: Request):
    """Sesiones abiertas de la propia cuenta (dispositivo, IP y último uso)."""
    current = getattr(request.state, "session_id", None)
    out = []
    for sess in sessions.active_sessions(db, user.id):
        o = s.SessionOut.model_validate(sess)
        o.current = sess.id == current
        out.append(o)
    return out


@router.delete("/auth/sessions/{session_id}", status_code=204, tags=["auth"])
def close_session(session_id: int, db: DB, user: CurrentUser):
    sess = db.get(UserSession, session_id)
    if sess is None or sess.user_id != user.id:
        raise NotFound("Sesión no encontrada")
    sessions.revoke(db, sess)
    db.commit()


@router.delete("/users/{user_id}/sessions", status_code=204, tags=["auth"])
def close_user_sessions(user_id: int, db: DB, admin: AdminUser):
    """El Admin cierra todas las sesiones de una cuenta (p. ej. tablet perdida)."""
    u = db.get(User, user_id)
    if u is None:
        raise NotFound("Usuario no encontrado")
    n = sessions.revoke_all(db, u.id)
    audit(db, admin, "user", u.id, "close_sessions", after={"sessions": n})
    db.commit()


@router.post("/auth/change-password", response_model=s.TokenOut, tags=["auth"])
def change_password(data: s.PasswordChange, db: DB, user: CurrentUser, request: Request):
    """Cambia la contraseña propia. Cierra todas las sesiones y abre una nueva en este dispositivo."""
    if not verify_password(data.current_password, user.password_hash):
        raise Unauthorized("La contraseña actual no es correcta")
    if data.new_password == data.current_password:
        raise Conflict("La nueva contraseña debe ser distinta")
    user.password_hash = hash_password(data.new_password)
    user.token_version = (user.token_version or 0) + 1
    user.must_change_password = False
    sessions.revoke_all(db, user.id)
    audit(db, user, "user", user.id, "change_password")
    return issue_tokens(db, user, request)


def user_out(db, u: User) -> s.UserOut:
    out = s.UserOut.model_validate(u)
    out.roles = [s.RoleOut.model_validate(r) for r in roles_of(db, u)]
    out.can_view_documents = can_view_documents(db, u)
    mine = memberships_of(db, u)
    if mine:
        rows = db.scalars(select(Organization).where(Organization.id.in_(mine)).order_by(Organization.name)).all()
        out.organizations = [s.UserOrganizationOut(id=o.id, name=o.name, slug=o.slug, role=mine[o.id]) for o in rows]
    out.dojo_admin_of = sorted(dojo_admin_ids(db, u))
    return out


@router.post("/auth/delete-account", status_code=204, tags=["auth"])
def delete_account(data: s.AccountDelete, db: DB, user: CurrentUser):
    """Borra la propia cuenta de acceso (Google Play y App Store lo exigen).

    La cuenta queda desactivada y sin datos identificativos, y se cierran sus
    sesiones. La persona ligada y su historial deportivo no se tocan: son
    del torneo y del dojo (sección 11); borrarlos es «anonimizar persona».
    """
    if not verify_password(data.password, user.password_hash):
        raise Unauthorized("La contraseña no es correcta")
    if user.is_admin:
        admins = db.scalar(select(func.count()).select_from(User).where(User.is_admin, User.is_active))
        if (admins or 0) <= 1:
            raise Conflict("Eres el único administrador activo: nombra otro antes de borrar tu cuenta")
    before = {"username": user.username, "person_id": user.person_id}
    user.username = f"cuenta-borrada-{user.id}"
    user.display_name = ""
    user.password_hash = hash_password(secrets.token_urlsafe(32))
    user.person_id = None
    user.email = None
    user.email_verified_at = None
    # Deja de ser padre, madre o apoderado verificado de cualquier menor.
    db.execute(delete(Guardianship).where(Guardianship.user_id == user.id))
    user.is_active = False
    user.token_version = (user.token_version or 0) + 1
    sessions.revoke_all(db, user.id)
    audit(db, user, "user", user.id, "delete_account", before=before)
    db.commit()


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
    if data.scope_type == "tatami" and data.role != "table_operator":
        raise Conflict("Solo el operador de mesa se asigna a un tatami")
    if data.scope_type == "organization" and data.role not in ("organizer", "table_operator", "referee"):
        raise Conflict("Ese rol no tiene ámbito de organización")
    if data.role == "dojo_admin" and data.scope_type != "dojo":
        raise Conflict("El admin de dojo se registra en su dojo")
    if data.role == "sensei" and data.scope_type not in ("dojo", "global"):
        raise Conflict("El sensei se registra en su dojo")
    scope_model = {
        "tournament": (Tournament, "Torneo"),
        "dojo": (Dojo, "Dojo"),
        "tatami": (Tatami, "Tatami"),
        "organization": (Organization, "Organización"),
    }
    if data.scope_type in scope_model:
        model, label = scope_model[data.scope_type]
        if db.get(model, data.scope_id) is None:
            raise NotFound(f"{label} no encontrado")
    r = PersonRole(person_id=person_id, role=data.role, scope_type=data.scope_type, scope_id=data.scope_id)
    db.add(r)
    db.flush()
    forget_roles(db)
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
    forget_roles(db)


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
    if data.email:
        accounts.set_email(db, admin, u, data.email)
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
    if "email" in changes:
        accounts.set_email(db, admin, u, changes["email"] or None)
    if data.reset_password:
        u.password_hash = hash_password(data.reset_password)
        u.must_change_password = True
    if data.reset_password or changes.get("is_active") is False:
        u.token_version = (u.token_version or 0) + 1  # invalida los tokens de acceso emitidos
        sessions.revoke_all(db, u.id)  # y cierra sus sesiones (no podrá renovarlas)
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
    user: StaffUser,
    q: str | None = None,
    dojo_id: int | None = None,
    limit: int = Query(50, le=500),
):
    """Lista y búsqueda de personas: solo Admin y organizadores (sección 11)."""
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
    """Ficha de una persona: Admin y organizadores, el admin de su dojo actual
    (con documentos), o la propia persona (sin documentos)."""
    privileged = can_view_documents(db, user)
    p = people.get_person(db, person_id)
    if not privileged and dojo_admin_ids(db, user):
        m = people.current_membership(db, p.id)
        privileged = m is not None and m.dojo_id in dojo_admin_ids(db, user)
    if not privileged and user.person_id != person_id:
        raise Forbidden("Solo los organizadores ven fichas de otras personas")
    out = people.person_out(db, p, privileged)
    if privileged and (out.documents or out.birth_date):
        people.log_sensitive_view(db, user, p.id)
    return out


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


# --- Auditoría ------------------------------------------------------------------


# Entidades cuyas fotos antes/después contienen datos personales: fuera del
# Admin se muestran sin contenido (queda quién, cuándo y qué acción).
PERSONAL_ENTITIES = ("person", "registration", "team", "referee_assignment")
REDACTED = {"redacted": True}


@router.get("/audit", tags=["audit"])
def audit_log(
    db: DB,
    user: CurrentUser,
    tournament_id: int | None = None,
    entity: str | None = None,
    entity_id: str | None = None,
    limit: int = Query(200, le=1000),
):
    """Sin ``tournament_id``: solo el Admin. Con él: los organizadores de ese torneo."""
    if tournament_id is not None:
        ensure_organizer(db, user, tournament_id)
    elif not user.is_admin:
        raise Forbidden("Solo el Admin Global ve la auditoría completa")
    stmt = select(AuditEntry).order_by(AuditEntry.id.desc()).limit(limit)
    if not user.is_admin:
        # Las fotos de personas nunca salen del Admin (ni siquiera redactadas).
        stmt = stmt.where(AuditEntry.entity != "person")
    if tournament_id is not None:
        stmt = stmt.where(AuditEntry.tournament_id == tournament_id)
    if entity:
        stmt = stmt.where(AuditEntry.entity == entity)
    if entity_id:
        stmt = stmt.where(AuditEntry.entity_id == entity_id)
    rows = db.scalars(stmt).all()
    ids = {a.user_id for a in rows if a.user_id is not None}
    users = dict(db.execute(select(User.id, User.username).where(User.id.in_(ids))).all()) if ids else {}
    out = []
    for a in rows:
        hide = not user.is_admin and a.entity in PERSONAL_ENTITIES
        out.append(
            {
                "id": a.id,
                "at": a.at,
                "user": users.get(a.user_id),
                "entity": a.entity,
                "entity_id": a.entity_id,
                "action": a.action,
                "before": REDACTED if hide and a.before is not None else a.before,
                "after": REDACTED if hide and a.after is not None else a.after,
                "reason": a.reason,
            }
        )
    return out


def _override_tournament(db, entity: str, entity_id: int) -> int | None:
    """Torneo dueño de la entidad con advertencias aceptadas (None si no se conoce)."""
    if entity == "registration":
        return db.scalar(select(Registration.tournament_id).where(Registration.id == entity_id))
    if entity == "category":
        return db.scalar(select(Category.tournament_id).where(Category.id == entity_id))
    if entity == "match":
        return db.scalar(
            select(Category.tournament_id).join(Match, Match.category_id == Category.id).where(Match.id == entity_id)
        )
    if entity == "bracket":
        return db.scalar(
            select(Category.tournament_id)
            .join(Bracket, Bracket.category_id == Category.id)
            .where(Bracket.id == entity_id)
        )
    return None


@router.get("/overrides", tags=["audit"])
def overrides(db: DB, user: CurrentUser, entity: str, entity_id: int):
    """Advertencias aceptadas de una entidad: organizadores de su torneo (o el Admin)."""
    if not user.is_admin:
        tid = _override_tournament(db, entity, entity_id)
        if tid is None:
            raise Forbidden("Solo el Admin Global ve estas advertencias")
        ensure_organizer(db, user, tid)
    rows = db.scalars(
        select(RuleOverride).where(RuleOverride.entity == entity, RuleOverride.entity_id == entity_id)
    ).all()
    return [
        {"code": r.code, "message": r.message, "reason": r.reason, "user_id": r.user_id, "at": r.created_at}
        for r in rows
    ]
