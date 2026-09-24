"""Equipos temporales y kumite por equipos (sección 15).

* Un equipo existe solo dentro de un torneo: nombre, dojo e integrantes
  (titulares y suplentes). Se inscribe en su categoría con una Inscripcion
  cuyo ``team_id`` apunta al equipo; llaves, podio y medallero no distinguen
  entre personas y equipos.
* En kumite, cada enfrentamiento entre equipos contiene combates
  individuales (filas ``Match`` con ``parent_match_id``). La mesa los opera
  como cualquier combate; al cerrar cada uno se recalcula el enfrentamiento
  y, si queda decidido, avanza la llave.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api import schemas as s
from app.api.errors import InvalidState, NotFound
from app.db.base import utcnow
from app.db.models import Category, Match, MatchEventRow, Person, Registration, Team, TeamMember, Tournament, User
from app.domain.categories import grade_to_ordinal
from app.domain.teams import DEFAULT_TEAM_BOUTS, BoutResult, TeamDecision, TeamTieRule, decide_team
from app.services import people
from app.services.audit import apply_warnings, audit, bump, check_version, snapshot
from app.services.tournaments import get_category, get_tournament, refresh_category_status

TEAM_METHODS = ("victories", "points", "extra_bout")


def team_settings(c: Category, t: Tournament) -> tuple[int, TeamTieRule]:
    """Combates por enfrentamiento y criterio de desempate (reglas de kumite
    del torneo, sobrescribibles por categoría)."""
    cfg = {**(t.kumite_rules or {}), **(c.kumite_rules or {})}
    return int(cfg.get("team_bouts") or DEFAULT_TEAM_BOUTS), TeamTieRule(cfg.get("team_tie_rule") or "points")


def _name(p: Person) -> str:
    return f"{p.first_names} {p.last_names}"


# ---------------------------------------------------------------------------
# Equipos e inscripción
# ---------------------------------------------------------------------------


def get_team(db: Session, team_id: int) -> Team:
    t = db.get(Team, team_id)
    if t is None:
        raise NotFound("Equipo no encontrado")
    return t


def team_registration(db: Session, team: Team) -> Registration:
    r = db.scalar(select(Registration).where(Registration.team_id == team.id).order_by(Registration.id.desc()))
    if r is None:
        raise NotFound("El equipo no tiene inscripción")
    return r


def _validate_members(
    db: Session, team_id: int | None, members: list[s.TeamMemberIn], c: Category, t: Tournament, dojo_id: int
) -> tuple[list[Person], list[dict[str, str]]]:
    from app.services.registrations import _warnings

    ids = [m.person_id for m in members]
    if len(set(ids)) != len(ids):
        raise InvalidState("Una persona aparece dos veces en el equipo", code="TEAM_MEMBER_REPEATED")
    persons = []
    ws: list[dict[str, str]] = []
    for pid in ids:
        p = people.get_person(db, pid)
        if p.merged_into_id:
            raise InvalidState(
                f"{_name(p)} fue fusionada; usa la persona conservada", details={"use": p.merged_into_id}
            )
        persons.append(p)
        g = people.current_grade(db, p.id, t.start_date)
        for w in _warnings(p, grade_to_ordinal(g.grade) if g else None, None, c, t):
            if w["code"] not in ("REGISTRATION_CLOSED", "CATEGORY_NOT_OPEN"):
                ws.append({"code": w["code"], "message": f"{_name(p)}: {w['message']}"})
        m = people.current_membership(db, p.id, t.start_date)
        if m is not None and m.dojo_id != dojo_id:
            ws.append({"code": "MEMBER_OTHER_DOJO", "message": f"{_name(p)} pertenece a otro dojo"})
        other = db.scalar(
            select(Team.name)
            .join(TeamMember, TeamMember.team_id == Team.id)
            .join(Registration, Registration.team_id == Team.id)
            .where(
                TeamMember.person_id == p.id,
                Registration.category_id == c.id,
                Registration.status == "active",
                Team.id != (team_id or 0),
            )
        )
        if other:
            ws.append({"code": "MEMBER_IN_OTHER_TEAM", "message": f"{_name(p)} ya integra el equipo {other}"})
    starters = sum(1 for m in members if m.role == "starter")
    if c.modality == "kumite":
        planned, _ = team_settings(c, t)
        if starters < planned:
            ws.append(
                {"code": "TEAM_SHORT", "message": f"{starters} titulares para {planned} combates por enfrentamiento"}
            )
    elif starters == 0:
        ws.append({"code": "TEAM_SHORT", "message": "El equipo no tiene titulares"})
    return persons, ws


def _set_members(db: Session, team: Team, members: list[s.TeamMemberIn]) -> None:
    current = {m.person_id: m for m in team.members}
    wanted = {m.person_id for m in members}
    for pid, row in current.items():
        if pid not in wanted:
            db.delete(row)
    db.flush()
    for i, m in enumerate(members):
        row = current.get(m.person_id)
        if row is None:
            db.add(TeamMember(team_id=team.id, person_id=m.person_id, role=m.role, order=i))
        else:
            row.role, row.order = m.role, i
    db.flush()
    db.refresh(team)


def _members_snapshot(team: Team) -> list[dict[str, Any]]:
    return [{"person_id": m.person_id, "role": m.role} for m in team.members]


def create_team(db: Session, user: User, tid: int, data: s.TeamCreate) -> Registration:
    from app.services.registrations import OPEN_FOR_REGISTRATION

    t = get_tournament(db, tid)
    if t.status not in OPEN_FOR_REGISTRATION:
        raise InvalidState(f"El torneo está en estado {t.status}")
    c = get_category(db, data.category_id)
    if c.tournament_id != tid:
        raise InvalidState("La categoría no pertenece al torneo")
    if not c.is_team:
        raise InvalidState("La categoría es individual: inscribe a cada persona", code="NOT_TEAM_CATEGORY")
    if c.status in ("merged", "cancelled"):
        raise InvalidState("La categoría está fusionada o cancelada; inscribe en la categoría destino")
    people.get_dojo(db, data.dojo_id)
    _, ws = _validate_members(db, None, data.members, c, t, data.dojo_id)
    ws += _team_warnings(db, c, t, data.name, None)
    team = Team(tournament_id=tid, dojo_id=data.dojo_id, name=data.name.strip(), updated_by_id=user.id)
    db.add(team)
    db.flush()
    r = Registration(
        tournament_id=tid,
        category_id=c.id,
        original_category_id=c.id,
        team_id=team.id,
        dojo_id=data.dojo_id,
        seed=data.seed,
        updated_by_id=user.id,
    )
    db.add(r)
    apply_warnings(db, user, ws, data.override.reason if data.override else None, "registration", lambda: r.id)
    _set_members(db, team, data.members)
    db.flush()
    refresh_category_status(db, c)
    audit(
        db,
        user,
        "registration",
        r.id,
        "create",
        after={**snapshot(r), "team": team.name, "members": _members_snapshot(team)},
        tournament_id=tid,
    )
    db.commit()
    db.refresh(r)
    return r


def _team_warnings(db: Session, c: Category, t: Tournament, name: str, team_id: int | None) -> list[dict[str, str]]:
    ws = []
    if t.status not in ("draft", "registration_open"):
        ws.append({"code": "REGISTRATION_CLOSED", "message": "Las inscripciones del torneo están cerradas"})
    if c.status not in ("open", "empty"):
        ws.append({"code": "CATEGORY_NOT_OPEN", "message": f"La categoría está en estado {c.status}"})
    same = db.scalar(
        select(Team.id)
        .join(Registration, Registration.team_id == Team.id)
        .where(
            Registration.category_id == c.id,
            Registration.status == "active",
            Team.name == name.strip(),
            Team.id != (team_id or 0),
        )
    )
    if same:
        ws.append({"code": "TEAM_NAME_DUPLICATE", "message": f"Ya hay un equipo «{name.strip()}» en la categoría"})
    return ws


def update_team(db: Session, user: User, team_id: int, data: s.TeamUpdate) -> Registration:
    """Cambia nombre, dojo o integrantes. Los integrantes pueden cambiar
    aunque la llave exista: la alineación de cada enfrentamiento es aparte."""
    team = get_team(db, team_id)
    check_version(team, data.version, "El equipo")
    r = team_registration(db, team)
    c = get_category(db, r.category_id)
    t = get_tournament(db, team.tournament_id)
    before = {"name": team.name, "dojo_id": team.dojo_id, "members": _members_snapshot(team)}
    name = data.name if data.name is not None else team.name
    dojo_id = data.dojo_id if data.dojo_id is not None else team.dojo_id
    ws: list[dict[str, str]] = []
    if data.members is not None:
        _, ws = _validate_members(db, team.id, data.members, c, t, dojo_id)
    if name.strip() != team.name:
        ws += [w for w in _team_warnings(db, c, t, name, team.id) if w["code"] == "TEAM_NAME_DUPLICATE"]
    if dojo_id != team.dojo_id and c.status in ("ready", "in_progress", "finished"):
        ws.append({"code": "BRACKET_EXISTS", "message": "La llave ya existe: la separación por dojo no se recalcula"})
    apply_warnings(db, user, ws, data.override.reason if data.override else None, "registration", lambda: r.id)
    if dojo_id != team.dojo_id:
        people.get_dojo(db, dojo_id)
        team.dojo_id = dojo_id
        r.dojo_id = dojo_id
        bump(r, user)
    team.name = name.strip()
    if data.members is not None:
        _set_members(db, team, data.members)
    bump(team, user)
    audit(
        db,
        user,
        "team",
        team.id,
        "update",
        before,
        {"name": team.name, "dojo_id": team.dojo_id, "members": _members_snapshot(team)},
        reason=data.override.reason if data.override else None,
        tournament_id=team.tournament_id,
    )
    db.commit()
    db.refresh(r)
    return r


def members_out(team: Team) -> list[dict[str, Any]]:
    return [
        {"person_id": m.person_id, "name": _name(m.person), "role": m.role}
        for m in sorted(team.members, key=lambda m: (m.role != "starter", m.order))
    ]


# ---------------------------------------------------------------------------
# Enfrentamientos de kumite por equipos
# ---------------------------------------------------------------------------


def bouts_of(db: Session, parent_id: int) -> list[Match]:
    return list(
        db.scalars(select(Match).where(Match.parent_match_id == parent_id).order_by(Match.bout_number, Match.id)).all()
    )


def _results(bouts: list[Match]) -> list[BoutResult]:
    out = []
    for b in bouts:
        finished = b.status == "finished"
        winner = None
        if finished and b.winner_registration_id is not None:
            winner = "aka" if b.winner_registration_id == b.aka_registration_id else "ao"
        out.append(BoutResult(finished, winner, b.aka_score or 0, b.ao_score or 0, b.kind == "bout_extra"))
    return out


def decision_for(db: Session, parent: Match, override: tuple[int, BoutResult] | None = None) -> TeamDecision:
    c = get_category(db, parent.category_id)
    t = get_tournament(db, c.tournament_id)
    planned, rule = team_settings(c, t)
    bouts = bouts_of(db, parent.id)
    results = _results(bouts)
    if override is not None:
        results = [override[1] if b.id == override[0] else r for b, r in zip(bouts, results, strict=True)]
    return decide_team(results, planned, rule)


def _parent_of(db: Session, bout: Match) -> Match:
    parent = db.get(Match, bout.parent_match_id)
    if parent is None:
        raise NotFound("Enfrentamiento no encontrado")
    return parent


def bout_change_warnings(
    db: Session, bout: Match, winner: str | None, score: dict[str, int]
) -> tuple[list[dict[str, str]], list[str]]:
    """Si cerrar este combate cambia el ganador de un enfrentamiento ya
    decidido, se advierte (y se informan los combates siguientes afectados)."""
    from app.services.brackets import _affected_by

    parent = _parent_of(db, bout)
    if parent.winner_registration_id is None:
        return [], []
    new = decision_for(
        db,
        parent,
        (bout.id, BoutResult(True, winner, score["aka"], score["ao"], bout.kind == "bout_extra")),
    )
    new_id = None
    if new.winner is not None:
        new_id = parent.aka_registration_id if new.winner == "aka" else parent.ao_registration_id
    if new_id == parent.winner_registration_id:
        return [], []
    c = get_category(db, parent.category_id)
    affected = _affected_by(db, c, parent)
    msg = f"Cambia el resultado del enfrentamiento {parent.code}" + (
        f"; afecta a: {', '.join(affected)}" if affected else ""
    )
    return [{"code": "TEAM_WINNER_CHANGE", "message": msg}], affected


def settle(db: Session, user: User, parent: Match, at: datetime, reason: str | None) -> TeamDecision:
    """Recalcula el enfrentamiento a partir de sus combates. Si queda decidido
    se cierra (y avanza la llave); si una corrección lo deja sin decidir, se
    reabre. No hace commit."""
    from app.services.brackets import record_finish, sync

    d = decision_for(db, parent)
    c = get_category(db, parent.category_id)
    parent.aka_score, parent.ao_score = d.wins["aka"], d.wins["ao"]
    if d.winner is not None:
        winner_id = parent.aka_registration_id if d.winner == "aka" else parent.ao_registration_id
        if (parent.winner_registration_id, parent.method) != (winner_id, d.method) or parent.status != "finished":
            record_finish(db, user, parent, c, d.winner, d.method, at, str(uuid.uuid4()), reason, None)
    elif parent.winner_registration_id is not None and parent.method in TEAM_METHODS:
        # Una corrección dejó el enfrentamiento sin decidir: se anula su cierre.
        last = db.scalar(
            select(MatchEventRow)
            .where(MatchEventRow.match_id == parent.id, MatchEventRow.type == "finish")
            .order_by(MatchEventRow.device_at.desc(), MatchEventRow.received_at.desc())
        )
        if last is not None:
            db.add(
                MatchEventRow(
                    id=str(uuid.uuid4()),
                    match_id=parent.id,
                    type="annul",
                    target_id=last.id,
                    reason=reason,
                    device_at=at,
                    user_id=user.id,
                )
            )
        before = {"winner": parent.winner_registration_id, "method": parent.method}
        parent.winner_registration_id, parent.method, parent.finished_at = None, None, None
        parent.status = "in_progress"
        bump(parent, user)
        audit(
            db,
            user,
            "match",
            parent.id,
            "undecide",
            before,
            {"winner": None, "method": None},
            reason=reason,
            tournament_id=c.tournament_id,
        )
        db.flush()
        sync(db, c)
    return d


def _new_bout(parent: Match, number: int, kind: str, aka_pid: int | None, ao_pid: int | None) -> Match:
    prefix = "X" if kind == "bout_extra" else "B"
    return Match(
        category_id=parent.category_id,
        bracket_version_id=parent.bracket_version_id,
        code=f"{parent.code}-{prefix}{number}",
        kind=kind,
        round=parent.round,
        position=number,
        aka_source=f"team:{parent.id}",
        ao_source=f"team:{parent.id}",
        aka_registration_id=parent.aka_registration_id,
        ao_registration_id=parent.ao_registration_id,
        status="ready",
        parent_match_id=parent.id,
        bout_number=number,
        aka_person_id=aka_pid,
        ao_person_id=ao_pid,
    )


def _team_of(db: Session, rid: int | None) -> Team | None:
    r = db.get(Registration, rid) if rid else None
    return r.team if r else None


def set_lineup(db: Session, user: User, mid: int, data: s.LineupIn) -> dict[str, Any]:
    """Alineación del enfrentamiento: qué integrante pelea cada combate.

    La primera vez crea los combates; después solo cambia los que aún no
    empezaron. Con ``extra=True`` agrega un combate extra de desempate.
    """
    from app.services.brackets import _require_two

    parent = db.get(Match, mid)
    if parent is None:
        raise NotFound("Combate no encontrado")
    if parent.parent_match_id is not None:
        raise InvalidState("La alineación se define en el enfrentamiento entre equipos")
    c = get_category(db, parent.category_id)
    t = get_tournament(db, c.tournament_id)
    if not (c.is_team and c.modality == "kumite"):
        raise InvalidState("Solo los enfrentamientos de kumite por equipos tienen alineación", code="NOT_TEAM_MATCH")
    _require_two(parent)
    check_version(parent, data.version, "El enfrentamiento")
    planned, _ = team_settings(c, t)
    bouts = bouts_of(db, parent.id)
    teams = {"aka": _team_of(db, parent.aka_registration_id), "ao": _team_of(db, parent.ao_registration_id)}
    ws: list[dict[str, str]] = []
    for color in ("aka", "ao"):
        team = teams[color]
        allowed = {m.person_id for m in team.members} if team else set()
        chosen = [getattr(b, f"{color}_person_id") for b in data.bouts]
        for pid in chosen:
            if pid is None:
                continue
            p = people.get_person(db, pid)
            if pid not in allowed:
                ws.append(
                    {"code": "NOT_IN_TEAM", "message": f"{_name(p)} no integra el equipo {team.name if team else ''}"}
                )
        known = [pid for pid in chosen if pid is not None]
        if not data.extra and len(set(known)) != len(known):
            ws.append({"code": "PERSON_REPEATED", "message": f"Un integrante de {color.upper()} pelea dos veces"})

    before = [{"code": b.code, "aka": b.aka_person_id, "ao": b.ao_person_id} for b in bouts]
    if data.extra:
        if len(data.bouts) != 1:
            raise InvalidState("El combate extra es uno solo")
        d = decision_for(db, parent)
        if not d.needs_extra_bout:
            ws.append({"code": "EXTRA_NOT_NEEDED", "message": "El enfrentamiento no está empatado"})
        apply_warnings(db, user, ws, data.override.reason if data.override else None, "match", lambda: parent.id)
        number = max((b.bout_number or 0 for b in bouts), default=0) + 1
        b = data.bouts[0]
        db.add(_new_bout(parent, number, "bout_extra", b.aka_person_id, b.ao_person_id))
    else:
        regular = [b for b in bouts if b.kind == "bout"]
        if not regular:
            if len(data.bouts) != planned:
                ws.append(
                    {
                        "code": "LINEUP_SIZE",
                        "message": f"{len(data.bouts)} combates; la categoría prevé {planned} por enfrentamiento",
                    }
                )
            apply_warnings(db, user, ws, data.override.reason if data.override else None, "match", lambda: parent.id)
            for i, b in enumerate(data.bouts):
                db.add(_new_bout(parent, i + 1, "bout", b.aka_person_id, b.ao_person_id))
        else:
            if len(data.bouts) != len(regular):
                raise InvalidState(f"El enfrentamiento tiene {len(regular)} combates", code="LINEUP_SIZE")
            started = {
                row.match_id
                for row in db.scalars(
                    select(MatchEventRow).where(MatchEventRow.match_id.in_([b.id for b in regular]))
                ).all()
            }
            for row, b in zip(regular, data.bouts, strict=True):
                if (row.aka_person_id, row.ao_person_id) == (b.aka_person_id, b.ao_person_id):
                    continue
                if row.id in started or row.status != "ready":
                    raise InvalidState(
                        f"El combate {row.code} ya empezó; no se cambia su alineación", code="BOUT_STARTED"
                    )
            apply_warnings(db, user, ws, data.override.reason if data.override else None, "match", lambda: parent.id)
            for row, b in zip(regular, data.bouts, strict=True):
                if (row.aka_person_id, row.ao_person_id) != (b.aka_person_id, b.ao_person_id):
                    row.aka_person_id, row.ao_person_id = b.aka_person_id, b.ao_person_id
                    bump(row, user)
    if parent.status == "ready":
        parent.status = "in_progress"
        parent.started_at = parent.started_at or utcnow()
        if c.status == "ready":
            c.status = "in_progress"
    bump(parent, user)
    db.flush()
    after = [{"code": b.code, "aka": b.aka_person_id, "ao": b.ao_person_id} for b in bouts_of(db, parent.id)]
    audit(
        db,
        user,
        "match",
        parent.id,
        "lineup_extra" if data.extra else "lineup",
        {"bouts": before},
        {"bouts": after},
        reason=data.override.reason if data.override else None,
        tournament_id=c.tournament_id,
    )
    db.commit()
    return team_match_out(db, parent)


def team_match_out(db: Session, parent: Match) -> dict[str, Any]:
    if parent.parent_match_id is not None:
        parent = _parent_of(db, parent)
    c = get_category(db, parent.category_id)
    t = get_tournament(db, c.tournament_id)
    planned, rule = team_settings(c, t)
    bouts = bouts_of(db, parent.id)
    pids = {pid for b in bouts for pid in (b.aka_person_id, b.ao_person_id) if pid}
    names = {p.id: _name(p) for p in db.scalars(select(Person).where(Person.id.in_(pids or {0}))).all()}

    def side(rid: int | None) -> dict[str, Any] | None:
        r = db.get(Registration, rid) if rid else None
        if r is None:
            return None
        return {
            "registration_id": r.id,
            "team_id": r.team_id,
            "name": r.display_name,
            "dojo_name": r.dojo.name,
            "members": members_out(r.team) if r.team else [],
        }

    d = decision_for(db, parent)
    return {
        "match": s.MatchOut.model_validate(parent).model_dump(mode="json"),
        "category_id": c.id,
        "category_name": c.name,
        "settings": {"bouts": planned, "tie_rule": rule.value},
        "aka": side(parent.aka_registration_id),
        "ao": side(parent.ao_registration_id),
        "bouts": [
            {
                "match": s.MatchOut.model_validate(b).model_dump(mode="json"),
                "is_extra": b.kind == "bout_extra",
                "aka_person_id": b.aka_person_id,
                "aka_name": names.get(b.aka_person_id),
                "ao_person_id": b.ao_person_id,
                "ao_name": names.get(b.ao_person_id),
            }
            for b in bouts
        ],
        "decision": {
            "winner": d.winner,
            "method": d.method,
            "wins": d.wins,
            "points": d.points,
            "draws": d.draws,
            "needs_extra_bout": d.needs_extra_bout,
            "pending_bouts": d.pending_bouts,
            "reason": d.reason,
        },
    }
