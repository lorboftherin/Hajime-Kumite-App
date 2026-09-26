"""Seguimiento en vivo público y overlay para transmisiones (inspirado en CricHeroes).

Es opcional por torneo: el organizador lo activa y obtiene un enlace secreto
(sin inicio de sesión). Por la Ley 29733 y porque muchos competidores son
menores, solo se publica lo necesario para seguir el torneo: nombre (abreviado
por defecto: «Diego R.»), dojo, marcadores, llaves y medallero. Nunca
documentos, fechas de nacimiento ni identificadores de personas.
"""

from __future__ import annotations

import hashlib
import re
import secrets
import threading
import time
import unicodedata
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.api import schemas as s
from app.api.errors import Conflict, NotFound
from app.db.base import utcnow
from app.db.models import Category, CategoryResult, Match, Person, Registration, Tatami, Tournament, User
from app.domain.kumite import compute_scoreboard
from app.services import reports, schedule
from app.services import stats as stats_svc
from app.services.audit import audit, bump
from app.services.brackets import (
    REG_LIGHT,
    SCHEDULED,
    _domain_events,
    _events,
    bracket_out,
    queue_order,
    registrations_by_id,
    schedule_items,
)
from app.services.tournaments import effective_kumite_rules, get_tournament

# ---------------------------------------------------------------------------
# Dirección fija (/t/<slug>)
# ---------------------------------------------------------------------------

SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
SLUG_MIN, SLUG_MAX = 3, 80


def slugify(name: str, year: int) -> str:
    """«Copa Lima Kids» + 2026 → «copa-lima-kids-2026» (sin tildes ni símbolos)."""
    base = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode().lower()
    base = re.sub(r"[^a-z0-9]+", "-", base).strip("-")[:60].strip("-") or "torneo"
    return base if str(year) in base.split("-") else f"{base}-{year}"


def _slug_taken(db: Session, slug: str, tid: int) -> bool:
    return db.scalar(select(Tournament.id).where(Tournament.public_slug == slug, Tournament.id != tid)) is not None


def _unique_slug(db: Session, base: str, tid: int) -> str:
    slug, n = base, 2
    while _slug_taken(db, slug, tid):
        slug, n = f"{base}-{n}", n + 1
    return slug


def _check_slug(db: Session, raw: str, tid: int) -> str:
    slug = raw.strip().lower()
    if not (SLUG_MIN <= len(slug) <= SLUG_MAX) or not SLUG_RE.match(slug):
        raise Conflict(
            "La dirección solo puede tener letras minúsculas sin tildes, números y guiones (3 a 80 caracteres)",
            code="INVALID_SLUG",
        )
    if _slug_taken(db, slug, tid):
        raise Conflict("Esa dirección ya la usa otro torneo", code="SLUG_TAKEN")
    return slug


def set_public(db: Session, user: User, tid: int, data: s.PublicLiveIn) -> Tournament:
    t = get_tournament(db, tid)
    before = {"public": t.public_token is not None, "names": t.public_names, "slug": t.public_slug}
    if not data.enabled:
        t.public_token = None
    elif t.public_token is None or data.regenerate:
        t.public_token = secrets.token_urlsafe(24)
    t.public_names = data.names
    # La dirección fija se conserva al desactivar: al volver a activar, el mismo enlace.
    if data.slug is not None:
        t.public_slug = _check_slug(db, data.slug, t.id)
    elif data.enabled and not t.public_slug:
        t.public_slug = _unique_slug(db, slugify(t.name, t.start_date.year), t.id)
    bump(t, user)
    audit(
        db,
        user,
        "tournament",
        t.id,
        "public_live",
        before,
        {
            "public": t.public_token is not None,
            "names": t.public_names,
            "slug": t.public_slug,
            "regenerated": data.regenerate,
        },
        tournament_id=t.id,
    )
    db.commit()
    db.refresh(t)
    forget_slugs()
    return t


def by_token(db: Session, token: str) -> Tournament:
    t = db.scalar(select(Tournament).where(Tournament.public_token == token)) if token else None
    if t is None:
        raise NotFound("Este enlace de seguimiento no existe o fue desactivado")
    return t


# Dirección fija → token, por proceso y por pocos segundos: la instantánea
# compartida se guarda por token, así /t/<slug> y /vivo/<token> la comparten.
SLUG_TTL = 5.0
_slug_lock = threading.Lock()
_slug_cache: dict[str, tuple[float, str | None]] = {}


def forget_slugs() -> None:
    with _slug_lock:
        _slug_cache.clear()


def token_for_slug(db: Session, slug: str) -> str:
    """Token del torneo con esa dirección fija y el público activo (``NotFound`` si no)."""
    now = time.monotonic()
    with _slug_lock:
        hit = _slug_cache.get(slug)
    if hit is None or hit[0] <= now:
        token = db.scalar(
            select(Tournament.public_token).where(
                Tournament.public_slug == slug.lower(), Tournament.public_token.is_not(None)
            )
        )
        db.commit()
        with _slug_lock:
            if len(_slug_cache) > 2000:
                _slug_cache.clear()
            _slug_cache[slug] = hit = (now + SLUG_TTL, token)
    if not hit[1]:
        raise NotFound("Este torneo no existe o no tiene la página pública activa")
    return hit[1]


def short_name(first: str, last: str) -> str:
    first_word = (first or "").split()[0] if (first or "").split() else ""
    initial = (last or "").strip()[:1]
    return f"{first_word} {initial}." if initial else first_word


def _styled(first: str, last: str, style: str) -> str:
    return f"{first} {last}" if style == "full" else short_name(first, last)


def _person_name(p: Person | None, style: str) -> str:
    if p is None:
        return ""
    return _styled(p.first_names, p.last_names, style)


def _reg_name(r: Registration | None, style: str) -> str:
    if r is None:
        return ""
    if r.team is not None:
        return r.team.name
    return _person_name(r.person, style)


# ---------------------------------------------------------------------------
# Datos del torneo, cargados por lotes
# ---------------------------------------------------------------------------
#
# En Azure SQL cada consulta es un viaje de red: antes el vivo hacía una por
# inscripción, persona, combate en curso, categoría y premio (200–250 en un
# torneo de 8 tatamis, ~0,5 s). Ahora carga cada tipo de fila una sola vez y
# arma todo en memoria: unas diez consultas sin importar el tamaño.


@dataclass
class _Rows:
    style: str
    registrations: dict[int, Registration]
    persons: dict[int, tuple[str, str]] = field(default_factory=dict)  # integrantes de equipos
    bouts: dict[int, Match] = field(default_factory=dict)  # enfrentamiento → combate individual en curso

    def person(self, pid: int | None) -> str:
        if pid is None or pid not in self.persons:
            return ""
        return _styled(*self.persons[pid], self.style)

    def side(self, m: Match, color: str) -> dict[str, Any] | None:
        r = self.registrations.get(m.aka_registration_id if color == "aka" else m.ao_registration_id)
        if r is None:
            return None
        pid = m.aka_person_id if color == "aka" else m.ao_person_id
        if pid:  # combate de un enfrentamiento por equipos: el integrante, con su equipo
            return {"name": self.person(pid), "dojo": r.display_name}
        return {"name": _reg_name(r, self.style), "dojo": r.dojo.name}


def _load_persons(db: Session, ids: set[int]) -> dict[int, tuple[str, str]]:
    if not ids:
        return {}
    rows = db.execute(select(Person.id, Person.first_names, Person.last_names).where(Person.id.in_(ids))).all()
    return {pid: (first, last) for pid, first, last in rows}


def _bouts(matches: list[Match]) -> dict[int, Match]:
    """Combate individual en curso de cada enfrentamiento por equipos (el de mayor número)."""
    out: dict[int, Match] = {}
    for m in matches:
        if m.parent_match_id is not None and m.status == "in_progress":
            cur = out.get(m.parent_match_id)
            if cur is None or (m.bout_number or 0) > (cur.bout_number or 0):
                out[m.parent_match_id] = m
    return out


def _match_item(rows: _Rows, m: Match, number: str | None = None, category: str = "") -> dict[str, Any]:
    winner = None
    if m.winner_registration_id is not None:
        winner = "aka" if m.winner_registration_id == m.aka_registration_id else "ao"
    return {
        "number": number,
        "code": m.code,
        "category": category,
        "status": m.status,
        "aka": rows.side(m, "aka"),
        "ao": rows.side(m, "ao"),
        "score": [m.aka_score or 0, m.ao_score or 0],
        "winner": winner,
        "method": m.method,
    }


def live(db: Session, token: str) -> dict[str, Any]:
    """Todo lo que ve el público: tatamis en vivo, resultados, medallero y premios."""
    t = by_token(db, token)
    style = t.public_names
    cats = {
        c.id: c
        for c in db.scalars(
            select(Category).where(Category.tournament_id == t.id).order_by(Category.sort_order, Category.id)
        ).all()
    }
    matches = list(
        db.scalars(
            select(Match)
            .join(Category, Category.id == Match.category_id)
            .where(Category.tournament_id == t.id, Match.is_current)
        ).all()
    )
    regs = {
        r.id: r
        for r in db.scalars(select(Registration).where(Registration.tournament_id == t.id).options(*REG_LIGHT)).all()
    }
    results = list(
        db.scalars(
            select(CategoryResult)
            .join(Category, Category.id == CategoryResult.category_id)
            .where(Category.tournament_id == t.id)
            .order_by(CategoryResult.place, CategoryResult.id)
        ).all()
    )
    member_ids = {pid for m in matches for pid in (m.aka_person_id, m.ao_person_id) if pid}
    rows = _Rows(style, regs, _load_persons(db, member_ids), _bouts(matches))

    tatamis = []
    scheduled = schedule_items(t.tatamis, queue_order([c for c in cats.values() if c.tatami_id]), matches)
    tz = schedule.zone(t.timezone)
    etas = schedule.plan(t, t.tatamis, cats.values(), matches, sched=scheduled)
    for tat in t.tatamis:
        sched = scheduled[tat.id]
        open_items = [it for it in sched if it["match"].status in ("ready", "in_progress", "needs_review")]
        current = next((it for it in open_items if it["match"].status == "in_progress"), None)
        upcoming = [it for it in open_items if it is not current][:3]

        def item(it):
            m = it["match"]
            out = _match_item(rows, m, it["number"], it["category_name"])
            out["category_id"] = it["category_id"]
            out["eta"] = schedule.iso_local(etas.get(m.id), tz)
            bout = rows.bouts.get(m.id)
            if bout is not None:
                out["bout"] = _match_item(rows, bout, None, it["category_name"])
            return out

        done = [it for it in sched if it["match"].status == "finished"]
        tatamis.append(
            {
                "id": tat.id,
                "number": tat.number,
                "name": tat.name,
                "current": item(current) if current else None,
                "upcoming": [item(it) for it in upcoming],
                "last": item(done[-1]) if done else None,
                "done": len(done),
                "total": len(sched),
            }
        )

    by_cat: dict[int, list[CategoryResult]] = defaultdict(list)
    for cr in results:
        if cr.registration_id in regs:
            by_cat[cr.category_id].append(cr)
    public_results = []
    tally: dict[int, list[int]] = defaultdict(lambda: [0, 0, 0])
    dojo_names: dict[int, str] = {}
    for c in cats.values():
        if c.status != "finished" or not by_cat[c.id]:
            continue
        places = []
        for cr in by_cat[c.id]:
            r = regs[cr.registration_id]
            places.append({"place": cr.place, "name": _reg_name(r, style), "dojo": r.dojo.name})
            if cr.place in (1, 2, 3):
                tally[r.dojo_id][cr.place - 1] += 1
                dojo_names[r.dojo_id] = r.dojo.name
        public_results.append({"category_id": c.id, "category": c.name, "places": places})

    leaders = stats_svc.tournament_leaders(
        db,
        t.id,
        pre=stats_svc.Preload(
            matches,
            cats,
            regs,
            results,
            {pid: f"{first} {last}" for pid, (first, last) in rows.persons.items()},
        ),
    )
    known = {r.person_id: (r.person.first_names, r.person.last_names) for r in regs.values() if r.person_id}
    award_ids = {a["person_id"] for a in leaders["awards"] if a.get("person_id")}
    rows.persons |= known
    rows.persons |= _load_persons(db, award_ids - set(rows.persons))  # p. ej. titular sin combates
    awards = [
        {
            "title": a["title"],
            "detail": a["detail"],
            "name": rows.person(a["person_id"]) if a.get("person_id") in rows.persons else a["name"],
            "dojo": a["dojo"],
            "value": a["value"],
        }
        for a in leaders["awards"]
    ]
    return {
        "tournament": {
            "name": t.name,
            "start_date": t.start_date,
            "end_date": t.end_date,
            "venue": t.venue,
            "city": t.city,
            "status": t.status,
            "slug": t.public_slug,
            "timezone": t.timezone,
        },
        "tatamis": tatamis,
        "categories": [
            {"id": c.id, "name": c.name, "modality": c.modality, "status": c.status}
            for c in cats.values()
            if c.status not in ("merged", "cancelled", "empty")
        ],
        "results": public_results,
        "medal_table": [
            {k: row[k] for k in ("rank", "dojo_name", "gold", "silver", "bronze", "total")}
            for row in reports.rank_medals(tally, dojo_names)
        ],
        "awards": awards,
        "server_time": utcnow().isoformat() + "Z",
    }


def overlay(db: Session, token: str, tatami_id: int) -> dict[str, Any]:
    """Marcador del tatami para el overlay de la transmisión (OBS, vMix…)."""
    t = by_token(db, token)
    tat = db.get(Tatami, tatami_id)
    if tat is None or tat.tournament_id != t.id:
        raise NotFound("Tatami no encontrado")
    style = t.public_names
    cats = queue_order(
        db.scalars(select(Category).where(Category.tatami_id == tat.id, Category.status.in_(SCHEDULED))).all()
    )
    matches = (
        list(db.scalars(select(Match).where(Match.category_id.in_([c.id for c in cats]), Match.is_current)).all())
        if cats
        else []
    )
    sched = schedule_items([tat], cats, matches)[tat.id]
    live_it = next((it for it in sched if it["match"].status == "in_progress"), None)
    it = live_it or next((it for it in sched if it["match"].status in ("ready", "needs_review")), None)
    base = {
        "tournament": t.name,
        "tatami": {"number": tat.number, "name": tat.name},
        "server_time": utcnow().isoformat() + "Z",
        "next": None,
    }
    if it is None:
        return {**base, "match": None}
    m = it["match"]
    bout = _bouts(matches).get(m.id)
    # El siguiente combate del tatami (pantalla grande del coliseo).
    after = sched[sched.index(it) + 1 :]
    nxt = next((x for x in after if x["match"].status in ("ready", "pending")), None)
    ids = {x for x in (m.aka_registration_id, m.ao_registration_id) if x}
    if nxt is not None:
        ids |= {x for x in (nxt["match"].aka_registration_id, nxt["match"].ao_registration_id) if x}
    rows = _Rows(style, registrations_by_id(db, ids))
    base["next"] = (
        {
            "number": nxt["number"],
            "category": nxt["category_name"],
            "aka": rows.side(nxt["match"], "aka"),
            "ao": rows.side(nxt["match"], "ao"),
        }
        if nxt is not None
        else None
    )
    team = None
    if bout is not None:
        rows.persons = _load_persons(db, {x for x in (bout.aka_person_id, bout.ao_person_id) if x})
        team = {
            "aka": _reg_name(rows.registrations.get(m.aka_registration_id), style),
            "ao": _reg_name(rows.registrations.get(m.ao_registration_id), style),
            "wins": [m.aka_score or 0, m.ao_score or 0],
            "bout": bout.bout_number,
            "extra": bout.kind == "bout_extra",
        }
        m = bout
    # Marcador desde los eventos, como la mesa (sin armar la respuesta completa de la mesa).
    rules = effective_kumite_rules(next(c for c in cats if c.id == m.category_id), t)
    sb = compute_scoreboard(_domain_events(_events(db, m.id)), rules, now=utcnow())
    labels = list(rules.sanction_levels)
    return {
        **base,
        "match": {
            "number": it["number"],
            "code": m.code,
            "category": it["category_name"],
            "status": m.status,
            "aka": rows.side(m, "aka"),
            "ao": rows.side(m, "ao"),
            "score": [sb.score["aka"], sb.score["ao"]],
            "sanction": [
                labels[sb.sanction["aka"] - 1] if sb.sanction["aka"] else None,
                labels[sb.sanction["ao"] - 1] if sb.sanction["ao"] else None,
            ],
            "senshu": sb.senshu,
            "elapsed": round(sb.elapsed_seconds, 1),
            "running": sb.running,
            "duration": rules.duration_seconds,
            "winner": sb.winner if m.status == "finished" else None,
            "team": team,
        },
    }


# ---------------------------------------------------------------------------
# «¿Cuándo pelea?»: competidores con su próximo combate
# ---------------------------------------------------------------------------

OPEN = ("pending", "ready", "in_progress")


def public_key(tid: int, kind: str, ident: int) -> str:
    """Clave estable y opaca de un competidor en la vista pública (para favoritos):
    no es el id de la persona y no sirve en otro torneo."""
    raw = f"{tid}:{kind}:{ident}".encode()
    return hashlib.blake2b(raw, digest_size=6, key=b"hajime-publico").hexdigest()


def people(db: Session, token: str) -> dict[str, Any]:
    """Lista compacta para buscar por nombre o dojo y seguir favoritos.

    Por competidor (persona o equipo): nombre según la regla del torneo, dojo
    y, por categoría, su próximo combate (tatami, número, cuántos faltan antes
    y hora estimada) o su puesto. Nada de documentos, fechas de nacimiento ni
    ids de personas. Seis consultas, sin importar el tamaño del torneo.
    """
    t = by_token(db, token)
    style = t.public_names
    cats = {
        c.id: c
        for c in db.scalars(
            select(Category).where(Category.tournament_id == t.id).order_by(Category.sort_order, Category.id)
        ).all()
    }
    matches = list(
        db.scalars(
            select(Match)
            .join(Category, Category.id == Match.category_id)
            .where(Category.tournament_id == t.id, Match.is_current, Match.parent_match_id.is_(None))
        ).all()
    )
    regs = [
        r
        for r in db.scalars(
            select(Registration)
            .where(Registration.tournament_id == t.id, Registration.status == "active")
            .options(*REG_LIGHT)
        ).all()
        if r.category_id in cats and cats[r.category_id].status not in ("merged", "cancelled", "empty")
    ]
    places = {
        (cr.category_id, cr.registration_id): cr.place
        for cr in db.scalars(
            select(CategoryResult)
            .join(Category, Category.id == CategoryResult.category_id)
            .where(Category.tournament_id == t.id)
        ).all()
    }
    scheduled = schedule_items(t.tatamis, queue_order([c for c in cats.values() if c.tatami_id]), matches)
    tz = schedule.zone(t.timezone)
    etas = schedule.plan(t, t.tatamis, cats.values(), matches, sched=scheduled)

    # Próximo combate de cada inscripción: el primero de la cola de su tatami.
    upcoming: dict[int, dict[str, Any]] = {}
    for tat in t.tatamis:
        ahead = 0
        for it in scheduled[tat.id]:
            m = it["match"]
            if m.status not in OPEN:
                continue
            info = {
                "tatami": tat.number,
                "tatami_name": tat.name,
                "number": it["number"],
                "code": m.code,
                "status": m.status,
                "ahead": ahead,
                "eta": schedule.iso_local(etas.get(m.id), tz),
            }
            for rid in (m.aka_registration_id, m.ao_registration_id):
                if rid and rid not in upcoming:
                    upcoming[rid] = info
            ahead += 1

    groups: dict[tuple[str, int], dict[str, Any]] = {}
    for r in sorted(regs, key=lambda r: (cats[r.category_id].sort_order, r.category_id, r.id)):
        kind, ident = ("e", r.team_id) if r.team_id else ("p", r.person_id or -r.id)
        c = cats[r.category_id]
        g = groups.setdefault(
            (kind, ident),
            {
                "key": public_key(t.id, kind, ident),
                "name": _reg_name(r, style),
                "dojo": r.dojo.name,
                "team": kind == "e",
                "entries": [],
            },
        )
        nxt = upcoming.get(r.id)
        place = places.get((c.id, r.id))
        if nxt is not None:
            state = "fighting" if nxt["status"] == "in_progress" else "scheduled"
        elif place is not None and c.status == "finished":
            state = "placed"
        elif c.status == "finished":
            state = "done"
        else:
            state = "waiting"
        g["entries"].append(
            {
                "category_id": c.id,
                "category": c.name,
                "state": state,
                "place": place if c.status == "finished" else None,
                "next": nxt,
            }
        )
    competitors = sorted(groups.values(), key=lambda g: (g["name"].lower(), g["dojo"].lower()))
    return {
        "tournament": {"name": t.name, "slug": t.public_slug, "timezone": t.timezone},
        "competitors": competitors,
        "server_time": utcnow().isoformat() + "Z",
    }


# ---------------------------------------------------------------------------
# Llave y resultados de una categoría (solo lectura)
# ---------------------------------------------------------------------------


def category_kind(category_id: int) -> str:
    return f"category:{category_id}"


def category(db: Session, token: str, category_id: int) -> dict[str, Any]:
    """Llave de una categoría para el público: nombres según la regla del torneo,
    marcador y método de cada combate, podio y, en todos contra todos o kata
    por puntos, la tabla."""
    t = by_token(db, token)
    c = db.get(Category, category_id)
    if c is None or c.tournament_id != t.id or c.status in ("merged", "cancelled", "empty"):
        raise NotFound("Categoría no encontrada")
    style = t.public_names
    try:
        b = bracket_out(db, c.id)
    except NotFound:
        b = None
    ids: set[int] = set()
    if b is not None:
        ids = {int(k) for k in b.participants} | {
            x for m in b.matches for x in (m.aka_registration_id, m.ao_registration_id) if x
        }
        regs = registrations_by_id(db, ids)
    else:
        regs = {
            r.id: r
            for r in db.scalars(
                select(Registration)
                .where(Registration.category_id == c.id, Registration.status == "active")
                .options(*REG_LIGHT)
            ).all()
        }

    def who(rid: int | None) -> dict[str, str] | None:
        r = regs.get(rid) if rid else None
        return {"name": _reg_name(r, style), "dojo": r.dojo.name} if r is not None else None

    out: dict[str, Any] = {
        "tournament": {"name": t.name, "slug": t.public_slug},
        "category": {
            "id": c.id,
            "name": c.name,
            "modality": c.modality,
            "status": c.status,
            "is_team": c.is_team,
        },
        "format": b.format if b else None,
        "matches": [],
        "podium": [],
        "standings": None,
        "entrants": sorted(
            ({"name": _reg_name(r, style), "dojo": r.dojo.name} for r in regs.values()),
            key=lambda x: x["name"].lower(),
        ),
        "server_time": utcnow().isoformat() + "Z",
    }
    if b is None:
        return out
    for m in b.matches:
        if m.status == "void":
            continue
        winner = None
        if m.winner_registration_id is not None:
            winner = "aka" if m.winner_registration_id == m.aka_registration_id else "ao"
        out["matches"].append(
            {
                "code": m.code,
                "kind": m.kind,
                "round": m.round,
                "position": m.position,
                "status": m.status,
                "aka": who(m.aka_registration_id),
                "ao": who(m.ao_registration_id),
                "score": [m.aka_score or 0, m.ao_score or 0],
                "winner": winner,
                "method": m.method,
            }
        )
    out["podium"] = [{"place": p["place"], **(who(p["registration_id"]) or {})} for p in b.podium["places"]]
    if b.standings is not None:
        out["standings"] = [
            {
                **(who(st["registration_id"]) or {}),
                "rank": st.get("rank"),
                "wins": st.get("wins"),
                "played": st.get("played"),
                "points_for": st.get("points_for"),
                "total": st.get("total"),
                "kata_name": st.get("kata_name"),
            }
            for st in b.standings
        ]
    return out


# ---------------------------------------------------------------------------
# Directorio público de torneos
# ---------------------------------------------------------------------------

RECENT_DAYS = 120


def directory(db: Session, q: str = "", today: date | None = None) -> dict[str, Any]:
    """Torneos con el público activo y dirección fija (no los de prueba ni los
    cancelados): próximos, en curso y recientes. Una consulta."""
    today = today or utcnow().date()
    stmt = select(
        Tournament.name,
        Tournament.public_slug,
        Tournament.start_date,
        Tournament.end_date,
        Tournament.venue,
        Tournament.city,
        Tournament.status,
    ).where(
        Tournament.public_token.is_not(None),
        Tournament.public_slug.is_not(None),
        ~Tournament.is_test,
        Tournament.status != "cancelled",
        or_(Tournament.status == "in_progress", Tournament.start_date >= today - timedelta(days=RECENT_DAYS)),
    )
    for word in (q or "").split()[:5]:
        like = f"%{word[:40]}%"
        stmt = stmt.where(or_(Tournament.name.ilike(like), Tournament.city.ilike(like)))
    rows = db.execute(stmt.order_by(Tournament.start_date.desc()).limit(300)).all()
    out: dict[str, list[dict[str, Any]]] = {"live": [], "upcoming": [], "recent": []}
    for name, slug, start, end, venue, city, status in rows:
        last = end or start
        if status == "in_progress" or (start <= today <= last and status != "finished"):
            phase = "live"
        elif start > today:
            phase = "upcoming"
        else:
            phase = "recent"
        out[phase].append(
            {
                "name": name,
                "slug": slug,
                "start_date": start,
                "end_date": end,
                "venue": venue,
                "city": city,
                "status": status,
            }
        )
    out["upcoming"].reverse()  # el más cercano primero
    return {"tournaments": out, "today": today}
