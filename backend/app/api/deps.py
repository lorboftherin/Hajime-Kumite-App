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


def current_user(db: DB, cred: HTTPAuthorizationCredentials | None = Depends(_bearer)) -> User:
    if cred is None:
        raise Unauthorized("Se requiere iniciar sesión")
    uid = decode_token(cred.credentials)
    user = db.get(User, uid) if uid else None
    if user is None or not user.is_active:
        raise Unauthorized("Sesión inválida o expirada")
    return user


CurrentUser = Annotated[User, Depends(current_user)]


def require_admin(user: CurrentUser) -> User:
    if not user.is_admin:
        raise Forbidden("Solo el Admin Global puede realizar esta acción")
    return user


AdminUser = Annotated[User, Depends(require_admin)]


def is_organizer(db: Session, user: User, tournament_id: int | None) -> bool:
    if user.is_admin:
        return True
    if user.person_id is None:
        return False
    roles = db.scalars(
        select(PersonRole).where(PersonRole.person_id == user.person_id, PersonRole.role == "organizer")
    ).all()
    return any(
        r.scope_type == "global"
        or (r.scope_type == "tournament" and r.scope_id is not None and r.scope_id == tournament_id)
        for r in roles
    )


def ensure_organizer(db: Session, user: User, tournament_id: int | None) -> None:
    if not is_organizer(db, user, tournament_id):
        raise Forbidden("No eres organizador de este torneo")
