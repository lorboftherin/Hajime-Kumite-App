"""Sesiones: token de acceso corto + token de renovación opaco y rotado.

* Iniciar sesión crea una fila en ``user_sessions`` (una por dispositivo) y
  devuelve un token de acceso (JWT de ``HAJIME_ACCESS_TOKEN_MINUTES``) y uno de
  renovación (aleatorio, dura ``HAJIME_REFRESH_TOKEN_DAYS``; solo se guarda
  su hash).
* ``/auth/refresh`` rota el token de renovación: el anterior deja de valer.
  Si alguien presenta un token ya rotado (fuera del margen de carrera entre
  pestañas), se asume robo y se cierran todas las sesiones del usuario.
* Cerrar sesión, cambiar la contraseña o desactivar la cuenta revoca las
  sesiones; el token de acceso lleva el id de sesión (``sid``) y deja de
  valer al instante.
"""

from __future__ import annotations

from datetime import timedelta

from fastapi import Request
from sqlalchemy import delete, or_, select, update
from sqlalchemy.orm import Session

from app.api import schemas as s
from app.api.errors import Unauthorized
from app.config import get_settings
from app.db.base import utcnow
from app.db.models import User, UserSession
from app.security import create_token, hash_refresh_token, new_refresh_token
from app.services.audit import audit

# Dos pestañas pueden renovar a la vez con el mismo token: dentro de este
# margen, el token recién rotado no se trata como robo (solo se rechaza).
REUSE_GRACE_SECONDS = 30


def _client(request: Request | None) -> tuple[str, str]:
    if request is None:
        return "", ""
    ua = (request.headers.get("user-agent") or "")[:255]
    ip = (request.client.host if request.client else "")[:45]
    return ua, ip


def open_session(db: Session, user: User, request: Request | None) -> tuple[UserSession, str]:
    """Crea la sesión (sin confirmar la transacción) y devuelve el token de renovación en claro."""
    token, token_hash = new_refresh_token()
    ua, ip = _client(request)
    now = utcnow()
    # Limpieza barata: las sesiones vencidas o cerradas hace más de un mes de este usuario.
    old = now - timedelta(days=30)
    db.execute(
        delete(UserSession).where(
            UserSession.user_id == user.id,
            or_(UserSession.expires_at < old, UserSession.revoked_at < old),
        )
    )
    sess = UserSession(
        user_id=user.id,
        token_hash=token_hash,
        created_at=now,
        last_used_at=now,
        expires_at=now + timedelta(days=get_settings().refresh_token_days),
        user_agent=ua,
        ip=ip,
    )
    db.add(sess)
    db.flush()
    return sess, token


def tokens_out(user: User, sess: UserSession, refresh_token: str, user_out: s.UserOut) -> s.TokenOut:
    return s.TokenOut(
        access_token=create_token(user.id, user.token_version or 0, sess.id),
        refresh_token=refresh_token,
        expires_in=get_settings().access_token_minutes * 60,
        user=user_out,
    )


def refresh(db: Session, token: str, request: Request | None) -> tuple[User, UserSession, str]:
    """Rota el token de renovación. Confirma la transacción."""
    h = hash_refresh_token(token)
    now = utcnow()
    sess = db.scalar(select(UserSession).where(UserSession.token_hash == h))
    if sess is None:
        stale = db.scalar(select(UserSession).where(UserSession.previous_token_hash == h))
        if stale is not None:
            if stale.rotated_at and now - stale.rotated_at <= timedelta(seconds=REUSE_GRACE_SECONDS):
                raise Unauthorized("La sesión ya se renovó en otra pestaña", code="REFRESH_RACE")
            # Token ya rotado reutilizado: posible robo. Se cierran todas las sesiones.
            n = revoke_all(db, stale.user_id)
            audit(db, None, "user", stale.user_id, "refresh_reuse", after={"revoked_sessions": n})
            db.commit()
        raise Unauthorized("Sesión inválida o expirada")
    if sess.revoked_at is not None or sess.expires_at <= now:
        raise Unauthorized("Sesión cerrada o expirada")
    user = db.get(User, sess.user_id)
    if user is None or not user.is_active:
        raise Unauthorized("Sesión inválida o expirada")
    new_token, new_hash = new_refresh_token()
    sess.previous_token_hash = sess.token_hash
    sess.token_hash = new_hash
    sess.rotated_at = now
    sess.last_used_at = now
    ua, ip = _client(request)
    if ua:
        sess.user_agent = ua
    if ip:
        sess.ip = ip
    db.commit()
    return user, sess, new_token


def revoke(db: Session, sess: UserSession) -> None:
    if sess.revoked_at is None:
        sess.revoked_at = utcnow()


def revoke_all(db: Session, user_id: int) -> int:
    """Revoca todas las sesiones abiertas del usuario (sin confirmar). Devuelve cuántas."""
    res = db.execute(
        update(UserSession)
        .where(UserSession.user_id == user_id, UserSession.revoked_at.is_(None))
        .values(revoked_at=utcnow())
        .execution_options(synchronize_session="fetch")
    )
    return res.rowcount or 0


def by_refresh_token(db: Session, token: str) -> UserSession | None:
    return db.scalar(select(UserSession).where(UserSession.token_hash == hash_refresh_token(token)))


def active_sessions(db: Session, user_id: int) -> list[UserSession]:
    return list(
        db.scalars(
            select(UserSession)
            .where(UserSession.user_id == user_id, UserSession.revoked_at.is_(None), UserSession.expires_at > utcnow())
            .order_by(UserSession.last_used_at.desc())
        ).all()
    )
