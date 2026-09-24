"""Autenticación y permisos por ámbito (sección 7 del documento maestro).

Roles (fila ``person_roles`` ligada a la persona del usuario):

* ``organizer``: torneos, categorías, llaves, inscripciones, resultados.
  Ámbito ``global`` o ``tournament``.
* ``table_operator``: registrar combates, puntos, faltas, tiempos y kata.
  Sin cambiar configuración. Ámbito ``global`` o ``tournament``.
* ``dojo_admin`` (Fase 4) y ``referee`` (registro opcional) se guardan pero
  todavía no otorgan permisos.

El Admin Global (``users.is_admin``) puede todo. Solo el Admin y los
organizadores ven documentos de identidad y fechas de nacimiento (sección 11).
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.errors import Forbidden, Unauthorized
from app.db.base import get_session
from app.db.models import PersonRole, User
from app.security import decode_token

DB = Annotated[Session, Depends(get_session)]
_bearer = HTTPBearer(auto_error=False)

ROLES = ("organizer", "table_operator", "dojo_admin", "referee")


def current_user(db: DB, cred: HTTPAuthorizationCredentials | None = Depends(_bearer)) -> User:
    if cred is None:
        raise Unauthorized("Se requiere iniciar sesión")
    decoded = decode_token(cred.credentials)
    user = db.get(User, decoded[0]) if decoded else None
    if user is None or not user.is_active or decoded[1] != (user.token_version or 0):
        raise Unauthorized("Sesión inválida o expirada")
    return user


CurrentUser = Annotated[User, Depends(current_user)]


def require_admin(user: CurrentUser) -> User:
    if not user.is_admin:
        raise Forbidden("Solo el Admin Global puede realizar esta acción")
    return user


AdminUser = Annotated[User, Depends(require_admin)]


def roles_of(db: Session, user: User) -> list[PersonRole]:
    if user.person_id is None:
        return []
    return list(db.scalars(select(PersonRole).where(PersonRole.person_id == user.person_id)).all())


def _has_role(db: Session, user: User, role: str, tournament_id: int | None) -> bool:
    """``tournament_id=None`` exige ámbito global (p. ej. crear un torneo)."""
    for r in roles_of(db, user):
        if r.role != role:
            continue
        if r.scope_type == "global":
            return True
        if r.scope_type == "tournament" and tournament_id is not None and r.scope_id == tournament_id:
            return True
    return False


def is_organizer(db: Session, user: User, tournament_id: int | None) -> bool:
    return user.is_admin or _has_role(db, user, "organizer", tournament_id)


def is_staff(db: Session, user: User) -> bool:
    """Admin u organizador de cualquier ámbito: puede administrar personas y dojos."""
    return user.is_admin or any(r.role == "organizer" for r in roles_of(db, user))


def can_operate(db: Session, user: User, tournament_id: int) -> bool:
    """Mesa: organizador del torneo u operador de mesa (del torneo o global)."""
    return is_organizer(db, user, tournament_id) or _has_role(db, user, "table_operator", tournament_id)


def can_view_documents(db: Session, user: User) -> bool:
    """Sección 11: solo Admin Global y organizadores ven documentos y fecha de nacimiento."""
    return is_staff(db, user)


def ensure_organizer(db: Session, user: User, tournament_id: int | None) -> None:
    if not is_organizer(db, user, tournament_id):
        raise Forbidden("No eres organizador de este torneo")


def ensure_staff(db: Session, user: User) -> None:
    if not is_staff(db, user):
        raise Forbidden("Se requiere ser organizador para administrar personas y dojos")


def ensure_operator(db: Session, user: User, tournament_id: int) -> None:
    if not can_operate(db, user, tournament_id):
        raise Forbidden("No eres operador de mesa ni organizador de este torneo")
