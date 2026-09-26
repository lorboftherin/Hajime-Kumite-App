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
from datetime import UTC, datetime, timedelta

import jwt

from app.config import get_settings

_ALGO = "pbkdf2_sha256"


def hash_password(password: str, iterations: int | None = None) -> str:
    iters = iterations or get_settings().password_iterations
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iters)
    return f"{_ALGO}${iters}${base64.b64encode(salt).decode()}${base64.b64encode(dk).decode()}"


def verify_password(password: str, stored: str) -> bool:
    """Acepta hashes de cualquier coste: el número de iteraciones va en el propio hash."""
    try:
        algo, iters, salt_b64, hash_b64 = stored.split("$")
        salt, expected, n = base64.b64decode(salt_b64), base64.b64decode(hash_b64), int(iters)
    except ValueError:
        return False
    if algo != _ALGO:
        return False
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, n)
    return hmac.compare_digest(dk, expected)


def password_needs_rehash(stored: str) -> bool:
    """True si el hash se hizo con otro coste que el configurado (se rehace al entrar)."""
    try:
        algo, iters, _, _ = stored.split("$")
        return algo != _ALGO or int(iters) != get_settings().password_iterations
    except ValueError:
        return True


# Hash de referencia para usuarios inexistentes: se verifica igual contra él para
# que la respuesta tarde lo mismo y no delate qué usuarios existen.
_DUMMY_HASH: str | None = None


def burn_password_check(password: str) -> None:
    global _DUMMY_HASH
    if _DUMMY_HASH is None:
        _DUMMY_HASH = hash_password("usuario-inexistente")
    verify_password(password, _DUMMY_HASH)


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
