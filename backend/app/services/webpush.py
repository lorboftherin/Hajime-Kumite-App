"""Protocolo Web Push: cifrado del mensaje (RFC 8291) y firma VAPID (RFC 8292).

* **Cifrado** ``aes128gcm`` (RFC 8188 + RFC 8291) con ``http_ece``, la
  biblioteca de web-push-libs que usan también ``pywebpush`` y ``py-vapid``:
  una clave efímera P-256 por mensaje, ECDH con la clave ``p256dh`` del
  navegador y el secreto ``auth``. El servicio de push (FCM, Mozilla, Apple,
  Windows) no puede leer el contenido.
* **VAPID**: un JWT ES256 (``aud`` = origen del servicio de push, ``exp`` ≤
  24 h, ``sub`` = contacto) firmado con la clave privada del servidor, en la
  cabecera ``Authorization: vapid t=<jwt>, k=<clave pública>``. El navegador
  solo acepta mensajes firmados con la clave pública con la que se suscribió.

Se evita ``pywebpush`` porque arrastra ``requests`` y ``aiohttp``: el envío es
un POST con ``urllib`` como el correo por ACS (``app.services.mail``).
"""

from __future__ import annotations

import base64
import os
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from urllib.parse import urlsplit

import http_ece
import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from app.config import Settings, get_settings

JWT_SECONDS = 12 * 3600  # validez del JWT de VAPID (el máximo es 24 h)


def b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def b64u_decode(value: str) -> bytes:
    value = value.strip()
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def public_bytes(key: ec.EllipticCurvePublicKey) -> bytes:
    return key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def generate_vapid_keys() -> tuple[str, str]:
    """Par de claves VAPID nuevo: (pública, privada) en base64url, como las esperan los navegadores."""
    key = ec.generate_private_key(ec.SECP256R1())
    private = key.private_numbers().private_value.to_bytes(32, "big")
    return b64u(public_bytes(key.public_key())), b64u(private)


def load_private_key(value: str) -> ec.EllipticCurvePrivateKey:
    """Clave privada VAPID: 32 bytes en base64url (lo que genera ``vapid-keys``) o PEM (``py-vapid``)."""
    value = value.strip()
    if value.startswith("-----BEGIN"):
        key = serialization.load_pem_private_key(value.replace("\\n", "\n").encode(), password=None)
        if not isinstance(key, ec.EllipticCurvePrivateKey):
            raise ValueError("La clave VAPID debe ser P-256")
        return key
    raw = b64u_decode(value)
    if len(raw) != 32:
        raise ValueError("La clave privada VAPID debe tener 32 bytes (base64url)")
    return ec.derive_private_key(int.from_bytes(raw, "big"), ec.SECP256R1())


def valid_client_keys(p256dh: str, auth: str) -> bool:
    """Claves del navegador: punto P-256 sin comprimir (65 bytes) y secreto de 16 bytes."""
    try:
        point = b64u_decode(p256dh)
        secret = b64u_decode(auth)
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), point)
    except (ValueError, TypeError):
        return False
    return len(point) == 65 and len(secret) == 16


def encrypt(payload: bytes, p256dh: str, auth: str) -> bytes:
    """Mensaje cifrado ``aes128gcm`` para una suscripción (cabecera con sal y clave efímera + un registro)."""
    ephemeral = ec.generate_private_key(ec.SECP256R1())
    return http_ece.encrypt(
        payload,
        salt=os.urandom(16),
        private_key=ephemeral,
        dh=b64u_decode(p256dh),
        auth_secret=b64u_decode(auth),
        version="aes128gcm",
    )


@dataclass
class Vapid:
    public_key: str  # base64url, 65 bytes: la applicationServerKey del navegador
    private_key: ec.EllipticCurvePrivateKey
    subject: str

    def __post_init__(self) -> None:
        self._lock = threading.Lock()
        self._tokens: dict[str, tuple[float, str]] = {}

    def authorization(self, endpoint: str) -> str:
        """Cabecera ``Authorization`` para el servicio de push del endpoint (JWT reutilizado 1 h)."""
        parts = urlsplit(endpoint)
        aud = f"{parts.scheme}://{parts.netloc}"
        now = time.time()
        with self._lock:
            hit = self._tokens.get(aud)
            if hit is None or hit[0] < now + 3600:
                exp = int(now) + JWT_SECONDS
                token = jwt.encode({"aud": aud, "exp": exp, "sub": self.subject}, self.private_key, algorithm="ES256")
                hit = self._tokens[aud] = (exp, token)
        return f"vapid t={hit[1]}, k={self.public_key}"


_vapid_lock = threading.Lock()
_vapid_cache: dict[tuple[str, str, str], Vapid] = {}


def get_vapid(s: Settings | None = None) -> Vapid | None:
    """Claves VAPID de la configuración, o ``None`` si faltan (avisos apagados)."""
    s = s or get_settings()
    if not (s.vapid_public_key and s.vapid_private_key):
        return None
    key = (s.vapid_public_key, s.vapid_private_key, s.vapid_subject)
    with _vapid_lock:
        v = _vapid_cache.get(key)
        if v is None:
            v = _vapid_cache[key] = Vapid(
                s.vapid_public_key.strip(), load_private_key(s.vapid_private_key), s.vapid_subject
            )
        return v


class PushNetworkError(Exception):
    """El servicio de push no respondió (red, DNS, tiempo agotado): se reintenta."""


def _post(url: str, body: bytes, headers: dict[str, str], timeout: float) -> tuple[int, str]:
    """POST al servicio de push. Devuelve (estado HTTP, detalle). Las pruebas lo reemplazan."""
    req = urllib.request.Request(url, data=body, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - endpoint validado al suscribir
            return resp.status, ""
    except urllib.error.HTTPError as e:
        return e.code, e.read()[:300].decode(errors="replace")
    except (urllib.error.URLError, OSError) as e:
        raise PushNetworkError(str(e)) from e


def send(
    vapid: Vapid,
    endpoint: str,
    p256dh: str,
    auth: str,
    payload: bytes,
    *,
    ttl: int,
    urgency: str = "normal",
    topic: str | None = None,
    timeout: float = 10.0,
) -> tuple[int, str]:
    """Cifra y envía un mensaje. Devuelve (estado HTTP, detalle): 201 = aceptado,
    404/410 = la suscripción ya no existe, 429/5xx = reintentar."""
    headers = {
        "TTL": str(max(0, int(ttl))),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "Urgency": urgency,
        "Authorization": vapid.authorization(endpoint),
    }
    if topic:  # reemplaza en el servicio un mensaje anterior del mismo tema aún no entregado
        headers["Topic"] = topic[:32]
    return _post(endpoint, encrypt(payload, p256dh, auth), headers, timeout)
