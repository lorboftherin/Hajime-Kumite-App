"""Límite de intentos de inicio de sesión, guardado en la base.

Antes vivía en memoria: con varios procesos (y varias copias en Azure) cada
uno llevaba su propia cuenta, así que un atacante tenía 5 intentos por proceso
y el bloqueo desaparecía al reiniciar. En la base todos ven la misma cuenta.

Dos contadores por intento fallido:

- (usuario, IP): 5 fallos en 10 min bloquean 5 min a ese usuario desde esa IP.
  No bloquea al usuario desde otra IP, para que un tercero no pueda dejar
  fuera al organizador en pleno torneo con solo escribir mal su clave.
- solo IP: un límite más alto (30) frena a quien prueba muchos usuarios desde
  la misma dirección. Es alto porque en un local todos salen a internet por
  la misma IP del router.

El contador por IP no se limpia al entrar bien: si no, bastaría una cuenta
válida para reiniciarlo y seguir probando otras.
"""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy import delete, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.base import utcnow
from app.db.models import LoginAttempt

WINDOW = timedelta(minutes=10)
LOCK = timedelta(minutes=5)
MAX_FAILURES = 5  # por (usuario, IP)
MAX_FAILURES_IP = 30  # solo por IP
# Filas viejas que ya no bloquean nada se borran de vez en cuando.
_KEEP = timedelta(days=1)


def _keys(username: str, ip: str) -> list[tuple[str, int]]:
    return [(f"u|{username}|{ip}"[:160], MAX_FAILURES), (f"ip|{ip}"[:160], MAX_FAILURES_IP)]


def login_locked_for(db: Session, username: str, ip: str) -> int:
    """Segundos que faltan para poder reintentar (0 = permitido)."""
    now = utcnow()
    keys = [k for k, _ in _keys(username, ip)]
    until = db.scalars(
        select(LoginAttempt.locked_until).where(LoginAttempt.key.in_(keys), LoginAttempt.locked_until > now)
    ).all()
    if not until:
        return 0
    return max(1, int((max(until) - now).total_seconds()))


def register_login_failure(db: Session, username: str, ip: str) -> None:
    """Suma un fallo a cada contador y bloquea el que llegue a su límite.

    Cada paso es una sentencia atómica, así dos procesos que fallan a la vez
    no pierden cuentas. Deja la sesión confirmada (commit).
    """
    now = utcnow()
    for key, limit in _keys(username, ip):
        _increment(db, key, now)
        db.execute(
            update(LoginAttempt)
            .where(LoginAttempt.key == key, LoginAttempt.failures >= limit, LoginAttempt.locked_until.is_(None))
            .values(locked_until=now + LOCK)
        )
        db.commit()


def _increment(db: Session, key: str, now) -> None:
    for _ in range(3):
        # 1) Dentro de la ventana y sin bloqueo cumplido: sumar uno.
        n = db.execute(
            update(LoginAttempt)
            .where(
                LoginAttempt.key == key,
                LoginAttempt.window_start >= now - WINDOW,
                LoginAttempt.locked_until.is_(None),
            )
            .values(failures=LoginAttempt.failures + 1)
        ).rowcount
        if n:
            return
        # 2) Ventana vencida o bloqueo ya cumplido: empieza una cuenta nueva.
        n = db.execute(
            update(LoginAttempt)
            .where(LoginAttempt.key == key, or_(LoginAttempt.locked_until.is_(None), LoginAttempt.locked_until <= now))
            .values(failures=1, window_start=now, locked_until=None)
        ).rowcount
        if n:
            return
        # 3) Primera vez: si otro proceso la creó al mismo tiempo, se reintenta.
        try:
            db.add(LoginAttempt(key=key, failures=1, window_start=now))
            db.commit()
            return
        except IntegrityError:
            db.rollback()


def clear_login_failures(db: Session, username: str, ip: str) -> None:
    """Tras entrar bien: borra el contador de (usuario, IP) y limpia filas viejas."""
    now = utcnow()
    key = _keys(username, ip)[0][0]
    db.execute(delete(LoginAttempt).where(LoginAttempt.key == key))
    db.execute(
        delete(LoginAttempt).where(
            LoginAttempt.window_start < now - _KEEP,
            or_(LoginAttempt.locked_until.is_(None), LoginAttempt.locked_until < now),
        )
    )
    db.commit()
