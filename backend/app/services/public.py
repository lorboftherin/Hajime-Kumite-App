"""Seguimiento en vivo público y overlay para transmisiones (inspirado en CricHeroes).

Es opcional por torneo: el organizador lo activa y obtiene un enlace secreto
(sin inicio de sesión). Por la Ley 29733 y porque muchos competidores son
menores, solo se publica lo necesario para seguir el torneo: nombre (abreviado
por defecto: «Diego R.»), dojo, marcadores, llaves y medallero. Nunca
documentos, fechas de nacimiento ni identificadores de personas.
"""

from __future__ import annotations

import secrets
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api import schemas as s
from app.api.errors import NotFound
from app.db.base import utcnow
from app.db.models import Category, CategoryResult, Match, Person, Registration, Tatami, Tournament, User
from app.domain.kumite import compute_scoreboard
from app.services import reports
from app.services import stats as stats_svc
from app.services.audit import audit, bump
from app.services.brackets import (
    REG_LIGHT,
    SCHEDULED,
    _domain_events,
    _events,
    queue_order,
    registrations_by_id,
    schedule_items,
)
from app.services.tournaments import effective_kumite_rules, get_tournament


def set_public(db: Session, user: User, tid: int, data: s.PublicLiveIn) -> Tournament:
    t = get_tournament(db, tid)
    before = {"public": t.public_token is not None, "names": t.public_names}
    if not data.enabled:
        t.public_token = None
    elif t.public_token is None or data.regenerate:
        t.public_token = secrets.token_urlsafe(24)
    t.public_names = data.names
    bump(t, user)
    audit(
        db,
        user,
        "tournament",
        t.id,
        "public_live",
        before,
        {"public": t.public_token is not None, "names": t.public_names, "regenerated": data.regenerate},
        tournament_id=t.id,
    )
    db.commit()
    db.refresh(t)
    return t


def by_token(db: Session, token: str) -> Tournament:
    t = db.scalar(select(Tournament).where(Tournament.public_token == token)) if token else None
    if t is None:
        raise NotFound("Este enlace de seguimiento no existe o fue desactivado")
    return t


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
    for tat in t.tatamis:
        sched = scheduled[tat.id]
        open_items = [it for it in sched if it["match"].status in ("ready", "in_progress", "needs_review")]
        current = next((it for it in open_items if it["match"].status == "in_progress"), None)
        upcoming = [it for it in open_items if it is not current][:3]

        def item(it):
            m = it["match"]
            out = _match_item(rows, m, it["number"], it["category_name"])
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
        public_results.append({"category": c.name, "places": places})

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
        },
        "tatamis": tatamis,
        "categories": [
            {"name": c.name, "modality": c.modality, "status": c.status}
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
    }
    if it is None:
        return {**base, "match": None}
    m = it["match"]
    bout = _bouts(matches).get(m.id)
    ids = {x for x in (m.aka_registration_id, m.ao_registration_id) if x}
    rows = _Rows(style, registrations_by_id(db, ids))
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
