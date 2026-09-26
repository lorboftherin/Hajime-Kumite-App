"""Estadísticas, líderes y premios (inspirado en CricHeroes).

Se calculan al vuelo a partir de los eventos de la mesa y de los resultados
guardados; los torneos ``es_prueba`` no cuentan. Un combate por equipos
cuenta para el integrante que lo peleó (no para el equipo entero).
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import asdict, dataclass, field
from datetime import date
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.api.errors import NotFound
from app.db.models import (
    Category,
    CategoryResult,
    KataPerformance,
    Match,
    MatchEventRow,
    Person,
    Registration,
    TeamMember,
    Tournament,
)
from app.domain.stats import (
    BADGES,
    MVP_WEIGHTS,
    NON_TECHNICAL,
    CareerStats,
    FightLine,
    MatchFacts,
    career,
    earned_badges,
    match_facts,
    mvp_index,
)
from app.services.brackets import REG_LIGHT, _domain_events, get_match, participants, registrations_by_id
from app.services.people import get_person
from app.services.tournaments import effective_kumite_rules, get_tournament

PLACE_KEY = {1: "gold", 2: "silver", 3: "bronze"}


def _name(p: Person | None) -> str:
    return f"{p.first_names} {p.last_names}" if p else ""


def _facts(db: Session, matches: list[Match]) -> dict[int, MatchFacts]:
    """Hechos de varios combates con una sola consulta de eventos."""
    if not matches:
        return {}
    rows = db.scalars(
        select(MatchEventRow)
        .where(MatchEventRow.match_id.in_([m.id for m in matches]))
        .order_by(MatchEventRow.device_at, MatchEventRow.received_at)
    ).all()
    by_match: dict[int, list[MatchEventRow]] = defaultdict(list)
    for e in rows:
        by_match[e.match_id].append(e)
    rules_cache: dict[int, Any] = {}
    out = {}
    for m in matches:
        if m.category_id not in rules_cache:
            c = db.get(Category, m.category_id)
            rules_cache[m.category_id] = effective_kumite_rules(c, db.get(Tournament, c.tournament_id))
        out[m.id] = match_facts(_domain_events(by_match[m.id]), rules_cache[m.category_id])
    return out


def _result(m: Match, color: str) -> str:
    if m.winner_registration_id is None:
        return "draw"
    mine = m.aka_registration_id if color == "aka" else m.ao_registration_id
    return "win" if m.winner_registration_id == mine else "loss"


def _chunks(ids, size: int = 900) -> list[list[int]]:
    """SQL Server acepta hasta 2100 parámetros por consulta: los ``IN`` grandes
    (estadísticas de todos los torneos) se parten en tandas."""
    ids = sorted(ids)
    return [ids[i : i + size] for i in range(0, len(ids), size)]


@dataclass
class Preload:
    """Filas del torneo que quien llama ya cargó (el vivo público): con ellas
    los líderes y premios no repiten consultas."""

    matches: list[Match]  # combates vigentes del torneo, incluidos los individuales de equipos
    categories: dict[int, Category]
    registrations: dict[int, Registration]  # todas las del torneo
    results: list[CategoryResult]
    person_names: dict[int, str] = field(default_factory=dict)  # integrantes de equipos

    def kumite_rows(self) -> list[tuple[Match, Category]]:
        rows = []
        for m in self.matches:
            c = self.categories.get(m.category_id)
            if c is None or m.status != "finished" or c.modality != "kumite":
                continue
            if m.parent_match_id is not None or not c.is_team:
                rows.append((m, c))
        # Igual que ORDER BY finished_at, id (NULL primero).
        return sorted(rows, key=lambda mc: (mc[0].finished_at is not None, mc[0].finished_at or date.min, mc[0].id))

    def medal_rows(self) -> list[tuple[CategoryResult, Registration]]:
        return [
            (cr, self.registrations[cr.registration_id])
            for cr in sorted(self.results, key=lambda r: r.id)
            if cr.place <= 3
            and self.categories[cr.category_id].status == "finished"
            and cr.registration_id in self.registrations
        ]


def _kumite_matches(db: Session, tournament_ids: list[int] | None) -> list[tuple[Match, Category]]:
    """Combates de kumite cerrados en los que pelean personas: individuales y
    combates dentro de un enfrentamiento por equipos."""
    stmt = (
        select(Match, Category)
        .join(Category, Category.id == Match.category_id)
        .join(Tournament, Tournament.id == Category.tournament_id)
        .where(
            Match.is_current,
            Match.status == "finished",
            Category.modality == "kumite",
            ~Tournament.is_test,
            or_(Match.parent_match_id.is_not(None), ~Category.is_team),
        )
        .order_by(Match.finished_at, Match.id)
    )
    if tournament_ids is not None:
        stmt = stmt.where(Category.tournament_id.in_(tournament_ids or [0]))
    return list(db.execute(stmt).tuples().all())


def _regs(db: Session, ids: set[int]) -> dict[int, Registration]:
    out: dict[int, Registration] = {}
    for chunk in _chunks(ids):
        out |= registrations_by_id(db, set(chunk))
    return out


def _person_of(m: Match, color: str, regs: dict[int, Registration]) -> int | None:
    if m.parent_match_id is not None:
        return m.aka_person_id if color == "aka" else m.ao_person_id
    r = regs.get(m.aka_registration_id if color == "aka" else m.ao_registration_id)
    return r.person_id if r else None


def _lines_by_person(
    db: Session, tournament_ids: list[int] | None, pre: Preload | None = None
) -> tuple[dict[int, list[FightLine]], dict]:
    if pre is None:
        rows = _kumite_matches(db, tournament_ids)
        regs = _regs(db, {x for m, _ in rows for x in (m.aka_registration_id, m.ao_registration_id) if x})
    else:
        rows, regs = pre.kumite_rows(), pre.registrations
    facts = _facts(db, [m for m, _ in rows])
    lines: dict[int, list[FightLine]] = defaultdict(list)
    dojo_of: dict[int, str] = {}
    for m, _c in rows:
        for color in ("aka", "ao"):
            pid = _person_of(m, color, regs)
            if pid is None:
                continue
            lines[pid].append(FightLine(color, _result(m, color), m.method, facts[m.id]))
            r = regs.get(m.aka_registration_id if color == "aka" else m.ao_registration_id)
            if r is not None:
                dojo_of[pid] = r.display_name if r.team_id else r.dojo.name
    return lines, dojo_of


def _matches_of(db: Session, reg_ids: set[int]) -> list[Match]:
    """Combates vigentes (incluidos los individuales de equipos) de varias inscripciones."""
    out: list[Match] = []
    for chunk in _chunks(reg_ids, 900):
        out += db.scalars(
            select(Match).where(
                Match.is_current, or_(Match.aka_registration_id.in_(chunk), Match.ao_registration_id.in_(chunk))
            )
        ).all()
    return out


def _team_credits(db: Session, team_regs: list[Registration], by_reg: dict[int, list[Match]]) -> dict[int, set[int]]:
    """Integrantes a los que cuenta el resultado de cada inscripción de equipo:
    quien peleó al menos un combate; sin combates registrados, los titulares."""
    out: dict[int, set[int]] = {}
    no_bouts: dict[int, list[int]] = defaultdict(list)  # equipo → inscripciones sin combates
    for r in team_regs:
        bouts = [b for b in by_reg.get(r.id, []) if b.parent_match_id is not None]
        if bouts:
            out[r.id] = {b.aka_person_id if b.aka_registration_id == r.id else b.ao_person_id for b in bouts} - {None}
        else:
            no_bouts[r.team_id].append(r.id)
    if no_bouts:
        starters: dict[int, set[int]] = defaultdict(set)
        for team_id, person_id in db.execute(
            select(TeamMember.team_id, TeamMember.person_id).where(
                TeamMember.team_id.in_(list(no_bouts)), TeamMember.role == "starter"
            )
        ).all():
            starters[team_id].add(person_id)
        for team_id, rids in no_bouts.items():
            for rid in rids:
                out[rid] = set(starters[team_id])
    return out


def _medals(
    db: Session, tournament_ids: list[int] | None, dojo_of: dict[int, str] | None = None, pre: Preload | None = None
) -> tuple[dict[int, dict[str, int]], dict[int, int]]:
    """Medallas por persona (individuales y de equipo) y oros invictos.
    Completa ``dojo_of`` para quien no tiene combates de kumite (p. ej. kata).
    Tres consultas como máximo, sin importar cuántas medallas haya."""
    if pre is None:
        stmt = (
            select(CategoryResult, Registration)
            .join(Registration, Registration.id == CategoryResult.registration_id)
            .join(Category, Category.id == CategoryResult.category_id)
            .join(Tournament, Tournament.id == Category.tournament_id)
            .where(~Tournament.is_test, Category.status == "finished", CategoryResult.place <= 3)
            .order_by(CategoryResult.id)
            .options(*REG_LIGHT)
        )
        if tournament_ids is not None:
            stmt = stmt.where(Category.tournament_id.in_(tournament_ids or [0]))
        rows = list(db.execute(stmt).tuples().all())
        # Combates de los equipos con medalla (créditos) y de los oros (invictos), de una vez.
        pool = _matches_of(db, {r.id for cr, r in rows if r.team_id or cr.place == 1})
    else:
        rows, pool = pre.medal_rows(), pre.matches
    by_reg: dict[int, list[Match]] = defaultdict(list)
    for m in pool:
        if not m.is_current:
            continue
        for rid in {m.aka_registration_id, m.ao_registration_id} - {None}:
            by_reg[rid].append(m)
    credits = _team_credits(db, [r for _, r in rows if r.team_id], by_reg)
    medals: dict[int, dict[str, int]] = defaultdict(lambda: {"gold": 0, "silver": 0, "bronze": 0})
    unbeaten: dict[int, int] = defaultdict(int)
    for cr, r in rows:
        people = {r.person_id} if r.person_id else credits.get(r.id, set())
        key = PLACE_KEY[cr.place]
        clean = False
        if key == "gold":
            played = [m for m in by_reg.get(r.id, []) if m.parent_match_id is None and m.status == "finished"]
            clean = bool(played) and all(m.winner_registration_id == r.id for m in played)
        for pid in people:
            if dojo_of is not None and pid not in dojo_of:
                dojo_of[pid] = r.display_name if r.team_id else r.dojo.name
            medals[pid][key] += 1
            if clean:
                unbeaten[pid] += 1
    return medals, unbeaten


def _stats_out(st: CareerStats) -> dict[str, Any]:
    d = asdict(st)
    d.update(win_pct=st.win_pct, senshu_pct=st.senshu_pct, avg_points=st.avg_points)
    return d


# ---------------------------------------------------------------------------
# Perfil del competidor
# ---------------------------------------------------------------------------


def person_stats(db: Session, person_id: int) -> dict[str, Any]:
    p = get_person(db, person_id)
    lines, _ = _lines_by_person(db, None)
    mine = lines.get(p.id, [])
    st = career(mine)
    medals_all, unbeaten = _medals(db, None)
    medals = medals_all.get(p.id, {"gold": 0, "silver": 0, "bronze": 0})
    team_regs = db.scalars(
        select(Registration.id)
        .join(TeamMember, TeamMember.team_id == Registration.team_id)
        .where(TeamMember.person_id == p.id)
    ).all()
    tournaments = db.scalars(
        select(Registration.tournament_id)
        .join(Tournament, Tournament.id == Registration.tournament_id)
        .where(
            or_(Registration.person_id == p.id, Registration.id.in_(team_regs or [0])),
            ~Tournament.is_test,
        )
        .distinct()
    ).all()
    best_kata = db.scalar(
        select(KataPerformance.total)
        .join(Registration, Registration.id == KataPerformance.registration_id)
        .join(Tournament, Tournament.id == Registration.tournament_id)
        .where(Registration.person_id == p.id, ~Tournament.is_test, KataPerformance.total.is_not(None))
        .order_by(KataPerformance.total.desc())
    )
    badges = earned_badges(st, medals, len(tournaments), unbeaten.get(p.id, 0))
    return {
        "person_id": p.id,
        "name": _name(p),
        "kumite": _stats_out(st),
        "medals": medals,
        "tournaments": len(tournaments),
        "best_kata_score": float(best_kata) if best_kata is not None else None,
        "mvp_index": mvp_index(st, medals),
        "badges": [asdict(b) | {"earned": b in badges} for b in BADGES],
        "form": [ln.result for ln in mine[-5:]],
    }


# ---------------------------------------------------------------------------
# Líderes y premios
# ---------------------------------------------------------------------------


def _names(db: Session, pids: set[int], pre: Preload | None = None) -> dict[int, str]:
    """Nombres completos; solo columnas (la persona completa arrastraría sus documentos y roles)."""
    names: dict[int, str] = {}
    if pre is not None:
        names = {r.person_id: _name(r.person) for r in pre.registrations.values() if r.person_id} | pre.person_names
    for chunk in _chunks(pids - set(names)):
        for pid, first, last in db.execute(
            select(Person.id, Person.first_names, Person.last_names).where(Person.id.in_(chunk))
        ).all():
            names[pid] = f"{first} {last}"
    return names


def _leaders(
    db: Session, tournament_ids: list[int] | None, limit: int = 10, pre: Preload | None = None
) -> dict[str, Any]:
    lines, dojo_of = _lines_by_person(db, tournament_ids, pre)
    medals, _ = _medals(db, tournament_ids, dojo_of, pre)
    pids = set(lines) | set(medals)
    names = _names(db, pids, pre)
    rows = []
    for pid in pids:
        st = career(lines.get(pid, []))
        md = medals.get(pid, {"gold": 0, "silver": 0, "bronze": 0})
        rows.append(
            {
                "person_id": pid,
                "name": names.get(pid, ""),
                "dojo": dojo_of.get(pid),
                "matches": st.matches,
                "wins": st.wins,
                "points": st.points_for,
                "ippon": st.techniques["ippon"],
                "waza_ari": st.techniques["waza_ari"],
                "yuko": st.techniques["yuko"],
                "senshu": st.senshu,
                "fastest_win": round(st.fastest_win, 1) if st.fastest_win else None,
                "medals": md,
                "mvp_index": mvp_index(st, md),
            }
        )

    def top(key, reverse=True, cond=lambda r: True):
        eligible = [r for r in rows if cond(r)]
        return sorted(eligible, key=lambda r: (r[key] * (1 if reverse else -1), r["wins"]), reverse=True)[:limit]

    return {
        "mvp": top("mvp_index", cond=lambda r: r["mvp_index"] > 0),
        "wins": top("wins", cond=lambda r: r["wins"] > 0),
        "ippon": top("ippon", cond=lambda r: r["ippon"] > 0),
        "points": top("points", cond=lambda r: r["points"] > 0),
        "senshu": top("senshu", cond=lambda r: r["senshu"] > 0),
        "fastest_win": top("fastest_win", reverse=False, cond=lambda r: r["fastest_win"] is not None),
        "mvp_weights": MVP_WEIGHTS,
    }


def tournament_leaders(db: Session, tid: int, pre: Preload | None = None) -> dict[str, Any]:
    """Tabla de líderes y premios automáticos del torneo («héroes» del evento).

    ``pre``: filas del torneo ya cargadas (el vivo público); sin ellas se
    cargan aquí, igual con un número fijo de consultas."""
    t = get_tournament(db, tid)
    if t.is_test and pre is not None:  # los torneos de prueba no cuentan: nada que calcular
        pre = Preload([], pre.categories, {}, [])
    board = _leaders(db, [tid] if not t.is_test else [], pre=pre)
    kata = db.execute(
        select(KataPerformance, Registration, Category)
        .join(Registration, Registration.id == KataPerformance.registration_id)
        .join(Category, Category.id == KataPerformance.category_id)
        .where(Category.tournament_id == tid, KataPerformance.total.is_not(None))
        .order_by(KataPerformance.total.desc(), KataPerformance.id)
        .options(*REG_LIGHT)
        .limit(1)
    ).first()
    awards = []
    if board["mvp"]:
        r = board["mvp"][0]
        awards.append(_award("mvp", "Competidor del torneo", "Mayor índice Hajime", r, f"{r['mvp_index']:g} pts"))
    if board["ippon"]:
        r = board["ippon"][0]
        awards.append(_award("ippon", "Rey del ippon", "Más ippons marcados", r, f"{r['ippon']} ippon"))
    if board["fastest_win"]:
        r = board["fastest_win"][0]
        awards.append(
            _award("fastest", "Victoria más rápida", "Por técnica, en tiempo de reloj", r, _mmss(r["fastest_win"]))
        )
    if board["senshu"]:
        r = board["senshu"][0]
        awards.append(_award("senshu", "Primera ventaja", "Más senshus", r, f"{r['senshu']} senshu"))
    if kata:
        perf, reg, cat = kata
        awards.append(
            {
                "code": "kata",
                "title": "Mejor kata",
                "detail": f"Nota más alta · {cat.name}",
                "person_id": reg.person_id,
                "name": reg.display_name,
                "dojo": reg.dojo.name,
                "value": f"{float(perf.total):.1f}",
            }
        )
    return {"tournament_id": tid, "is_test": t.is_test, "awards": awards, "leaders": board}


def global_leaders(db: Session, year: int | None = None) -> dict[str, Any]:
    stmt = select(Tournament.id).where(~Tournament.is_test)
    if year:
        stmt = stmt.where(Tournament.start_date >= date(year, 1, 1), Tournament.start_date <= date(year, 12, 31))
    ids = list(db.scalars(stmt).all())
    return {"year": year, "tournaments": len(ids), "leaders": _leaders(db, ids)}


def _award(code: str, title: str, detail: str, r: dict[str, Any], value: str) -> dict[str, Any]:
    return {
        "code": code,
        "title": title,
        "detail": detail,
        "person_id": r["person_id"],
        "name": r["name"],
        "dojo": r["dojo"],
        "value": value,
    }


def _mmss(seconds: float | None) -> str:
    if seconds is None:
        return ""
    s = int(round(seconds))
    return f"{s // 60}:{s % 60:02d}"


# ---------------------------------------------------------------------------
# Resumen de un combate
# ---------------------------------------------------------------------------


def match_summary(db: Session, mid: int) -> dict[str, Any]:
    """Hoja del combate: marcador, técnicas por lado y la línea de tiempo."""
    m = get_match(db, mid)
    c = db.get(Category, m.category_id)
    if c is None:
        raise NotFound("Categoría no encontrada")
    t = db.get(Tournament, c.tournament_id)
    f = _facts(db, [m])[m.id]
    parts = participants(db, {x for x in (m.aka_registration_id, m.ao_registration_id) if x})
    side = {}
    for color in ("aka", "ao"):
        rid = m.aka_registration_id if color == "aka" else m.ao_registration_id
        pid = m.aka_person_id if color == "aka" else m.ao_person_id
        p = parts.get(rid) if rid else None
        person = db.get(Person, pid) if pid else None
        side[color] = {
            "registration_id": rid,
            "name": _name(person) if person else (p.name if p else None),
            "dojo": p.name if person and p else (p.dojo_name if p else None),
            "score": f.score[color],
            "techniques": f.points[color],
            "sanction": f.sanction[color],
        }
    winner = None
    if m.winner_registration_id is not None:
        winner = "aka" if m.winner_registration_id == m.aka_registration_id else "ao"
    return {
        "match": {
            "id": m.id,
            "code": m.code,
            "status": m.status,
            "method": m.method,
            "winner": winner,
            "parent_match_id": m.parent_match_id,
            "technical": m.method not in NON_TECHNICAL if m.method else None,
        },
        "category": {"id": c.id, "name": c.name, "modality": c.modality},
        "tournament": {"id": t.id, "name": t.name, "date": t.start_date} if t else None,
        "aka": side["aka"],
        "ao": side["ao"],
        "senshu": f.senshu,
        "elapsed": round(f.elapsed, 1),
        "duration": effective_kumite_rules(c, t).duration_seconds if t else None,
        "timeline": [asdict(x) | {"elapsed": round(x.elapsed, 1)} for x in f.timeline],
    }
