"""Instantánea compartida del vivo público (tabla ``public_snapshots``).

Por qué: en Azure hay hasta 6 procesos (2 por copia × 3 copias) y la caché en
memoria de cada uno casi nunca acertaba; cada fallo recalculaba el vivo entero
(~0,5 s de consultas a Azure SQL) y, si llegaban cuatro espectadores a la vez,
lo calculaban los cuatro. Con 200 espectadores las mesas esperaban 20–28 s.

Cómo funciona:

* **Escritura → ``invalidate(db, tournament_id)``.** Solo anota el torneo en la
  sesión; justo antes del ``commit`` se marca ``dirty`` su instantánea con un
  único UPDATE, dentro de la misma transacción (si la escritura se deshace, la
  marca también). Se llama desde pocos puntos comunes, no en cada servicio:

  - ``audit()`` (``app.services.audit``) cuando recibe ``tournament_id``: cierres
    de combate, banderas y notas de kata, alineaciones, intercambio de
    posiciones, llaves, cambios de categoría (tatami, cola, estado), retiros e
    inscripciones, activar o desactivar el vivo…
  - ``brackets.sync()``: toda escritura que recalcula una llave.
  - ``brackets.add_event()``: los puntos y el reloj de la mesa, lo más frecuente,
    que no se auditan (salvo las correcciones).

  Lo que no pase por ahí (p. ej. corregir el nombre de una persona) se ve igual
  al vencer la instantánea (``public_snapshot_max_age``, 30 s).

* **Lectura → ``get(token, kind, compute)``.** Primero una caché en memoria de
  hasta 1,5 s; después una sola consulta que trae el torneo del token y su
  instantánea. Si está limpia y es reciente se devuelve tal cual (el JSON ya
  serializado). Si está sucia, un proceso toma el «turno» con un UPDATE
  atómico (``lease_until``) y la recalcula; los demás devuelven la anterior
  mientras tanto. Dentro de un proceso, además, solo un hilo por clave consulta
  la base a la vez (los demás esperan su resultado o usan el anterior).

El turno limpia ``dirty`` al tomarse: si una mesa escribe mientras se calcula,
su marca queda puesta y el siguiente lector recalcula. Nada se pierde.
"""

from __future__ import annotations

import hashlib
import json
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from fastapi.encoders import jsonable_encoder
from sqlalchemy import and_, delete, event, or_, select, true, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.errors import NotFound
from app.config import get_settings
from app.db.base import get_session, utcnow
from app.db.models import PublicSnapshot, Tournament

LIVE = "live"
PEOPLE = "people"  # «¿cuándo pelea?»: competidores y su próximo combate
LEASE = timedelta(seconds=5)  # tiempo máximo que un proceso se reserva el cálculo
WAIT_FIRST = 3.0  # sin instantánea previa: cuánto se espera a que otro la termine
MEMORY_MAX = 1.5  # segundos de la caché en memoria delante de la base

_PENDING = "hajime_public_dirty"
_COMMITTING = "hajime_public_committing"


def overlay_kind(tatami_id: int) -> str:
    return f"overlay:{tatami_id}"


# ---------------------------------------------------------------------------
# Invalidación
# ---------------------------------------------------------------------------


def invalidate(db: Session, tournament_id: int | None) -> None:
    """Marca como vencido el vivo (y los overlays) del torneo al confirmar la transacción."""
    if tournament_id is not None:
        db.info.setdefault(_PENDING, set()).add(int(tournament_id))


@event.listens_for(Session, "before_commit")
def _mark_dirty(session: Session) -> None:
    tids = session.info.pop(_PENDING, None)
    if not tids:
        return
    # Primero lo pendiente y al final la marca: la fila compartida por todas las
    # mesas del torneo queda bloqueada lo menos posible (hasta el commit).
    session.flush()
    session.execute(
        update(PublicSnapshot)
        .where(PublicSnapshot.tournament_id.in_(sorted(tids)), ~PublicSnapshot.dirty)
        .values(dirty=True)
        .execution_options(synchronize_session=False)
    )
    session.info[_COMMITTING] = tids


@event.listens_for(Session, "after_commit")
def _forget_local(session: Session) -> None:
    tids = session.info.pop(_COMMITTING, None)
    if tids:  # este proceso ve el cambio al instante; los demás, al vencer su caché en memoria
        with _lock:
            for key in [k for k, (_, snap) in _memory.items() if snap.tournament_id in tids]:
                _memory.pop(key, None)
        for listener in list(_listeners):  # p. ej. la difusión por SSE de este proceso (public_stream)
            try:
                listener(set(tids))
            except Exception:  # noqa: BLE001 - un oyente no puede romper un commit ya hecho
                pass


# Funciones que se enteran de qué torneos cambiaron al confirmar una escritura en este proceso.
_listeners: list[Callable[[set[int]], None]] = []


def on_change(listener: Callable[[set[int]], None]) -> None:
    if listener not in _listeners:
        _listeners.append(listener)


@event.listens_for(Session, "after_rollback")
def _discard(session: Session) -> None:
    session.info.pop(_PENDING, None)
    session.info.pop(_COMMITTING, None)


# ---------------------------------------------------------------------------
# Lectura
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Snapshot:
    tournament_id: int
    body: str  # JSON listo para enviar
    etag: str
    computed_at: datetime  # UTC sin zona, como el resto de la base


_lock = threading.Lock()
_memory: dict[tuple[str, str], tuple[float, Snapshot]] = {}
_flights: dict[tuple[str, str], threading.Event] = {}


def clear_memory() -> None:
    with _lock:
        _memory.clear()


def get(token: str, kind: str, compute: Callable[[Session], dict[str, Any]], *, fresh: bool = False) -> Snapshot:
    """Instantánea vigente de ``kind`` para el torneo del token (``NotFound`` si no existe).

    ``fresh``: sin pasar por la caché en memoria (la difusión por SSE ya sabe,
    por ``versions``, que la de la base cambió)."""
    key = (token, kind)
    ttl = min(MEMORY_MAX, get_settings().public_cache_seconds)
    while True:
        with _lock:
            hit = _memory.get(key)
            if hit and hit[0] > time.monotonic() and not fresh:
                return hit[1]
            flight = _flights.get(key)
            leader = flight is None
            if leader:
                flight = _flights[key] = threading.Event()
        if not leader:
            if hit:  # otro hilo la está actualizando: mientras tanto, la anterior
                return hit[1]
            flight.wait(10)
            continue  # si el otro hilo falló, este lo intenta
        try:
            snap = _fetch(token, kind, compute)
            with _lock:
                _memory[key] = (time.monotonic() + ttl, snap)
                if len(_memory) > 500:  # torneos viejos: se limpia lo vencido
                    now = time.monotonic()
                    for k in [k for k, (exp, _) in _memory.items() if exp <= now]:
                        _memory.pop(k, None)
            return snap
        finally:
            with _lock:
                _flights.pop(key, None)
            flight.set()


def serialize(data: dict[str, Any]) -> tuple[str, str]:
    """JSON compacto (como JSONResponse) y su ETag. La hora del servidor no
    cuenta para el ETag: si nada más cambió, el navegador recibe 304."""
    enc = jsonable_encoder(data)
    body = json.dumps(enc, ensure_ascii=False, separators=(",", ":"))
    stable = json.dumps({k: v for k, v in enc.items() if k != "server_time"}, ensure_ascii=False, sort_keys=True)
    return body, '"' + hashlib.sha1(stable.encode()).hexdigest()[:20] + '"'


@contextmanager
def _session() -> Iterator[Session]:
    gen = get_session()
    db = next(gen)
    try:
        yield db
    finally:
        gen.close()


def _read(db: Session, token: str, kind: str):
    row = db.execute(
        select(
            Tournament.id,
            PublicSnapshot.kind,
            PublicSnapshot.payload,
            PublicSnapshot.etag,
            PublicSnapshot.computed_at,
            PublicSnapshot.dirty,
        )
        .outerjoin(PublicSnapshot, and_(PublicSnapshot.tournament_id == Tournament.id, PublicSnapshot.kind == kind))
        .where(Tournament.public_token == token)
    ).first()
    db.commit()  # termina la lectura: la siguiente ve lo último confirmado
    if row is None:
        raise NotFound("Este enlace de seguimiento no existe o fue desactivado")
    return row


def versions(db: Session, token: str) -> tuple[int, dict[str, Any]]:
    """Una consulta: id del torneo del token y estado de todas sus instantáneas
    (etag, dirty, computed_at por vista). ``NotFound`` si el enlace no existe."""
    rows = db.execute(
        select(
            Tournament.id,
            PublicSnapshot.kind,
            PublicSnapshot.etag,
            PublicSnapshot.dirty,
            PublicSnapshot.computed_at,
        )
        .outerjoin(PublicSnapshot, PublicSnapshot.tournament_id == Tournament.id)
        .where(Tournament.public_token == token)
    ).all()
    db.commit()
    if not rows:
        raise NotFound("Este enlace de seguimiento no existe o fue desactivado")
    return rows[0].id, {r.kind: r for r in rows if r.kind is not None}


def _snap(tid: int, row) -> Snapshot:
    return Snapshot(tid, row.payload, row.etag, row.computed_at)


def _fetch(token: str, kind: str, compute: Callable[[Session], dict[str, Any]]) -> Snapshot:
    max_age = timedelta(seconds=get_settings().public_snapshot_max_age)
    with _session() as db:
        row = _read(db, token, kind)
        tid = row.id
        now = utcnow()
        fresh = row.payload is not None and not row.dirty and row.computed_at and row.computed_at > now - max_age
        if fresh:
            return _snap(tid, row)
        owner = _claim(db, tid, kind, exists=row.kind is not None, now=now, max_age=max_age)
        if not owner:
            if row.payload is not None:  # otro proceso la recalcula: mientras, la anterior
                return _snap(tid, row)
            deadline = time.monotonic() + WAIT_FIRST
            while time.monotonic() < deadline:
                time.sleep(0.15)
                row = _read(db, token, kind)
                if row.payload is not None:
                    return _snap(tid, row)
            # Nadie la terminó a tiempo (¿se cayó?): se calcula aquí.
        return _compute(db, tid, kind, compute, owner)


def _claim(db: Session, tid: int, kind: str, *, exists: bool, now: datetime, max_age: timedelta) -> bool:
    """Toma el turno de cálculo de forma atómica entre procesos y copias."""
    if not exists:
        db.add(PublicSnapshot(tournament_id=tid, kind=kind, dirty=False, lease_until=now + LEASE))
        try:
            db.commit()
            return True
        except IntegrityError:  # otro proceso la creó en el mismo instante
            db.rollback()
            return False
    res = db.execute(
        update(PublicSnapshot)
        .where(
            PublicSnapshot.tournament_id == tid,
            PublicSnapshot.kind == kind,
            or_(PublicSnapshot.lease_until.is_(None), PublicSnapshot.lease_until < now),
            or_(
                PublicSnapshot.dirty == true(),
                PublicSnapshot.computed_at.is_(None),
                PublicSnapshot.computed_at <= now - max_age,
            ),
        )
        .values(lease_until=now + LEASE, dirty=False)
        .execution_options(synchronize_session=False)
    )
    db.commit()
    return res.rowcount == 1


def _compute(db: Session, tid: int, kind: str, compute: Callable[[Session], dict[str, Any]], owner: bool) -> Snapshot:
    started = utcnow()
    where = (PublicSnapshot.tournament_id == tid, PublicSnapshot.kind == kind)
    try:
        body, etag = serialize(compute(db))
    except Exception:
        db.rollback()
        if owner:  # se libera el turno; si nunca hubo instantánea (p. ej. tatami inexistente), no queda fila
            db.execute(delete(PublicSnapshot).where(*where, PublicSnapshot.payload.is_(None)))
            db.execute(update(PublicSnapshot).where(*where).values(lease_until=None, dirty=True))
            db.commit()
        raise
    db.rollback()  # el cálculo solo lee
    db.execute(
        update(PublicSnapshot)
        .where(*where)
        .values(payload=body, etag=etag, computed_at=started, lease_until=None)
        .execution_options(synchronize_session=False)
    )
    db.commit()
    return Snapshot(tid, body, etag, started)


def compute_now(compute: Callable[[Session], dict[str, Any]]) -> dict[str, Any]:
    """Sin caché (``public_cache_seconds <= 0``): se calcula en cada petición."""
    with _session() as db:
        return compute(db)


def etag_matches(if_none_match: str | None, etag: str) -> bool:
    if not if_none_match:
        return False
    if if_none_match.strip() == "*":
        return True
    return any(tag.strip().removeprefix("W/") == etag for tag in if_none_match.split(","))


def age_overlay(data: dict[str, Any], computed_at: datetime) -> dict[str, Any]:
    """El reloj del overlay corre entre instantáneas: se adelanta lo que pasó desde el cálculo."""
    m = data.get("match")
    now = utcnow()
    if m and m.get("running"):
        m["elapsed"] = round(m["elapsed"] + max(0.0, (now - computed_at).total_seconds()), 1)
    data["server_time"] = now.isoformat() + "Z"
    return data
