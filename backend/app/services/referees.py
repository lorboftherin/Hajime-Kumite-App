"""Árbitros (sección 20): registro y asignación opcionales.

Nunca impiden operar el torneo. Un árbitro es un rol de Persona y no
necesita dojo. Puede asignarse a un tatami, a una categoría o a un combate;
en kata, la mesa puede registrar qué juez dio cada bandera o nota.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.api import schemas as s
from app.api.errors import InvalidState, NotFound
from app.db.models import Category, Match, Person, PersonRole, RefereeAssignment, Tatami, User
from app.services.audit import audit
from app.services.people import get_person
from app.services.tournaments import get_category, get_tournament

TARGETS = ("tatami", "category", "match")


def _name(p: Person) -> str:
    return f"{p.first_names} {p.last_names}"


def _is_referee(db: Session, person_id: int, tid: int) -> bool:
    return (
        db.scalar(
            select(PersonRole.id).where(
                PersonRole.person_id == person_id,
                PersonRole.role == "referee",
                or_(
                    PersonRole.scope_type == "global",
                    (PersonRole.scope_type == "tournament") & (PersonRole.scope_id == tid),
                ),
            )
        )
        is not None
    )


def tournament_referees(db: Session, tid: int) -> list[Person]:
    """Árbitros disponibles en el torneo: rol global o del torneo."""
    rows = db.scalars(
        select(Person)
        .join(PersonRole, PersonRole.person_id == Person.id)
        .where(
            PersonRole.role == "referee",
            Person.merged_into_id.is_(None),
            or_(
                PersonRole.scope_type == "global",
                (PersonRole.scope_type == "tournament") & (PersonRole.scope_id == tid),
            ),
        )
        .order_by(Person.last_names, Person.first_names)
    ).unique()
    return list(dict.fromkeys(rows))


def register(db: Session, user: User, tid: int, person_id: int) -> dict[str, Any]:
    """Registra a una persona como árbitro del torneo (si ya lo es, no hace nada)."""
    get_tournament(db, tid)
    p = get_person(db, person_id)
    if p.merged_into_id:
        raise InvalidState("La persona fue fusionada; usa la persona conservada", details={"use": p.merged_into_id})
    if not _is_referee(db, p.id, tid):
        db.add(PersonRole(person_id=p.id, role="referee", scope_type="tournament", scope_id=tid))
        audit(db, user, "person", p.id, "add_role", after={"role": "referee", "scope": "tournament", "scope_id": tid})
        db.commit()
    return overview(db, tid)


def _target_label(db: Session, tid: int, target_type: str, target_id: int) -> str:
    if target_type == "tatami":
        t = db.get(Tatami, target_id)
        if t is None or t.tournament_id != tid:
            raise NotFound("Tatami no encontrado en el torneo")
        return t.name
    if target_type == "category":
        c = get_category(db, target_id)
        if c.tournament_id != tid:
            raise NotFound("Categoría no encontrada en el torneo")
        return c.name
    m = db.get(Match, target_id)
    c = db.get(Category, m.category_id) if m else None
    if m is None or c is None or c.tournament_id != tid:
        raise NotFound("Combate no encontrado en el torneo")
    return f"{c.name} · {m.code}"


def assign(db: Session, user: User, tid: int, data: s.RefereeAssignIn) -> dict[str, Any]:
    get_tournament(db, tid)
    p = get_person(db, data.person_id)
    label = _target_label(db, tid, data.target_type, data.target_id)
    if not _is_referee(db, p.id, tid):
        # Asignar implica registrarlo como árbitro del torneo.
        db.add(PersonRole(person_id=p.id, role="referee", scope_type="tournament", scope_id=tid))
    dup = db.scalar(
        select(RefereeAssignment.id).where(
            RefereeAssignment.tournament_id == tid,
            RefereeAssignment.person_id == p.id,
            RefereeAssignment.target_type == data.target_type,
            RefereeAssignment.target_id == data.target_id,
        )
    )
    if dup:
        raise InvalidState(f"{_name(p)} ya está asignado a {label}", code="ALREADY_ASSIGNED")
    a = RefereeAssignment(
        tournament_id=tid,
        person_id=p.id,
        target_type=data.target_type,
        target_id=data.target_id,
        position=(data.position or "").strip(),
        created_by_id=user.id,
    )
    db.add(a)
    db.flush()
    audit(
        db,
        user,
        "referee_assignment",
        a.id,
        "create",
        after={"person": _name(p), "target": label, "position": a.position},
        tournament_id=tid,
    )
    db.commit()
    return overview(db, tid)


def unassign(db: Session, user: User, assignment_id: int) -> int:
    a = db.get(RefereeAssignment, assignment_id)
    if a is None:
        raise NotFound("Asignación no encontrada")
    tid = a.tournament_id
    audit(
        db,
        user,
        "referee_assignment",
        a.id,
        "delete",
        before={"person_id": a.person_id, "target_type": a.target_type, "target_id": a.target_id},
        tournament_id=tid,
    )
    db.delete(a)
    db.commit()
    return tid


def _assignment_out(db: Session, a: RefereeAssignment) -> dict[str, Any]:
    try:
        label = _target_label(db, a.tournament_id, a.target_type, a.target_id)
    except NotFound:
        label = "(ya no existe)"
    return {
        "id": a.id,
        "person_id": a.person_id,
        "name": _name(a.person),
        "target_type": a.target_type,
        "target_id": a.target_id,
        "target": label,
        "position": a.position,
    }


def overview(db: Session, tid: int) -> dict[str, Any]:
    refs = tournament_referees(db, tid)
    rows = db.scalars(
        select(RefereeAssignment)
        .where(RefereeAssignment.tournament_id == tid)
        .order_by(RefereeAssignment.target_type, RefereeAssignment.target_id, RefereeAssignment.id)
    ).all()
    counts: dict[int, int] = {}
    for a in rows:
        counts[a.person_id] = counts.get(a.person_id, 0) + 1
    return {
        "referees": [{"person_id": p.id, "name": _name(p), "assignments": counts.get(p.id, 0)} for p in refs],
        "assignments": [_assignment_out(db, a) for a in rows],
    }


def for_match(db: Session, mid: int) -> dict[str, Any]:
    """Jueces sugeridos para un combate: los asignados al combate, a su
    categoría o a su tatami (en ese orden) y el resto de árbitros del torneo."""
    m = db.get(Match, mid)
    if m is None:
        raise NotFound("Combate no encontrado")
    return _suggested(db, get_category(db, m.category_id), m.id)


def for_category(db: Session, cid: int) -> dict[str, Any]:
    """Jueces sugeridos para una ronda de kata por puntuación."""
    return _suggested(db, get_category(db, cid), None)


def _suggested(db: Session, c: Category, match_id: int | None) -> dict[str, Any]:
    targets = ([("match", match_id)] if match_id else []) + [("category", c.id)]
    if c.tatami_id:
        targets.append(("tatami", c.tatami_id))
    assigned = []
    seen: set[int] = set()
    for tt, tid_ in targets:
        for a in db.scalars(
            select(RefereeAssignment)
            .where(
                RefereeAssignment.tournament_id == c.tournament_id,
                RefereeAssignment.target_type == tt,
                RefereeAssignment.target_id == tid_,
            )
            .order_by(RefereeAssignment.id)
        ).all():
            if a.person_id not in seen:
                seen.add(a.person_id)
                assigned.append({"person_id": a.person_id, "name": _name(a.person), "position": a.position, "via": tt})
    others = [
        {"person_id": p.id, "name": _name(p)} for p in tournament_referees(db, c.tournament_id) if p.id not in seen
    ]
    return {"assigned": assigned, "others": others}


def for_tatami(db: Session, tatami_id: int) -> list[dict[str, Any]]:
    t = db.get(Tatami, tatami_id)
    if t is None:
        return []
    # Solo columnas: la cola del tatami (que la mesa pide seguido) incluye esto,
    # y cargar la persona completa arrastraría sus documentos y roles.
    rows = db.execute(
        select(Person.first_names, Person.last_names, RefereeAssignment.position)
        .join(Person, Person.id == RefereeAssignment.person_id)
        .where(
            RefereeAssignment.tournament_id == t.tournament_id,
            RefereeAssignment.target_type == "tatami",
            RefereeAssignment.target_id == tatami_id,
        )
        .order_by(RefereeAssignment.id)
    ).all()
    return [{"name": f"{first} {last}", "position": position} for first, last, position in rows]
