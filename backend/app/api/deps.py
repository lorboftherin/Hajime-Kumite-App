"""Autenticación y permisos por ámbito (sección 7 del documento maestro).

Roles (fila ``person_roles`` ligada a la persona del usuario):

* ``organizer``: torneos, categorías, llaves, inscripciones, resultados.
  Ámbito ``global`` o ``tournament``.
* ``table_operator``: registrar combates, puntos, faltas, tiempos y kata.
  Sin cambiar configuración. Ámbito ``global``, ``tournament`` o ``tatami``
  (solo los combates de las categorías asignadas a ese tatami).
* ``referee`` (registro opcional, sección 20): solo lectura del torneo.
* ``sensei`` (ámbito ``dojo``) y ``dojo_admin`` (Fase 4) no otorgan permisos
  sobre torneos; sí dejan ver el historial de su dojo.

El Admin Global (``users.is_admin``) puede todo. Solo el Admin y los
organizadores ven documentos de identidad y fechas de nacimiento (sección 11).

Lecturas con ámbito: nada de un torneo se lee con solo iniciar sesión. Lee un
torneo (llaves, inscripciones, resultados, reportes…) el Admin o quien tenga
rol de organizador, operador de mesa o árbitro con ámbito global, de ese
torneo o de un tatami de ese torneo. Las dependencias ``TournamentReader``,
``TatamiReader``, ``CategoryReader`` y ``MatchReader`` resuelven el torneo
dueño a partir del id de la ruta.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.errors import Forbidden, NotFound, Unauthorized
from app.db.base import get_session, utcnow
from app.db.models import Category, Match, PersonRole, Tatami, User, UserSession
from app.security import decode_token

DB = Annotated[Session, Depends(get_session)]
_bearer = HTTPBearer(auto_error=False)

ROLES = ("organizer", "table_operator", "dojo_admin", "referee", "sensei")
# Roles que permiten leer un torneo dentro de su ámbito.
READER_ROLES = ("organizer", "table_operator", "referee")


def current_user(request: Request, db: DB, cred: HTTPAuthorizationCredentials | None = Depends(_bearer)) -> User:
    if cred is None:
        raise Unauthorized("Se requiere iniciar sesión")
    claims = decode_token(cred.credentials)
    user = db.get(User, claims.user_id) if claims else None
    if user is None or not user.is_active or claims.token_version != (user.token_version or 0):
        raise Unauthorized("Sesión inválida o expirada")
    if claims.session_id is not None:
        # Cerrar sesión (propia o por el Admin) corta también el token de acceso vigente.
        sess = db.get(UserSession, claims.session_id)
        if sess is None or sess.user_id != user.id or sess.revoked_at is not None or sess.expires_at <= utcnow():
            raise Unauthorized("Sesión cerrada o expirada")
    request.state.session_id = claims.session_id
    return user


CurrentUser = Annotated[User, Depends(current_user)]


def require_admin(user: CurrentUser) -> User:
    if not user.is_admin:
        raise Forbidden("Solo el Admin Global puede realizar esta acción")
    return user


AdminUser = Annotated[User, Depends(require_admin)]


def roles_of(db: Session, user: User) -> list[PersonRole]:
    """Roles del usuario. Se guardan en la sesión de base de datos (una por
    petición) para no consultarlos varias veces en la misma petición."""
    if user.person_id is None:
        return []
    cache: dict[int, list[PersonRole]] = db.info.setdefault("roles_of", {})
    if user.person_id not in cache:
        cache[user.person_id] = list(db.scalars(select(PersonRole).where(PersonRole.person_id == user.person_id)).all())
    return cache[user.person_id]


def forget_roles(db: Session) -> None:
    """Invalida la caché de :func:`roles_of` (tras agregar o quitar un rol)."""
    db.info.pop("roles_of", None)


def _has_role(db: Session, user: User, role: str, tournament_id: int | None, tatami_id: int | None = None) -> bool:
    """``tournament_id=None`` exige ámbito global (p. ej. crear un torneo).
    El ámbito ``tatami`` solo vale para el tatami indicado."""
    for r in roles_of(db, user):
        if r.role != role:
            continue
        if r.scope_type == "global":
            return True
        if r.scope_type == "tournament" and tournament_id is not None and r.scope_id == tournament_id:
            return True
        if r.scope_type == "tatami" and tatami_id is not None and r.scope_id == tatami_id:
            return True
    return False


def is_organizer(db: Session, user: User, tournament_id: int | None) -> bool:
    return user.is_admin or _has_role(db, user, "organizer", tournament_id)


def is_staff(db: Session, user: User) -> bool:
    """Admin u organizador de cualquier ámbito: puede administrar personas y dojos."""
    return user.is_admin or any(r.role == "organizer" for r in roles_of(db, user))


def can_operate(db: Session, user: User, tournament_id: int, tatami_id: int | None = None) -> bool:
    """Mesa: organizador del torneo u operador de mesa (global, del torneo o
    del tatami donde está la categoría)."""
    return is_organizer(db, user, tournament_id) or _has_role(db, user, "table_operator", tournament_id, tatami_id)


def can_view_documents(db: Session, user: User) -> bool:
    """Sección 11: solo Admin Global y organizadores ven documentos y fecha de nacimiento."""
    return is_staff(db, user)


def readable_tournament_ids(db: Session, user: User) -> set[int] | None:
    """Torneos que el usuario puede leer; ``None`` = todos (Admin o rol global)."""
    if user.is_admin:
        return None
    ids: set[int] = set()
    tatamis: list[int] = []
    for r in roles_of(db, user):
        if r.role not in READER_ROLES:
            continue
        if r.scope_type == "global":
            return None
        if r.scope_type == "tournament" and r.scope_id is not None:
            ids.add(r.scope_id)
        elif r.scope_type == "tatami" and r.scope_id is not None:
            tatamis.append(r.scope_id)
    if tatamis:
        ids.update(db.scalars(select(Tatami.tournament_id).where(Tatami.id.in_(tatamis))).all())
    return ids


def can_read_tournament(db: Session, user: User, tournament_id: int) -> bool:
    ids = readable_tournament_ids(db, user)
    return ids is None or tournament_id in ids


def ensure_reader(db: Session, user: User, tournament_id: int) -> None:
    if not can_read_tournament(db, user, tournament_id):
        raise Forbidden("No tienes acceso a este torneo")


def ensure_organizer(db: Session, user: User, tournament_id: int | None) -> None:
    if not is_organizer(db, user, tournament_id):
        raise Forbidden("No eres organizador de este torneo")


def ensure_staff(db: Session, user: User) -> None:
    if not is_staff(db, user):
        raise Forbidden("Se requiere ser organizador para administrar personas y dojos")


def ensure_operator(db: Session, user: User, tournament_id: int, tatami_id: int | None = None) -> None:
    if not can_operate(db, user, tournament_id, tatami_id):
        raise Forbidden("No eres operador de mesa de este tatami ni organizador del torneo")


# --- Dependencias de lectura con ámbito ------------------------------------------


def require_staff(db: DB, user: CurrentUser) -> User:
    ensure_staff(db, user)
    return user


StaffUser = Annotated[User, Depends(require_staff)]


def tournament_reader(tid: int, db: DB, user: CurrentUser) -> User:
    ensure_reader(db, user, tid)
    return user


def tatami_reader(tatami_id: int, db: DB, user: CurrentUser) -> User:
    t = db.get(Tatami, tatami_id)
    if t is None:
        raise NotFound("Tatami no encontrado")
    ensure_reader(db, user, t.tournament_id)
    return user


def category_reader(cid: int, db: DB, user: CurrentUser) -> User:
    tid = db.scalar(select(Category.tournament_id).where(Category.id == cid))
    if tid is None:
        raise NotFound("Categoría no encontrada")
    ensure_reader(db, user, tid)
    return user


def match_tournament_id(db: Session, mid: int) -> int:
    tid = db.scalar(select(Category.tournament_id).join(Match, Match.category_id == Category.id).where(Match.id == mid))
    if tid is None:
        raise NotFound("Combate no encontrado")
    return tid


def match_reader(mid: int, db: DB, user: CurrentUser) -> User:
    ensure_reader(db, user, match_tournament_id(db, mid))
    return user


TournamentReader = Annotated[User, Depends(tournament_reader)]
TatamiReader = Annotated[User, Depends(tatami_reader)]
CategoryReader = Annotated[User, Depends(category_reader)]
MatchReader = Annotated[User, Depends(match_reader)]
