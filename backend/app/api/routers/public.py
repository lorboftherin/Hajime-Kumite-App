"""Seguimiento en vivo público y overlay de transmisión (sin inicio de sesión).

Solo responde con un enlace activo; ver ``app.services.public``.

Cientos de personas miran el vivo a la vez y cada una refresca cada 5 s. Para
que eso no le quite tiempo a las mesas:

* La respuesta es una instantánea compartida por todos los procesos y copias
  (``app.services.public_snapshots``): se recalcula solo cuando una escritura
  la invalida, y un solo proceso a la vez.
* El navegador la reutiliza ``public_cache_seconds`` y luego pregunta con
  ``If-None-Match``: si nada cambió recibe 304, sin cuerpo.
* Estos endpoints corren en hilos propios (``public_threads``, 2 por defecto),
  no en los de la API: aunque el vivo se atasque, la mesa sigue respondiendo.
"""

from __future__ import annotations

import json
from functools import partial

import anyio
import anyio.lowlevel
import anyio.to_thread
from fastapi import APIRouter, Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.services import public
from app.services import public_snapshots as snapshots

router = APIRouter(prefix="/public", tags=["public"])

# Un limitador por bucle de eventos (las pruebas crean varios).
_LIMITER: anyio.lowlevel.RunVar[anyio.CapacityLimiter] = anyio.lowlevel.RunVar("hajime_public_limiter")


def _limiter() -> anyio.CapacityLimiter:
    try:
        return _LIMITER.get()
    except LookupError:
        limiter = anyio.CapacityLimiter(max(1, get_settings().public_threads))
        _LIMITER.set(limiter)
        return limiter


def clear_cache() -> None:
    snapshots.clear_memory()


def _live(token: str, if_none_match: str | None) -> Response:
    settings = get_settings()
    if settings.public_cache_seconds <= 0:
        data = snapshots.compute_now(lambda db: public.live(db, token))
        return JSONResponse(jsonable_encoder(data), headers={"Cache-Control": "no-store"})
    snap = snapshots.get(token, snapshots.LIVE, lambda db: public.live(db, token))
    headers = {"ETag": snap.etag, "Cache-Control": f"public, max-age={int(settings.public_cache_seconds)}"}
    if snapshots.etag_matches(if_none_match, snap.etag):
        return Response(status_code=304, headers=headers)
    return Response(snap.body, media_type="application/json", headers=headers)


def _overlay(token: str, tatami_id: int) -> Response:
    # El reloj corre: nada de caché en el navegador; el servidor adelanta el
    # tiempo transcurrido desde que se calculó la instantánea.
    headers = {"Cache-Control": "no-store"}
    if get_settings().public_cache_seconds <= 0:
        data = snapshots.compute_now(lambda db: public.overlay(db, token, tatami_id))
        return JSONResponse(jsonable_encoder(data), headers=headers)
    snap = snapshots.get(token, snapshots.overlay_kind(tatami_id), lambda db: public.overlay(db, token, tatami_id))
    return JSONResponse(snapshots.age_overlay(json.loads(snap.body), snap.computed_at), headers=headers)


@router.get("/{token}")
async def live(token: str, request: Request) -> Response:
    """Tatamis en vivo, resultados, medallero y premios del torneo."""
    call = partial(_live, token, request.headers.get("if-none-match"))
    return await anyio.to_thread.run_sync(call, limiter=_limiter())


@router.get("/{token}/tatamis/{tatami_id}")
async def overlay(token: str, tatami_id: int) -> Response:
    """Marcador del tatami para el overlay de la transmisión."""
    return await anyio.to_thread.run_sync(partial(_overlay, token, tatami_id), limiter=_limiter())
