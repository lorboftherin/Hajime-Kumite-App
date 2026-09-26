"""Actualización en vivo por Server-Sent Events (``GET /public/{token}/stream``).

Por qué: con el sondeo cada 5 s, cada espectador pide el vivo 12 veces por
minuto aunque nada cambie, y ve un punto con 3–5 s de demora. Con SSE el
navegador deja una conexión abierta y recibe la instantánea solo cuando cambia.

Cómo funciona (por proceso):

* **Un sondeo compartido por torneo.** El primer espectador de un torneo
  levanta un hilo (``_Hub``); los demás se suscriben a él. Cada
  ``public_sse_poll_seconds`` (1 s) el hilo hace **una** consulta
  (``public_snapshots.versions``: etag y ``dirty`` de todas las vistas del
  torneo). Si una vista que alguien mira está sucia, vencida o cambió de etag,
  la trae con el mecanismo de siempre (``public_snapshots.get``: un solo
  proceso recalcula, con turno) y la difunde. Con 500 espectadores en un
  proceso sigue siendo una consulta por segundo, no 500.
* **Escrituras en este mismo proceso** despiertan al hilo al instante
  (``public_snapshots.on_change``): no espera al siguiente segundo.
* **Suscriptores lentos no se atrasan:** por vista se guarda solo el último
  mensaje pendiente; si un celular tarda, recibe directamente el más nuevo.
* **Latido** (comentario ``: latido``) cada ``public_sse_heartbeat_seconds``
  para que proxies y balanceadores no corten la conexión, y fin a los
  ``public_sse_max_seconds``: el navegador se reconecta solo y, con
  ``Last-Event-ID``, no vuelve a descargar lo que ya tiene.
* **Límite** de ``public_sse_max_connections`` conexiones por proceso: pasado
  el límite, 503 y el cliente sigue con el sondeo de siempre.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from sqlalchemy.orm import Session

from app.api.errors import NotFound
from app.config import get_settings
from app.db.base import utcnow
from app.services import public
from app.services import public_snapshots as snapshots

log = logging.getLogger("hajime.public_stream")


def compute_for(token: str, kind: str) -> Callable[[Session], dict[str, Any]]:
    """Función que arma la vista ``kind`` del torneo del token."""
    if kind == snapshots.LIVE:
        return lambda db: public.live(db, token)
    if kind == snapshots.PEOPLE:
        return lambda db: public.people(db, token)
    if kind.startswith("overlay:"):
        tatami_id = int(kind.split(":", 1)[1])
        return lambda db: public.overlay(db, token, tatami_id)
    if kind.startswith("category:"):
        category_id = int(kind.split(":", 1)[1])
        return lambda db: public.category(db, token, category_id)
    raise ValueError(kind)


def event_name(kind: str) -> str:
    return "overlay" if kind.startswith("overlay:") else kind


def event_data(kind: str, snap: snapshots.Snapshot) -> str:
    """Cuerpo del evento: la instantánea tal cual; el overlay, con su reloj adelantado."""
    if kind.startswith("overlay:"):
        return json.dumps(
            snapshots.age_overlay(json.loads(snap.body), snap.computed_at), ensure_ascii=False, separators=(",", ":")
        )
    return snap.body


# ---------------------------------------------------------------------------
# Suscriptores
# ---------------------------------------------------------------------------


@dataclass(eq=False)
class Subscriber:
    """Una conexión SSE. El hilo del torneo deja aquí el último mensaje de
    cada vista y avisa al bucle de eventos de la conexión."""

    kinds: frozenset[str]
    loop: asyncio.AbstractEventLoop
    wake: asyncio.Event = field(default_factory=asyncio.Event)
    sent: dict[str, str] = field(default_factory=dict)  # vista → etag ya enviado
    pending: dict[str, tuple[str, str]] = field(default_factory=dict)  # vista → (etag, datos)
    gone: bool = False
    lock: threading.Lock = field(default_factory=threading.Lock)

    def offer(self, kind: str, etag: str, data: str) -> None:
        with self.lock:
            if self.sent.get(kind) == etag and kind not in self.pending:
                return
            self.pending[kind] = (etag, data)
        self._notify()

    def close(self) -> None:
        self.gone = True
        self._notify()

    def _notify(self) -> None:
        try:
            self.loop.call_soon_threadsafe(self.wake.set)
        except RuntimeError:  # el bucle ya cerró: la conexión terminó
            pass

    def take(self) -> list[tuple[str, str, str]]:
        """Mensajes pendientes (vista, etag, datos), sin repetir lo ya enviado."""
        with self.lock:
            out = [(k, e, d) for k, (e, d) in self.pending.items() if self.sent.get(k) != e]
            self.pending.clear()
            for k, e, _ in out:
                self.sent[k] = e
        return out

    def last_event_id(self) -> str:
        return ";".join(f"{k}={e.strip(chr(34))}" for k, e in sorted(self.sent.items()))


def parse_last_event_id(value: str | None) -> dict[str, str]:
    """``Last-Event-ID`` de una reconexión → etag ya recibido por vista."""
    out: dict[str, str] = {}
    for part in (value or "").split(";")[:8]:
        kind, sep, etag = part.partition("=")
        if sep and kind and etag and len(etag) <= 40:
            out[kind] = f'"{etag}"'
    return out


# ---------------------------------------------------------------------------
# Un hilo por torneo con espectadores
# ---------------------------------------------------------------------------


class _Hub:
    def __init__(self, token: str):
        self.token = token
        self.tournament_id: int | None = None
        self.subs: set[Subscriber] = set()
        self.latest: dict[str, snapshots.Snapshot] = {}
        self.wake = threading.Event()
        self.thread = threading.Thread(target=self._run, name=f"sse-{token[:6]}", daemon=True)

    def kinds(self) -> set[str]:
        return {k for s in self.subs for k in s.kinds}

    def _run(self) -> None:
        interval = max(0.05, get_settings().public_sse_poll_seconds)
        while True:
            with _lock:
                if not self.subs:
                    _hubs.pop(self.token, None)
                    return
                kinds = self.kinds()
                subs = list(self.subs)
            try:
                self._poll(kinds, subs)
            except NotFound:  # el organizador desactivó o cambió el enlace
                with _lock:
                    gone, self.subs = list(self.subs), set()
                    _hubs.pop(self.token, None)
                for s in gone:
                    s.close()
                return
            except Exception:  # noqa: BLE001 - la base puede fallar un momento: se reintenta
                log.warning("Sondeo SSE del vivo falló", exc_info=True)
            self.wake.wait(interval)
            self.wake.clear()

    def _poll(self, kinds: set[str], subs: list[Subscriber]) -> None:
        with snapshots._session() as db:
            tid, rows = snapshots.versions(db, self.token)
        self.tournament_id = tid
        max_age = timedelta(seconds=get_settings().public_snapshot_max_age)
        now = utcnow()
        for kind in sorted(kinds):
            row, known = rows.get(kind), self.latest.get(kind)
            changed = (
                row is None
                or row.dirty
                or row.etag is None
                or known is None
                or known.etag != row.etag
                or row.computed_at is None
                or row.computed_at <= now - max_age
            )
            if not changed:
                continue
            try:
                snap = snapshots.get(self.token, kind, compute_for(self.token, kind), fresh=True)
            except NotFound:
                if kind == snapshots.LIVE:
                    raise
                continue  # p. ej. un tatami borrado: esa vista no se difunde
            if known is not None and known.etag == snap.etag:
                continue
            self.latest[kind] = snap
            data = event_data(kind, snap)
            for s in subs:
                if kind in s.kinds:
                    s.offer(kind, snap.etag, data)
        for kind in set(self.latest) - kinds:  # nadie mira ya esa vista
            self.latest.pop(kind, None)


_lock = threading.Lock()
_hubs: dict[str, _Hub] = {}
_active = 0


def _wake_tournaments(tids: set[int]) -> None:
    with _lock:
        hubs = [h for h in _hubs.values() if h.tournament_id in tids]
    for h in hubs:
        h.wake.set()


snapshots.on_change(_wake_tournaments)


def acquire() -> bool:
    """Reserva una de las conexiones SSE del proceso; False si ya no hay."""
    global _active
    with _lock:
        if _active >= max(0, get_settings().public_sse_max_connections):
            return False
        _active += 1
        return True


def release() -> None:
    global _active
    with _lock:
        _active = max(0, _active - 1)


def active_connections() -> int:
    return _active


def subscribe(token: str, sub: Subscriber) -> None:
    with _lock:
        hub = _hubs.get(token)
        start = hub is None
        if start:
            hub = _hubs[token] = _Hub(token)
        hub.subs.add(sub)
        latest = dict(hub.latest)
    for kind, snap in latest.items():  # lo último que el hilo ya tiene
        if kind in sub.kinds:
            sub.offer(kind, snap.etag, event_data(kind, snap))
    if start:
        hub.thread.start()
    else:
        hub.wake.set()


def unsubscribe(token: str, sub: Subscriber) -> None:
    with _lock:
        hub = _hubs.get(token)
        if hub is not None:
            hub.subs.discard(sub)
            if not hub.subs:
                hub.wake.set()  # el hilo termina en su próxima vuelta


def reset() -> None:
    """Pruebas: olvida los hilos y el contador (los hilos terminan solos)."""
    global _active
    with _lock:
        for hub in _hubs.values():
            for s in hub.subs:
                s.close()
            hub.subs.clear()
            hub.wake.set()
        _hubs.clear()
        _active = 0
