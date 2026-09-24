"""Cuentas propias con JWT (decisión provisional; ver docs/revision-v0.2.md).

El hash usa PBKDF2-SHA256 de la biblioteca estándar para no depender de
paquetes nativos. Migrar a Entra ID / Google solo cambia este módulo y el
endpoint de login.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import threading
import time
from datetime import UTC, datetime, timedelta

import jwt

from app.config import get_settings

_ITER = 390_000


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, _ITER)
    return f"pbkdf2_sha256${_ITER}${base64.b64encode(salt).decode()}${base64.b64encode(dk).decode()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, iters, salt_b64, hash_b64 = stored.split("$")
    except ValueError:
        return False
    if algo != "pbkdf2_sha256":
        return False
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), base64.b64decode(salt_b64), int(iters))
    return hmac.compare_digest(dk, base64.b64decode(hash_b64))


def create_token(user_id: int, token_version: int = 0) -> str:
    s = get_settings()
    now = datetime.now(UTC)
    payload = {
        "sub": str(user_id),
        "tv": token_version,
        "iat": now,
        "exp": now + timedelta(minutes=s.jwt_minutes),
    }
    return jwt.encode(payload, s.jwt_secret, algorithm="HS256")


def decode_token(token: str) -> tuple[int, int] | None:
    """Devuelve (user_id, token_version) o None si el token no es válido."""
    try:
        payload = jwt.decode(token, get_settings().jwt_secret, algorithms=["HS256"])
        return int(payload["sub"]), int(payload.get("tv", 0))
    except (jwt.PyJWTError, KeyError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Límite de intentos de inicio de sesión (en memoria, por proceso)
# ---------------------------------------------------------------------------

MAX_FAILURES = 5
WINDOW_SECONDS = 10 * 60
LOCK_SECONDS = 5 * 60
_failures: dict[str, list[float]] = {}
_lock = threading.Lock()


def login_locked_for(key: str) -> int:
    """Segundos que faltan para poder reintentar (0 = permitido)."""
    now = time.monotonic()
    with _lock:
        recent = [t for t in _failures.get(key, []) if now - t < WINDOW_SECONDS]
        _failures[key] = recent
        if len(recent) >= MAX_FAILURES:
            remaining = LOCK_SECONDS - (now - recent[-1])
            if remaining <= 0:
                _failures.pop(key, None)  # cumplió el bloqueo: vuelve a empezar
                return 0
            return max(1, int(remaining))
    return 0


def register_login_failure(key: str) -> None:
    with _lock:
        _failures.setdefault(key, []).append(time.monotonic())


def clear_login_failures(key: str) -> None:
    with _lock:
        _failures.pop(key, None)
