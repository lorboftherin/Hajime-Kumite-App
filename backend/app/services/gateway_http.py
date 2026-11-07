"""Cliente HTTP mínimo para pasarelas de pago y comprobantes (solo biblioteca estándar).

- Tiempo máximo por llamada (``HAJIME_PAYMENT_HTTP_TIMEOUT``).
- Reintentos ante cortes de red, 429 y 5xx, con la MISMA clave de
  idempotencia: la pasarela reconoce el reintento y no cobra dos veces.
- Nunca registra cabeceras ni cuerpos (llevan el token o datos del pagador).

Las pruebas reemplazan :func:`send` por un servidor falso.
"""

from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

from app.config import get_settings

log = logging.getLogger("hajime.pagos")

RETRY_STATUSES = {429, 500, 502, 503, 504}
MAX_RESPONSE_BYTES = 2_000_000


class GatewayError(Exception):
    """La pasarela respondió con error o no respondió."""

    def __init__(self, status: int, body: Any, message: str = ""):
        super().__init__(message or f"La pasarela respondió {status}")
        self.status = status
        self.body = body


@dataclass
class RawResponse:
    status: int
    body: bytes


def send(method: str, url: str, headers: dict[str, str], data: bytes | None, timeout: float) -> RawResponse:
    """Una llamada HTTP real. Punto único que las pruebas reemplazan."""
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - URL de configuración
            return RawResponse(resp.status, resp.read(MAX_RESPONSE_BYTES))
    except urllib.error.HTTPError as e:
        return RawResponse(e.code, e.read(MAX_RESPONSE_BYTES) if e.fp else b"")


def request_json(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    body: Any = None,
    idempotency_key: str | None = None,
    idempotency_header: str = "X-Idempotency-Key",
    retries: int = 2,
    timeout: float | None = None,
) -> Any:
    """Llama a la API y devuelve el JSON. Lanza :class:`GatewayError` si falla.

    Solo se reintenta lo que es seguro repetir: lecturas (GET) y escrituras con
    clave de idempotencia.
    """
    hdrs = {"Accept": "application/json", **(headers or {})}
    data = None
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode()
        hdrs["Content-Type"] = "application/json"
    if idempotency_key:
        hdrs[idempotency_header] = idempotency_key
    can_retry = method == "GET" or idempotency_key is not None
    attempts = 1 + (retries if can_retry else 0)
    timeout = timeout or get_settings().payment_http_timeout
    last: GatewayError | None = None
    for attempt in range(attempts):
        try:
            resp = send(method, url, hdrs, data, timeout)
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last = GatewayError(0, None, f"Sin respuesta de la pasarela: {type(e).__name__}")
            log.warning("Pasarela sin respuesta (%s %s, intento %s)", method, _safe(url), attempt + 1)
        else:
            parsed = _parse(resp.body)
            if 200 <= resp.status < 300:
                return parsed
            last = GatewayError(resp.status, parsed)
            log.warning("Pasarela respondió %s (%s %s, intento %s)", resp.status, method, _safe(url), attempt + 1)
            if resp.status not in RETRY_STATUSES:
                break
        if attempt + 1 < attempts:
            time.sleep(0.5 * (attempt + 1))
    assert last is not None
    raise last


def _parse(body: bytes) -> Any:
    if not body:
        return None
    try:
        return json.loads(body)
    except ValueError:
        return {"text": body[:500].decode("utf-8", "replace")}


def _safe(url: str) -> str:
    """La URL sin parámetros (la ruta de Nubefact identifica la cuenta: solo el host)."""
    from urllib.parse import urlsplit

    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}{parts.path if 'nubefact' not in parts.netloc else '/…'}"


# Campos de las respuestas que se guardan en payments.raw. Lista blanca: nada
# de la tarjeta (número, BIN, últimos dígitos, titular, token) ni del documento
# del pagador llega a la base.
SAFE_KEYS = {
    "id",
    "object",
    "type",
    "action",
    "status",
    "status_detail",
    "transaction_amount",
    "currency_id",
    "external_reference",
    "date_created",
    "date_approved",
    "date_last_updated",
    "payment_method_id",
    "payment_type_id",
    "preapproval_id",
    "amount",
    "amount_refunded",
    "currency_code",
    "creation_date",
    "reference_code",
    "outcome",
    "code",
    "merchant_message",
    "user_message",
    "metadata",
    "subscription_id",
    "plan_id",
    "live_mode",
    "reason",
    "next_payment_date",
    "summarized",
    "payment",
    "data",
}


def sanitize(obj: Any, depth: int = 0) -> Any:
    """Copia de la respuesta con solo los campos de :data:`SAFE_KEYS`."""
    if depth > 4:
        return None
    if isinstance(obj, dict):
        return {k: sanitize(v, depth + 1) for k, v in obj.items() if k in SAFE_KEYS}
    if isinstance(obj, list):
        return [sanitize(x, depth + 1) for x in obj[:20]]
    if isinstance(obj, str):
        return obj[:500]
    return obj
