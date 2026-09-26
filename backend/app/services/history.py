"""Historial deportivo (sección 10). Siempre muestra la foto guardada en la
inscripción (dojo, grado, categoría al momento), no los datos actuales.
Los torneos ``es_prueba`` se excluyen.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.db.models import (
    Category,
    CategoryResult,
    Dojo,
    GradeRecord,
    Match,
    Person,
    PersonRole,
    Registration,
    TeamMember,
    Tournament,
)
from app.services.people import get_dojo, get_person


def _match_rows(db: Session, reg_ids: list[int]) -> list[Match]:
    if not reg_ids:
        return []
    return list(
        db.scalars(
            select(Match).where(
                Match.is_current,
                Match.status == "finished",
                Match.parent_match_id.is_(None),
                or_(Match.aka_registration_id.in_(reg_ids), Match.ao_registration_id.in_(reg_ids)),
            )
        ).all()
    )


def _team_registrations(db: Session, person_id: int) -> tuple[dict[int, str], set[int], list[Match]]:
    """Equipos en los que participó la persona (sección 15).

    Devuelve el rol por equipo, las inscripciones de equipo que cuentan para
    su historial y sus combates individuales. Cuenta si peleó al menos un
    combate del equipo; si el equipo no registró combates individuales
    (kata, walkover), cuentan los titulares.
    """
    roles = {
        tid: role
        for tid, role in db.execute(
            select(TeamMember.team_id, TeamMember.role).where(TeamMember.person_id == person_id)
        ).all()
    }
    if not roles:
        return {}, set(), []
    regs = db.scalars(select(Registration).where(Registration.team_id.in_(roles))).all()
    reg_ids = [r.id for r in regs]
    bouts = db.scalars(
        select(Match).where(
            Match.is_current,
            Match.parent_match_id.is_not(None),
            or_(Match.aka_registration_id.in_(reg_ids), Match.ao_registration_id.in_(reg_ids)),
        )
    ).all()
    with_bouts = {rid for b in bouts for rid in (b.aka_registration_id, b.ao_registration_id)}
    mine = [
        b
        for b in bouts
        if b.status == "finished"
        and (
            (b.aka_person_id == person_id and b.aka_registration_id in reg_ids)
            or (b.ao_person_id == person_id and b.ao_registration_id in reg_ids)
        )
    ]
    fought = {b.aka_registration_id if b.aka_person_id == person_id else b.ao_registration_id for b in mine}
    counted = {r.id for r in regs if r.id in fought or (r.id not in with_bouts and roles.get(r.team_id) == "starter")}
    return roles, counted, mine


def person_history(db: Session, person_id: int) -> dict[str, Any]:
    p = get_person(db, person_id)
    _, team_regs, bouts = _team_registrations(db, p.id)
    rows = db.execute(
        select(Registration, Category, Tournament)
        .join(Category, Category.id == Registration.category_id)
        .join(Tournament, Tournament.id == Registration.tournament_id)
        .where(
            or_(Registration.person_id == p.id, Registration.id.in_(team_regs or {0})),
            ~Tournament.is_test,
            Registration.status.notin_(("pending", "rejected")),  # solicitudes sin aprobar
        )
        .order_by(Tournament.start_date.desc())
    ).all()
    reg_ids = [r.id for r, _, _ in rows]
    places = {
        cr.registration_id: cr.place
        for cr in db.scalars(select(CategoryResult).where(CategoryResult.registration_id.in_(reg_ids or [0]))).all()
    }
    matches = _match_rows(db, reg_ids)
    opp_ids = {(m.ao_registration_id if m.aka_registration_id in reg_ids else m.aka_registration_id) for m in matches}
    opp_ids |= {x for b in bouts for x in (b.aka_registration_id, b.ao_registration_id)}
    opps = {r.id: r for r in db.scalars(select(Registration).where(Registration.id.in_(opp_ids or {0}))).all()}
    opp_people = {b.ao_person_id if b.aka_person_id == p.id else b.aka_person_id for b in bouts} - {None}
    people_names = {
        x.id: f"{x.first_names} {x.last_names}"
        for x in db.scalars(select(Person).where(Person.id.in_(opp_people or {0}))).all()
    }
    dojos = {d.id: d.name for d in db.scalars(select(Dojo)).all()}
    entries = []
    for reg, cat, t in rows:
        fights = []
        if reg.team_id is not None and cat.modality == "kumite":
            # Por equipos: los combates individuales que peleó la persona.
            for b in bouts:
                mine_aka = b.aka_person_id == p.id and b.aka_registration_id == reg.id
                if not mine_aka and not (b.ao_person_id == p.id and b.ao_registration_id == reg.id):
                    continue
                opp = opps.get(b.ao_registration_id if mine_aka else b.aka_registration_id)
                fights.append(
                    {
                        "match_id": b.id,
                        "code": b.code,
                        "color": "aka" if mine_aka else "ao",
                        "won": b.winner_registration_id == reg.id,
                        "method": b.method,
                        "score": [b.aka_score, b.ao_score] if mine_aka else [b.ao_score, b.aka_score],
                        "opponent": people_names.get(b.ao_person_id if mine_aka else b.aka_person_id),
                        "opponent_dojo": opp.display_name if opp else None,
                    }
                )
        else:
            for m in (m for m in matches if reg.id in (m.aka_registration_id, m.ao_registration_id)):
                mine_aka = m.aka_registration_id == reg.id
                opp = opps.get(m.ao_registration_id if mine_aka else m.aka_registration_id)
                fights.append(
                    {
                        "match_id": m.id,
                        "code": m.code,
                        "color": "aka" if mine_aka else "ao",
                        "won": m.winner_registration_id == reg.id,
                        "method": m.method,
                        "score": [m.aka_score, m.ao_score] if mine_aka else [m.ao_score, m.aka_score],
                        "opponent": opp.display_name if opp else None,
                        "opponent_dojo": dojos.get(opp.dojo_id) if opp else None,
                    }
                )
        entries.append(
            {
                "tournament_id": t.id,
                "tournament_name": t.name,
                "date": t.start_date,
                "category_id": cat.id,
                "category_name": cat.name,
                "original_category_id": reg.original_category_id,
                "merged": reg.original_category_id != reg.category_id,
                "dojo_name": dojos.get(reg.dojo_id),
                "team_name": reg.team.name if reg.team else None,
                "grade": reg.grade,
                "weight_class": reg.weight_class,
                "status": reg.status,
                "place": places.get(reg.id),
                "matches": fights,
            }
        )
    grades = db.scalars(select(GradeRecord).where(GradeRecord.person_id == p.id).order_by(GradeRecord.awarded_on)).all()
    return {
        "person_id": p.id,
        "name": f"{p.first_names} {p.last_names}",
        # 01/01/1900 = grado registrado sin fecha (alta o importación): se informa como desconocida.
        "grades": [
            {"grade": g.grade, "awarded_on": g.awarded_on if g.awarded_on.year > 1900 else None} for g in grades
        ],
        "tournaments": entries,
        "medals": {
            "gold": sum(1 for e in entries if e["place"] == 1),
            "silver": sum(1 for e in entries if e["place"] == 2),
            "bronze": sum(1 for e in entries if e["place"] == 3),
        },
    }


def dojo_history(db: Session, dojo_id: int) -> dict[str, Any]:
    """Resultados de los competidores mientras representaban al dojo."""
    d = get_dojo(db, dojo_id)
    rows = db.execute(
        select(CategoryResult, Registration, Category, Tournament)
        .join(Registration, Registration.id == CategoryResult.registration_id)
        .join(Category, Category.id == CategoryResult.category_id)
        .join(Tournament, Tournament.id == Category.tournament_id)
        .where(Registration.dojo_id == d.id, ~Tournament.is_test, Category.status == "finished")
        .order_by(Tournament.start_date.desc(), CategoryResult.place)
    ).all()
    by_t: dict[int, dict[str, Any]] = {}
    for cr, reg, cat, t in rows:
        e = by_t.setdefault(
            t.id,
            {
                "tournament_id": t.id,
                "tournament_name": t.name,
                "date": t.start_date,
                "gold": 0,
                "silver": 0,
                "bronze": 0,
                "results": [],
            },
        )
        e[{1: "gold", 2: "silver", 3: "bronze"}[cr.place]] += 1
        e["results"].append(
            {
                "place": cr.place,
                "category_name": cat.name,
                "name": reg.display_name,
                "person_id": reg.person_id,
            }
        )
    senseis = db.scalars(
        select(Person)
        .join(PersonRole, PersonRole.person_id == Person.id)
        .where(
            PersonRole.role == "sensei",
            PersonRole.scope_type == "dojo",
            PersonRole.scope_id == d.id,
            Person.merged_into_id.is_(None),
        )
        .order_by(Person.last_names)
    ).all()
    return {
        "dojo_id": d.id,
        "name": d.name,
        "senseis": [{"person_id": p.id, "name": f"{p.first_names} {p.last_names}"} for p in senseis],
        "tournaments": list(by_t.values()),
    }
