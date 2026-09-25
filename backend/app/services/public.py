"""Seguimiento en vivo público y overlay para transmisiones (inspirado en CricHeroes).

Es opcional por torneo: el organizador lo activa y obtiene un enlace secreto
(sin inicio de sesión). Por la Ley 29733 y porque muchos competidores son
menores, solo se publica lo necesario para seguir el torneo: nombre (abreviado
por defecto: «Diego R.»), dojo, marcadores, llaves y medallero. Nunca
documentos, fechas de nacimiento ni identificadores de personas.
"""

from __future__ import annotations

import secrets
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api import schemas as s
from app.api.errors import NotFound
from app.db.base import utcnow
from app.db.models import Category, Match, Person, Registration, Tatami, Tournament, User
from app.services import reports
from app.services import stats as stats_svc
from app.services.audit import audit, bump
from app.services.brackets import get_match, scoreboard, tatami_schedule
from app.services.tournaments import get_tournament


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


def _person_name(p: Person | None, style: str) -> str:
    if p is None:
        return ""
    return f"{p.first_names} {p.last_names}" if style == "full" else short_name(p.first_names, p.last_names)


def _reg_name(r: Registration | None, style: str) -> str:
    if r is None:
        return ""
    if r.team is not None:
        return r.team.name
    return _person_name(r.person, style)


def _side(db: Session, m: Match, color: str, style: str) -> dict[str, Any] | None:
    rid = m.aka_registration_id if color == "aka" else m.ao_registration_id
    r = db.get(Registration, rid) if rid else None
    if r is None:
        return None
    pid = m.aka_person_id if color == "aka" else m.ao_person_id
    if pid:  # combate de un enfrentamiento por equipos: el integrante, con su equipo
        return {"name": _person_name(db.get(Person, pid), style), "dojo": r.display_name}
    return {"name": _reg_name(r, style), "dojo": r.dojo.name}


def _match_item(db: Session, m: Match, style: str, number: str | None = None, category: str = "") -> dict[str, Any]:
    winner = None
    if m.winner_registration_id is not None:
        winner = "aka" if m.winner_registration_id == m.aka_registration_id else "ao"
    return {
        "number": number,
        "code": m.code,
        "category": category,
        "status": m.status,
        "aka": _side(db, m, "aka", style),
        "ao": _side(db, m, "ao", style),
        "score": [m.aka_score or 0, m.ao_score or 0],
        "winner": winner,
        "method": m.method,
    }


def _live_bout(db: Session, parent: Match) -> Match | None:
    return db.scalar(
        select(Match)
        .where(Match.parent_match_id == parent.id, Match.status == "in_progress")
        .order_by(Match.bout_number.desc())
    )


def live(db: Session, token: str) -> dict[str, Any]:
    """Todo lo que ve el público: tatamis en vivo, resultados, medallero y premios."""
    t = by_token(db, token)
    style = t.public_names
    tatamis = []
    for tat in t.tatamis:
        sched = tatami_schedule(db, tat.id)["items"]
        open_items = [it for it in sched if it["match"].status in ("ready", "in_progress", "needs_review")]
        current = next((it for it in open_items if it["match"].status == "in_progress"), None)
        upcoming = [it for it in open_items if it is not current][:3]

        def item(it):
            m = get_match(db, it["match"].id)
            out = _match_item(db, m, style, it["number"], it["category_name"])
            bout = _live_bout(db, m) if m.parent_match_id is None else None
            if bout is not None:
                out["bout"] = _match_item(db, bout, style, None, it["category_name"])
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
    results = []
    for cr in reports.category_results(db, t.id):
        if cr["status"] != "finished" or not cr["places"]:
            continue
        regs = {
            r.id: r
            for r in db.scalars(
                select(Registration).where(Registration.id.in_([p["registration_id"] for p in cr["places"]]))
            ).all()
        }
        results.append(
            {
                "category": cr["category_name"],
                "places": [
                    {
                        "place": p["place"],
                        "name": _reg_name(regs.get(p["registration_id"]), style),
                        "dojo": p["dojo_name"],
                    }
                    for p in cr["places"]
                ],
            }
        )
    cats = db.scalars(
        select(Category)
        .where(Category.tournament_id == t.id, Category.status.not_in(("merged", "cancelled", "empty")))
        .order_by(Category.sort_order, Category.id)
    ).all()
    medals = reports.medal_table(db, t.id)
    awards = []
    for a in stats_svc.tournament_leaders(db, t.id)["awards"]:
        p = db.get(Person, a["person_id"]) if a.get("person_id") else None
        awards.append(
            {
                "title": a["title"],
                "detail": a["detail"],
                "name": _person_name(p, style) if p else a["name"],
                "dojo": a["dojo"],
                "value": a["value"],
            }
        )
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
        "categories": [{"name": c.name, "modality": c.modality, "status": c.status} for c in cats],
        "results": results,
        "medal_table": [
            {k: row[k] for k in ("rank", "dojo_name", "gold", "silver", "bronze", "total")} for row in medals["rows"]
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
    sched = tatami_schedule(db, tat.id)["items"]
    live_it = next((it for it in sched if it["match"].status == "in_progress"), None)
    it = live_it or next((it for it in sched if it["match"].status in ("ready", "needs_review")), None)
    base = {
        "tournament": t.name,
        "tatami": {"number": tat.number, "name": tat.name},
        "server_time": utcnow().isoformat() + "Z",
    }
    if it is None:
        return {**base, "match": None}
    m = get_match(db, it["match"].id)
    team = None
    if m.parent_match_id is None:
        bout = _live_bout(db, m)
        if bout is not None:
            team = {
                "aka": _reg_name(db.get(Registration, m.aka_registration_id), style),
                "ao": _reg_name(db.get(Registration, m.ao_registration_id), style),
                "wins": [m.aka_score or 0, m.ao_score or 0],
                "bout": bout.bout_number,
                "extra": bout.kind == "bout_extra",
            }
            m = bout
    sb = scoreboard(db, m)
    return {
        **base,
        "match": {
            "number": it["number"],
            "code": m.code,
            "category": it["category_name"],
            "status": m.status,
            "aka": _side(db, m, "aka", style),
            "ao": _side(db, m, "ao", style),
            "score": [sb.score["aka"], sb.score["ao"]],
            "sanction": [
                sb.sanction_labels[sb.sanction["aka"] - 1] if sb.sanction["aka"] else None,
                sb.sanction_labels[sb.sanction["ao"] - 1] if sb.sanction["ao"] else None,
            ],
            "senshu": sb.senshu,
            "elapsed": sb.elapsed_seconds,
            "running": sb.running,
            "duration": sb.duration_seconds,
            "winner": sb.winner if m.status == "finished" else None,
            "team": team,
        },
    }
