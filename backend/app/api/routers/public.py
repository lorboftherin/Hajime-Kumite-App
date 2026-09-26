"""Portal público: seguimiento en vivo, «¿cuándo pelea?», llaves, overlay y
pantalla grande, sin inicio de sesión. Ver ``app.services.public`` y
``docs/portal-publico.md``.

Cada vista existe con el enlace secreto (``/public/{token}…``) y con la
dirección fija del torneo (``/public/t/{slug}…``); las dos comparten la misma
instantánea. Solo responden con el público activo.

Cientos de personas miran el vivo a la vez. Para que eso no le quite tiempo a
las mesas:

* La respuesta es una instantánea compartida por todos los procesos y copias
  (``app.services.public_snapshots``): se recalcula solo cuando una escritura
  la invalida, y un solo proceso a la vez.
* El navegador la reutiliza ``public_cache_seconds`` y luego pregunta con
  ``If-None-Match``: si nada cambió recibe 304, sin cuerpo.
* ``…/stream`` (SSE) la empuja cuando cambia, con un solo sondeo por torneo y
  proceso (``app.services.public_stream``).
* Estos endpoints corren en hilos propios (``public_threads``, 2 por defecto),
  no en los de la API: aunque el vivo se atasque, la mesa sigue respondiendo.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from collections.abc import Callable
from functools import partial
from typing import Any

import anyio
import anyio.lowlevel
import anyio.to_thread
from fastapi import APIRouter, Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.background import BackgroundTask

from app.config import get_settings
from app.services import public, public_stream
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
    public.forget_slugs()
    with _dir_lock:
        _directory.clear()


async def _run(fn: Callable[[], Any]) -> Any:
    return await anyio.to_thread.run_sync(fn, limiter=_limiter())


def _by_slug(slug: str, fn: Callable[[str], Any]) -> Any:
    """Resuelve la dirección fija al token (caché de pocos segundos) y sigue como con el token."""
    with snapshots._session() as db:
        token = public.token_for_slug(db, slug)
    return fn(token)


# ---------------------------------------------------------------------------
# Vistas con ETag: vivo, «¿cuándo pelea?» y llave de una categoría
# ---------------------------------------------------------------------------


def _cached(token: str, kind: str, if_none_match: str | None) -> Response:
    settings = get_settings()
    compute = public_stream.compute_for(token, kind)
    if settings.public_cache_seconds <= 0:
        data = snapshots.compute_now(compute)
        return JSONResponse(jsonable_encoder(data), headers={"Cache-Control": "no-store"})
    snap = snapshots.get(token, kind, compute)
    headers = {"ETag": snap.etag, "Cache-Control": f"public, max-age={int(settings.public_cache_seconds)}"}
    if snapshots.etag_matches(if_none_match, snap.etag):
        return Response(status_code=304, headers=headers)
    return Response(snap.body, media_type="application/json", headers=headers)


def _overlay(token: str, tatami_id: int) -> Response:
    # El reloj corre: nada de caché en el navegador; el servidor adelanta el
    # tiempo transcurrido desde que se calculó la instantánea.
    headers = {"Cache-Control": "no-store"}
    kind = snapshots.overlay_kind(tatami_id)
    compute = public_stream.compute_for(token, kind)
    if get_settings().public_cache_seconds <= 0:
        return JSONResponse(jsonable_encoder(snapshots.compute_now(compute)), headers=headers)
    snap = snapshots.get(token, kind, compute)
    return JSONResponse(snapshots.age_overlay(json.loads(snap.body), snap.computed_at), headers=headers)


# ---------------------------------------------------------------------------
# Directorio de torneos públicos
# ---------------------------------------------------------------------------

DIRECTORY_TTL = 30.0
_dir_lock = threading.Lock()
_directory: dict[str, tuple[float, bytes]] = {}


def _directory_body(q: str) -> bytes:
    key = " ".join(q.lower().split())[:100]
    now = time.monotonic()
    with _dir_lock:
        hit = _directory.get(key)
        if hit and hit[0] > now:
            return hit[1]
    with snapshots._session() as db:
        data = public.directory(db, key)
    body = json.dumps(jsonable_encoder(data), ensure_ascii=False, separators=(",", ":")).encode()
    with _dir_lock:
        if len(_directory) > 200:
            _directory.clear()
        _directory[key] = (now + DIRECTORY_TTL, body)
    return body


@router.get("/torneos")
async def directory(q: str = "") -> Response:
    """Torneos con página pública (no los de prueba): en curso, próximos y recientes."""
    body = await _run(partial(_directory_body, q))
    return Response(body, media_type="application/json", headers={"Cache-Control": "public, max-age=60"})


# ---------------------------------------------------------------------------
# Actualización en vivo (SSE)
# ---------------------------------------------------------------------------

SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",  # nginx y otros proxies: no acumular la respuesta
}


def _unavailable(message: str, code: str) -> JSONResponse:
    return JSONResponse({"code": code, "message": message}, status_code=503, headers={"Retry-After": "30"})


async def _stream(request: Request, resolve: Callable[[], str], live: bool, people: bool, tatami: int | None):
    settings = get_settings()
    if settings.public_cache_seconds <= 0:
        return _unavailable("Actualización en vivo no disponible: usa el sondeo", "STREAM_DISABLED")
    if not public_stream.acquire():
        return _unavailable("Demasiadas conexiones en vivo: usa el sondeo", "TOO_MANY_STREAMS")
    released = False

    def cleanup() -> None:
        nonlocal released
        if not released:
            released = True
            public_stream.unsubscribe(token, sub)
            public_stream.release()

    token = ""
    sub: public_stream.Subscriber | None = None
    try:
        token = await _run(resolve)
        kinds = {snapshots.LIVE} if live or not (people or tatami is not None) else set()
        if people:
            kinds.add(snapshots.PEOPLE)
        if tatami is not None:
            kinds.add(snapshots.overlay_kind(tatami))
        # Valida el enlace (404 si no existe) y trae la primera instantánea de cada vista.
        first = {
            k: await _run(partial(snapshots.get, token, k, public_stream.compute_for(token, k))) for k in sorted(kinds)
        }
    except BaseException:
        public_stream.release()
        raise
    sub = public_stream.Subscriber(frozenset(kinds), asyncio.get_running_loop())
    known = public_stream.parse_last_event_id(request.headers.get("last-event-id"))
    sub.sent.update({k: e for k, e in known.items() if k in kinds})
    sub.shown.update(sub.sent)
    for k, snap in first.items():
        sub.offer(k, snap.etag, public_stream.event_data(k, snap))
    public_stream.subscribe(token, sub)
    heartbeat = max(0.5, settings.public_sse_heartbeat_seconds)

    async def events():
        loop = asyncio.get_running_loop()
        deadline = loop.time() + max(1.0, settings.public_sse_max_seconds)
        try:
            yield "retry: 3000\n\n"
            while True:
                sub.wake.clear()
                for kind, etag, data in sub.take():
                    event_id = sub.last_event_id(kind, etag)
                    yield f"event: {public_stream.event_name(kind)}\nid: {event_id}\ndata: {data}\n\n"
                if sub.gone:
                    yield 'event: gone\ndata: {"message":"El enlace fue desactivado"}\n\n'
                    return
                remaining = deadline - loop.time()
                if remaining <= 0:
                    return  # el navegador se reconecta solo
                try:
                    await asyncio.wait_for(sub.wake.wait(), timeout=min(heartbeat, remaining))
                except TimeoutError:
                    if await request.is_disconnected():
                        return
                    yield ": latido\n\n"
        finally:
            cleanup()

    return StreamingResponse(
        events(), media_type="text/event-stream", headers=SSE_HEADERS, background=BackgroundTask(cleanup)
    )


# ---------------------------------------------------------------------------
# Por dirección fija (/t/<slug>)
# ---------------------------------------------------------------------------


@router.get("/t/{slug}")
async def live_by_slug(slug: str, request: Request) -> Response:
    """El vivo del torneo por su dirección fija."""
    inm = request.headers.get("if-none-match")
    return await _run(partial(_by_slug, slug, lambda token: _cached(token, snapshots.LIVE, inm)))


@router.get("/t/{slug}/people")
async def people_by_slug(slug: str, request: Request) -> Response:
    """Competidores y su próximo combate («¿cuándo pelea?»)."""
    inm = request.headers.get("if-none-match")
    return await _run(partial(_by_slug, slug, lambda token: _cached(token, snapshots.PEOPLE, inm)))


@router.get("/t/{slug}/categories/{category_id}")
async def category_by_slug(slug: str, category_id: int, request: Request) -> Response:
    """Llave y resultados de una categoría, de solo lectura."""
    inm = request.headers.get("if-none-match")
    kind = public.category_kind(category_id)
    return await _run(partial(_by_slug, slug, lambda token: _cached(token, kind, inm)))


@router.get("/t/{slug}/tatamis/{tatami_id}")
async def overlay_by_slug(slug: str, tatami_id: int) -> Response:
    """Marcador del tatami (overlay y pantalla grande)."""
    return await _run(partial(_by_slug, slug, lambda token: _overlay(token, tatami_id)))


@router.get("/t/{slug}/stream")
async def stream_by_slug(
    slug: str, request: Request, live: bool = True, people: bool = False, tatami: int | None = None
) -> Response:
    """Actualización en vivo por SSE (ver ``/public/{token}/stream``)."""
    return await _stream(request, partial(_by_slug, slug, lambda token: token), live, people, tatami)


# ---------------------------------------------------------------------------
# Por enlace secreto
# ---------------------------------------------------------------------------


@router.get("/{token}")
async def live(token: str, request: Request) -> Response:
    """Tatamis en vivo, resultados, medallero y premios del torneo."""
    return await _run(partial(_cached, token, snapshots.LIVE, request.headers.get("if-none-match")))


@router.get("/{token}/people")
async def people(token: str, request: Request) -> Response:
    """Competidores y su próximo combate («¿cuándo pelea?»), sin datos sensibles."""
    return await _run(partial(_cached, token, snapshots.PEOPLE, request.headers.get("if-none-match")))


@router.get("/{token}/categories/{category_id}")
async def category(token: str, category_id: int, request: Request) -> Response:
    """Llave y resultados de una categoría, de solo lectura."""
    kind = public.category_kind(category_id)
    return await _run(partial(_cached, token, kind, request.headers.get("if-none-match")))


@router.get("/{token}/tatamis/{tatami_id}")
async def overlay(token: str, tatami_id: int) -> Response:
    """Marcador del tatami para el overlay de la transmisión y la pantalla grande."""
    return await _run(partial(_overlay, token, tatami_id))


@router.get("/{token}/stream")
async def stream(
    token: str, request: Request, live: bool = True, people: bool = False, tatami: int | None = None
) -> Response:
    """Server-Sent Events: envía la instantánea (evento ``live``, ``people`` u
    ``overlay``) cada vez que cambia y un comentario de latido cada 15 s. Con
    demasiadas conexiones responde 503: el cliente sigue con el sondeo."""
    return await _stream(request, lambda: token, live, people, tatami)
