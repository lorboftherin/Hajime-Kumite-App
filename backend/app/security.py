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
from datetime import UTC, datetime, timedelta
from typing import NamedTuple

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
