"""Qué avisar en un torneo: «te toca en ~N combates», «¡A tatami!», resultados y medallas.

Se recorre **un torneo a la vez, no un espectador a la vez**. El punto de partida
es el mismo que invalida la instantánea pública (``public_snapshots``): al
confirmar una escritura con torneo (cierres, cola, llaves, puntos de la mesa),
el oyente :func:`_on_change` anota el torneo y despierta al hilo de avisos de
ese proceso (``push.PushService``), que llama a :func:`evaluate` como mucho una
vez por segundo y torneo. La mesa no espera: el recorrido corre después del
commit, en otro hilo y con otra sesión.

:func:`evaluate` hace lo mismo que «¿cuándo pelea?»: carga el torneo por lotes,
arma la cola de cada tatami con ``schedule.timeline`` y, con una consulta, trae
a quién siguen las suscripciones de ese torneo (claves públicas, perfiles o
dojos). Con eso decide los avisos y los inserta en ``notification_outbox`` en
un solo INSERT. La unicidad ``(suscripción, tipo, ref)`` deduplica: se puede
recorrer el torneo cien veces (o en varios procesos a la vez) y cada aviso sale
una sola vez. Sin nadie que siga el torneo, el recorrido son dos consultas.

Reglas:

* **Turno** (preferencia ``turn``): cuando al competidor le faltan
  ``HAJIME_PUSH_SOON_AHEAD`` combates o menos en la cola de su tatami, «Te toca
  en ~N combates»; cuando todos los de delante están en curso (su combate es el
  siguiente), «¡A tatami!». Uno de cada tipo por combate y suscripción; si ya
  salió «¡A tatami!» no se manda el otro. Solo si la hora estimada está dentro
  de los próximos 90 min (una llave armada días antes no avisa). Vencen a los
  10 min (``push_turn_ttl_seconds``).
* **Resultado** (``results``): combates cerrados en los últimos 30 min, después
  de empezar a seguir al competidor.
* **Medallas** (``medals``): puestos 1 a 3 de categorías finalizadas, calculados
  en las últimas 2 h.

Privacidad: el nombre sigue la regla del portal (abreviado «Diego R.» por
defecto) y **siempre** abreviado para menores o edad desconocida.
"""

from __future__ import annotations

import logging
import threading
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import and_, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from app.config import get_settings
from app.db.base import utcnow
from app.db.models import (
    Category,
    CategoryResult,
    Match,
    NotificationOutbox,
    PushFollow,
    PushSubscription,
    Registration,
    Tournament,
)
from app.services import public_snapshots, push, schedule
from app.services.brackets import REG_LIGHT

log = logging.getLogger("hajime.push")

TURN_HORIZON = timedelta(minutes=90)
RESULT_WINDOW = timedelta(minutes=30)
MEDAL_WINDOW = timedelta(hours=2)
RESULT_TTL = 3600
MEDAL_TTL = 6 * 3600
MEDAL_NAME = {1: "oro", 2: "plata", 3: "bronce"}

# ---------------------------------------------------------------------------
# Torneos por recorrer (los anota el oyente de la instantánea pública)
# ---------------------------------------------------------------------------

_lock = threading.Lock()
_pending: set[int] = set()


def _on_change(tids: set[int]) -> None:
    if not push.enabled():
        return
    with _lock:
        _pending.update(tids)
    push.wake()


public_snapshots.on_change(_on_change)


def take_pending() -> set[int]:
    with _lock:
        out = set(_pending)
        _pending.clear()
    return out


def requeue(tids: set[int]) -> None:
    with _lock:
        _pending.update(tids)


def has_pending() -> bool:
    with _lock:
        return bool(_pending)


def evaluate_pending(session_factory: sessionmaker[Session], now: datetime | None = None) -> int:
    """Recorre ya los torneos anotados (lo usan las pruebas y el trabajador)."""
    n = 0
    for tid in sorted(take_pending()):
        with session_factory() as db:
            n += evaluate(db, tid, now)
    return n


def active_tournaments(db: Session) -> list[int]:
    """Torneos en curso: la pasada periódica los recorre aunque este proceso no haya visto cambios."""
    ids = list(db.scalars(select(Tournament.id).where(Tournament.status == "in_progress")).all())
    db.commit()
    return ids


# ---------------------------------------------------------------------------
# Recorrido de un torneo
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _Follower:
    created_at: datetime
    prefs: dict[str, Any] | None


def display_name(r: Registration, style: str) -> str:
    """Nombre según la regla del portal; los menores (o sin fecha de nacimiento), siempre abreviados."""
    from app.services.claims import is_minor
    from app.services.public import short_name

    if r.team is not None:
        return r.team.name
    p = r.person
    if p is None:
        return ""
    if style == "full" and not is_minor(p):
        return f"{p.first_names} {p.last_names}"
    return short_name(p.first_names, p.last_names)


def person_key(t: Tournament, r: Registration) -> str:
    from app.services.public import public_key

    return public_key(t.id, "e", r.team_id) if r.team_id else public_key(t.id, "p", r.person_id or -r.id)


def link(t: Tournament, r: Registration, key: str) -> str:
    """Vivo del torneo con el competidor resaltado o, sin página pública, su perfil público."""
    if t.public_token and t.public_slug:
        return f"/t/{t.public_slug}?seguir={key}"
    if r.team_id is None and r.person is not None and r.person.public_id:
        return f"/competidor/{r.person.public_id}"
    return "/"


def _hhmm(value: datetime | None, tz) -> str:
    if value is None:
        return ""
    return value.replace(tzinfo=UTC).astimezone(tz).strftime("%H:%M")


def _follows(db: Session, t: Tournament, now: datetime):
    regs = select(Registration.person_id).where(Registration.tournament_id == t.id, Registration.status == "active")
    dojos = select(Registration.dojo_id).where(Registration.tournament_id == t.id, Registration.status == "active")
    conds = [PushFollow.person_id.in_(regs), PushFollow.dojo_id.in_(dojos)]
    if t.public_token is not None:  # los favoritos del público solo mientras la página esté activa
        conds.append(
            and_(
                PushFollow.tournament_id == t.id,
                PushFollow.person_key.is_not(None),
                or_(PushFollow.expires_at.is_(None), PushFollow.expires_at > now),
            )
        )
    return db.execute(
        select(
            PushFollow.subscription_id,
            PushFollow.tournament_id,
            PushFollow.person_key,
            PushFollow.person_id,
            PushFollow.dojo_id,
            PushFollow.created_at,
            PushSubscription.preferences,
        )
        .join(PushSubscription, PushSubscription.id == PushFollow.subscription_id)
        .where(or_(*conds))
    ).all()


def evaluate(db: Session, tournament_id: int, now: datetime | None = None) -> int:
    """Encola los avisos que correspondan en el torneo. Devuelve cuántos encoló."""
    if not push.enabled():
        return 0
    s = get_settings()
    now = now or utcnow()
    t = db.get(Tournament, tournament_id)
    if t is None:
        return 0
    follows = _follows(db, t, now)
    if not follows:
        db.commit()
        return 0

    by_key: dict[str, dict[int, _Follower]] = defaultdict(dict)
    by_person: dict[int, dict[int, _Follower]] = defaultdict(dict)
    by_dojo: dict[int, dict[int, _Follower]] = defaultdict(dict)
    for sid, tid, key, pid, dojo_id, created, prefs in follows:
        f = _Follower(created, prefs)
        if key and tid == t.id:
            by_key[key][sid] = f
        elif pid:
            by_person[pid][sid] = f
        elif dojo_id:
            by_dojo[dojo_id][sid] = f

    cats = {c.id: c for c in db.scalars(select(Category).where(Category.tournament_id == t.id)).all()}
    matches = list(
        db.scalars(
            select(Match)
            .join(Category, Category.id == Match.category_id)
            .where(Category.tournament_id == t.id, Match.is_current, Match.parent_match_id.is_(None))
        ).all()
    )
    regs = {
        r.id: r
        for r in db.scalars(
            select(Registration)
            .where(Registration.tournament_id == t.id, Registration.status == "active")
            .options(*REG_LIGHT)
        ).all()
    }
    absent = {rid for rid, r in regs.items() if r.checkin_status == "absent"}
    keys: dict[int, str] = {}
    cache: dict[int, dict[int, _Follower]] = {}

    def followers(r: Registration) -> dict[int, _Follower]:
        """Suscripciones que siguen a la inscripción (por clave, persona o dojo), la más antigua gana."""
        if r.id not in cache:
            keys[r.id] = person_key(t, r)
            out: dict[int, _Follower] = {}
            groups = [by_key.get(keys[r.id], {}), by_dojo.get(r.dojo_id, {})]
            if r.team_id is None and r.person_id:
                groups.append(by_person.get(r.person_id, {}))
            for g in groups:
                for sid, f in g.items():
                    if sid not in out or f.created_at < out[sid].created_at:
                        out[sid] = f
            cache[r.id] = out
        return cache[r.id]

    done = set(
        db.execute(
            select(NotificationOutbox.subscription_id, NotificationOutbox.kind, NotificationOutbox.ref).where(
                NotificationOutbox.tournament_id == t.id
            )
        ).all()
    )
    rows: list[dict[str, Any]] = []
    style = t.public_names
    tz = schedule.zone(t.timezone)

    def add(sid: int, kind: str, ref: str, r: Registration, title: str, body: str, ttl: int, urgency: str) -> None:
        done.add((sid, kind, ref))
        tag = f"hajime-{ref}" if kind in ("soon", "next") else f"hajime-{kind}-{ref}"
        rows.append(
            push.outbox_row(
                sid,
                kind,
                ref,
                title,
                body,
                link(t, r, keys[r.id]),
                tournament_id=t.id,
                ttl=ttl,
                urgency=urgency,
                tag=tag,
            )
        )

    # --- Turno ---
    ahead_max = max(0, s.push_soon_ahead)
    lines = schedule.timeline(
        t, t.tatamis, cats.values(), matches, now=now, kata=schedule.load_kata(db, cats.values()), absent=absent
    )
    for tat in t.tatamis:
        slots = lines.get(tat.id, [])
        for i, slot in enumerate(slots[: ahead_max + 1]):
            if slot.status == "in_progress" or slot.eta is None or slot.eta > now + TURN_HORIZON:
                continue
            # Siguiente: todos los de delante están en curso (en general, i == 0 o 1).
            is_next = all(x.status == "in_progress" for x in slots[:i])
            ref = str(slot.key)
            c = cats.get(slot.category_id)
            cname = c.name if c is not None else ""
            for rid in slot.registrations:
                r = regs.get(rid)
                if r is None or rid in absent:
                    continue
                name = display_name(r, style)
                for sid, f in followers(r).items():
                    if not push.wants(f.prefs, "next") or (sid, "next", ref) in done:
                        continue
                    if is_next:
                        add(
                            sid,
                            "next",
                            ref,
                            r,
                            f"¡A tatami! {name}",
                            f"Es el siguiente en el tatami {tat.number} ({slot.number}) · {cname}",
                            s.push_turn_ttl_seconds,
                            "high",
                        )
                    elif (sid, "soon", ref) not in done:
                        when = _hhmm(slot.eta, tz)
                        add(
                            sid,
                            "soon",
                            ref,
                            r,
                            f"{name}: te toca en ~{i} combate{'' if i == 1 else 's'}",
                            f"Tatami {tat.number} · {slot.number} · {cname}" + (f" · hacia las {when}" if when else ""),
                            s.push_turn_ttl_seconds,
                            "high",
                        )

    # --- Resultados ---
    for m in matches:
        if (
            m.status != "finished"
            or m.finished_at is None
            or m.finished_at < now - RESULT_WINDOW
            or m.winner_registration_id is None
            or m.method == "bye"
        ):
            continue
        c = cats.get(m.category_id)
        sides = (
            (m.aka_registration_id, m.ao_registration_id, m.aka_score, m.ao_score),
            (m.ao_registration_id, m.aka_registration_id, m.ao_score, m.aka_score),
        )
        for rid, rival_id, mine, theirs in sides:
            r = regs.get(rid) if rid else None
            if r is None:
                continue
            won = m.winner_registration_id == rid
            name = display_name(r, style)
            rival = regs.get(rival_id) if rival_id else None
            score = f"({mine or 0}–{theirs or 0})"
            if rival is not None:
                title = f"{name} {'ganó' if won else 'perdió'} contra {display_name(rival, style)} {score}"
            else:
                title = f"{name} {'ganó' if won else 'perdió'} {score}"
            body = f"{c.name if c else ''} · {t.name}"
            for sid, f in followers(r).items():
                if f.created_at > m.finished_at or not push.wants(f.prefs, "result"):
                    continue
                if (sid, "result", f"m{m.id}") not in done:
                    add(sid, "result", f"m{m.id}", r, title, body, RESULT_TTL, "normal")

    # --- Medallas ---
    if any(c.status == "finished" for c in cats.values()):
        results = db.scalars(
            select(CategoryResult)
            .join(Category, Category.id == CategoryResult.category_id)
            .where(
                Category.tournament_id == t.id,
                Category.status == "finished",
                CategoryResult.place <= 3,
                CategoryResult.computed_at >= now - MEDAL_WINDOW,
            )
        ).all()
        for cr in results:
            r = regs.get(cr.registration_id)
            c = cats.get(cr.category_id)
            if r is None or c is None:
                continue
            ref = f"c{c.id}r{r.id}"
            title = f"{display_name(r, style)}: medalla de {MEDAL_NAME.get(cr.place, 'bronce')}"
            for sid, f in followers(r).items():
                if f.created_at > cr.computed_at or not push.wants(f.prefs, "medal") or (sid, "medal", ref) in done:
                    continue
                add(sid, "medal", ref, r, title, f"{c.name} · {t.name}", MEDAL_TTL, "normal")

    db.commit()  # termina la lectura
    return _insert(db, t.id, rows)


def _insert(db: Session, tid: int, rows: list[dict[str, Any]]) -> int:
    """Un solo INSERT. Si otro proceso encoló alguno a la vez (unicidad), se reintenta con los que faltan."""
    if not rows:
        return 0
    for attempt in (1, 2):
        try:
            db.execute(NotificationOutbox.__table__.insert(), rows)
            db.commit()
            push.wake()
            return len(rows)
        except IntegrityError:
            db.rollback()
            if attempt == 2:
                log.warning(
                    "Avisos del torneo %s: no se pudieron encolar (se reintentará en el próximo recorrido)", tid
                )
                return 0
            done = set(
                db.execute(
                    select(NotificationOutbox.subscription_id, NotificationOutbox.kind, NotificationOutbox.ref).where(
                        NotificationOutbox.tournament_id == tid
                    )
                ).all()
            )
            db.commit()
            rows = [r for r in rows if (r["subscription_id"], r["kind"], r["ref"]) not in done]
            if not rows:
                return 0
    return 0  # pragma: no cover
