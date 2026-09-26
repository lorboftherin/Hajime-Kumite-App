"""Seguimiento en vivo público y overlay de transmisión (sin inicio de sesión).

Solo responde con un enlace activo; ver ``app.services.public``.

Cientos de personas miran el vivo a la vez y cada una refresca cada 5 s. Para
que eso no le quite tiempo a las mesas, la respuesta se calcula una vez y se
comparte durante unos segundos (``public_cache_seconds``); nadie nota un
marcador dos segundos viejo, pero el servidor pasa de cientos de cálculos por
segundo a menos de uno.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, Response

from app.api.deps import DB
from app.config import get_settings
from app.services import public

router = APIRouter(prefix="/public", tags=["public"])

_cache: dict[str, tuple[float, Any]] = {}
_lock = threading.Lock()


def cached(key: str, compute: Callable[[], Any]) -> Any:
    """Devuelve el valor guardado si aún vale; si no, lo calcula y lo guarda."""
    ttl = get_settings().public_cache_seconds
    if ttl <= 0:
        return compute()
    now = time.monotonic()
    with _lock:
        hit = _cache.get(key)
        if hit and hit[0] > now:
            return hit[1]
    value = compute()
    with _lock:
        _cache[key] = (now + ttl, value)
        if len(_cache) > 500:  # torneos viejos: se limpia lo vencido
            for k in [k for k, (exp, _) in _cache.items() if exp <= now]:
                _cache.pop(k, None)
    return value


def clear_cache() -> None:
    with _lock:
        _cache.clear()


@router.get("/{token}")
def live(token: str, db: DB, response: Response):
    """Tatamis en vivo, resultados, medallero y premios del torneo."""
    response.headers["Cache-Control"] = "no-store"
    return cached(f"live:{token}", lambda: public.live(db, token))


@router.get("/{token}/tatamis/{tatami_id}")
def overlay(token: str, tatami_id: int, db: DB, response: Response):
    """Marcador del tatami para el overlay de la transmisión."""
    response.headers["Cache-Control"] = "no-store"
    return cached(f"overlay:{token}:{tatami_id}", lambda: public.overlay(db, token, tatami_id))
