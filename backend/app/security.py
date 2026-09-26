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
import secrets
import threading
import time
from datetime import UTC, datetime, timedelta
from typing import NamedTuple

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


# ---------------------------------------------------------------------------
# Tokens: acceso (JWT corto) y renovación (opaco, rotado en cada uso)
# ---------------------------------------------------------------------------


class TokenClaims(NamedTuple):
    user_id: int
    token_version: int
    session_id: int | None  # None: token emitido antes de existir las sesiones


def key_id(secret: str) -> str:
    """Identificador público del secreto (``kid`` del JWT): permite rotarlo."""
    return hashlib.sha256(secret.encode()).hexdigest()[:12]


def _verification_secrets(kid: str | None) -> list[str]:
    """Secreto actual y, durante una rotación, el anterior (``HAJIME_JWT_PREVIOUS_SECRET``)."""
    s = get_settings()
    candidates = [x for x in (s.jwt_secret, s.jwt_previous_secret) if x]
    if kid:
        by_kid = [x for x in candidates if key_id(x) == kid]
        return by_kid or candidates
    return candidates


def create_token(user_id: int, token_version: int = 0, session_id: int | None = None) -> str:
    """Token de acceso: dura ``HAJIME_ACCESS_TOKEN_MINUTES`` y se firma con el secreto actual."""
    s = get_settings()
    now = datetime.now(UTC)
    payload: dict[str, object] = {
        "sub": str(user_id),
        "tv": token_version,
        "iat": now,
        "exp": now + timedelta(minutes=s.access_token_minutes),
    }
    if session_id is not None:
        payload["sid"] = session_id
    return jwt.encode(payload, s.jwt_secret, algorithm="HS256", headers={"kid": key_id(s.jwt_secret)})


def decode_token(token: str) -> TokenClaims | None:
    """Devuelve los datos del token o None si no es válido (firma, vencimiento o forma)."""
    try:
        kid = jwt.get_unverified_header(token).get("kid")
    except jwt.PyJWTError:
        return None
    for secret in _verification_secrets(kid if isinstance(kid, str) else None):
        try:
            payload = jwt.decode(token, secret, algorithms=["HS256"])
        except jwt.InvalidSignatureError:
            continue
        except jwt.PyJWTError:
            return None
        try:
            sid = payload.get("sid")
            return TokenClaims(int(payload["sub"]), int(payload.get("tv", 0)), int(sid) if sid is not None else None)
        except (KeyError, ValueError, TypeError):
            return None
    return None


def new_refresh_token() -> tuple[str, str]:
    """Token de renovación opaco y su hash (lo único que se guarda)."""
    token = secrets.token_urlsafe(48)
    return token, hash_refresh_token(token)


def hash_refresh_token(token: str) -> str:
    # El token es aleatorio de 384 bits: basta un hash rápido (no hace falta PBKDF2).
    return hashlib.sha256(token.encode()).hexdigest()


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
