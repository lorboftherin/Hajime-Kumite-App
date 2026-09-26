"""Cambios con la llave ya generada: inscripción tardía, retiro de la llave,
descalificación del torneo y cambio de categoría el día del torneo.

Principios (sección 17):

* La llave no se regenera si hay combates iniciados; los cambios son
  puntuales y cada uno guarda una versión nueva de la llave.
* Eliminación directa: quien entra ocupa un bye de primera ronda que aún no
  se disputó (el que mejor respeta la separación por dojo); quien sale deja
  su lugar como bye si su primer combate no empezó, o pierde por walkover el
  combate pendiente (si su rival aún no se conoce, el walkover se registra
  solo cuando se conozca).
* Round robin: al entrar se agregan sus combates contra todos; al salir se
  anulan sus combates pendientes y deja de clasificar.
* Rondas de kata: entra al final del orden de la primera ronda; sale si aún
  no ejecutó.
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api import schemas as s
from app.api.errors import InvalidState, NotFound
from app.db.base import utcnow
from app.db.models import (
    Bracket,
    BracketVersion,
    Category,
    KataPerformance,
    Match,
    MatchEventRow,
    Registration,
    User,
)
from app.domain import brackets as bd
from app.services.audit import apply_warnings, audit, bump, check_version
from app.services.brackets import (
    _bracket,
    _spec,
    auto_walkovers,
    bracket_out,
    current_matches,
    record_finish,
    sync,
)
from app.services.tournaments import effective_competition, get_category, get_tournament, refresh_category_status

LIVE = ("in_progress", "finished")


def _has_events(db: Session, mid: int) -> bool:
    return bool(db.scalar(select(func.count()).select_from(MatchEventRow).where(MatchEventRow.match_id == mid)))


def _started(db: Session, m: Match) -> bool:
    return m.status in LIVE or _has_events(db, m.id)


def _current(db: Session, c: Category) -> tuple[Bracket, BracketVersion]:
    b = _bracket(db, c.id)
    if b is None or b.current_version_id is None:
        raise NotFound("La categoría no tiene llave")
    v = db.get(BracketVersion, b.current_version_id)
    assert v is not None
    return b, v


def _new_version(
    db: Session,
    user: User,
    b: Bracket,
    cur: BracketVersion,
    slots: list[int | None],
    reason: str,
    drop: set[int] = frozenset(),  # type: ignore[assignment]
) -> BracketVersion:
    """Guarda una versión nueva de la llave y le pasa los combates vigentes
    (menos los de ``drop``, que quedan anulados en la versión anterior)."""
    number = (db.scalar(select(func.max(BracketVersion.number)).where(BracketVersion.bracket_id == b.id)) or 0) + 1
    v = BracketVersion(
        bracket_id=b.id,
        number=number,
        format=cur.format,
        third_place_rule=cur.third_place_rule,
        seed=cur.seed,
        size=len(slots) if cur.format != "single_elimination" else cur.size,
        slots=slots,
        same_dojo_first_round=cur.same_dojo_first_round,
        reason=reason,
        created_by_id=user.id,
    )
    db.add(v)
    db.flush()
    for m in current_matches(db, b.category_id, bouts=True):
        if m.id in drop or m.parent_match_id in drop:
            m.is_current = False
        else:
            m.bracket_version_id = v.id
    b.current_version_id = v.id
    bump(b, user)
    return v


def _recount_same_dojo(db: Session, v: BracketVersion) -> None:
    if v.format != "single_elimination":
        return
    ids = [x for x in v.slots if x]
    regs = db.scalars(select(Registration).where(Registration.id.in_(ids or [0]))).all()
    dojo_of = {str(r.id): str(r.dojo_id) for r in regs}
    v.same_dojo_first_round = bd.count_same_dojo_first_round(
        tuple(str(x) if x is not None else None for x in v.slots), dojo_of
    )


# ---------------------------------------------------------------------------
# Inscripción tardía
# ---------------------------------------------------------------------------


def free_byes(db: Session, c: Category, v: BracketVersion) -> list[int]:
    """Posiciones de bye de primera ronda que todavía se pueden ocupar: su
    combate no empezó y nada de lo que depende de él empezó."""
    rows = current_matches(db, c.id)
    specs = [_spec(m) for m in rows]
    by_code = {m.code: m for m in rows}
    out = []
    for i in range(0, v.size, 2):
        pair = (v.slots[i], v.slots[i + 1]) if i + 1 < v.size else (v.slots[i], None)
        if pair[0] is not None and pair[1] is not None:
            continue
        r1 = by_code.get(bd.match_code(1, i // 2))
        if r1 is None or _started(db, r1):
            continue
        downstream = [by_code[x] for x in bd.dependents(specs, r1.code) if x in by_code]
        if any(m.status in LIVE and m.status != "bye" for m in downstream):
            continue
        out.extend(p for p in (i, i + 1) if p < v.size and v.slots[p] is None)
    return out


def _choose_bye(db: Session, c: Category, v: BracketVersion, r: Registration, free: list[int]) -> int:
    """El bye que deja al nuevo más lejos de su dojo (y de su ciudad si la
    separación por ciudad está activa). Primero los byes frente a alguien (el
    nuevo compite en primera ronda); luego los combates vacíos."""
    t = get_tournament(db, c.tournament_id)
    by_city = "city" in (effective_competition(c, t).get("separation") or [])
    ids = [x for x in v.slots if x]
    regs = {x.id: x for x in db.scalars(select(Registration).where(Registration.id.in_(ids or [0]))).all()}
    dojo_of = {str(k): str(x.dojo_id) for k, x in regs.items()}
    city_of = {str(k): (x.dojo.city if x.dojo else None) for k, x in regs.items()} if by_city else {}
    slots = [str(x) if x is not None else None for x in v.slots]
    facing = [p for p in free if v.slots[p ^ 1] is not None]
    pool = facing or free
    return bd.best_bye_position(
        slots,
        pool,
        str(r.dojo_id),
        dojo_of,
        (r.dojo.city if r.dojo else None) if by_city else None,
        city_of,
    )


def add_to_bracket(db: Session, user: User, c: Category, r: Registration, reason: str) -> dict[str, Any]:
    """Agrega ``r`` a la llave vigente de ``c`` (sin commit)."""
    b, v = _current(db, c)
    if c.status == "finished":
        raise InvalidState("La categoría ya terminó", code="CATEGORY_FINISHED")
    if r.id in [x for x in v.slots if x] and v.format != "groups_knockout":
        raise InvalidState("Ya está en la llave", code="ALREADY_IN_BRACKET")
    label = reason or f"Inscripción tardía de {r.display_name}"
    if v.format == "single_elimination":
        free = free_byes(db, c, v)
        if not free:
            if any(_started(db, m) for m in current_matches(db, c.id)):
                raise InvalidState(
                    "No queda ningún bye libre de primera ronda y la llave ya empezó: no se puede agregar a "
                    "nadie sin rehacer combates disputados",
                    code="NO_FREE_BYE",
                )
            raise InvalidState(
                "La llave no tiene byes libres: regenérala (aún no empezó) para incluir al nuevo inscrito",
                code="NO_FREE_BYE",
            )
        pos = _choose_bye(db, c, v, r, free)
        slots = list(v.slots)
        slots[pos] = r.id
        nv = _new_version(db, user, b, v, slots, label)
        _recount_same_dojo(db, nv)
        rows = current_matches(db, c.id)
        r1 = next(m for m in rows if m.code == bd.match_code(1, pos // 2))
        specs = [_spec(m) for m in rows]
        # El bye (y los byes que dependían de él) vuelven a estar por disputarse.
        for m in [r1, *[x for x in rows if x.code in bd.dependents(specs, r1.code)]]:
            if m.status == "bye" or (m is r1 and m.winner_registration_id is not None):
                m.winner_registration_id, m.method, m.status = None, None, "pending"
        result = {"mode": "bye", "position": pos}
    elif v.format == "round_robin":
        slots = [*v.slots, r.id]
        nv = _new_version(db, user, b, v, slots, label)
        rows = current_matches(db, c.id)
        last_round = max((m.round for m in rows), default=0)
        idx = len(slots) - 1
        others = [i for i, x in enumerate(v.slots) if x is not None]
        for k, j in enumerate(others):
            rnd = last_round + k + 1
            db.add(
                Match(
                    category_id=c.id,
                    bracket_version_id=nv.id,
                    code=f"RR{rnd}-1",
                    kind="main",
                    round=rnd,
                    position=0,
                    aka_source=f"slot:{j}",
                    ao_source=f"slot:{idx}",
                )
            )
        result = {"mode": "round_robin", "matches_added": len(others)}
    elif v.format == "kata_rounds":
        rounds = db.scalar(select(func.max(KataPerformance.round_number)).where(KataPerformance.category_id == c.id))
        if rounds and rounds > 1:
            raise InvalidState("La primera ronda de kata ya terminó", code="ROUND_CLOSED")
        order = (
            db.scalar(
                select(func.max(KataPerformance.order)).where(
                    KataPerformance.category_id == c.id, KataPerformance.round_number == 1
                )
            )
            or 0
        )
        _new_version(db, user, b, v, [*v.slots, r.id], label)
        db.add(KataPerformance(category_id=c.id, registration_id=r.id, order=order + 1, round_number=1))
        result = {"mode": "kata_rounds", "order": order + 1}
    else:
        raise InvalidState(
            "En grupos + eliminación no se agrega a nadie con la llave generada: regenérala si aún no empezó",
            code="UNSUPPORTED_FORMAT",
        )
    db.flush()
    sync(db, c)
    return result


def add_entrant(db: Session, user: User, cid: int, data: s.BracketEntrantIn) -> dict[str, Any]:
    c = get_category(db, cid)
    r = db.get(Registration, data.registration_id)
    if r is None or r.category_id != c.id:
        raise InvalidState("La inscripción no pertenece a esta categoría")
    if r.status != "active":
        raise InvalidState("La inscripción está retirada")
    b, _ = _current(db, c)
    check_version(b, data.version, "La llave")
    ws = []
    if any(_started(db, m) for m in current_matches(db, c.id)):
        ws.append({"code": "BRACKET_IN_PROGRESS", "message": "La llave ya tiene combates iniciados"})
    apply_warnings(db, user, ws, data.override.reason if data.override else None, "bracket", lambda: b.id)
    result = add_to_bracket(db, user, c, r, data.reason)
    audit(
        db,
        user,
        "bracket",
        b.id,
        "add_entrant",
        after={"registration_id": r.id, **result},
        reason=data.reason or (data.override.reason if data.override else None),
        tournament_id=c.tournament_id,
    )
    db.commit()
    return {"result": result, "bracket": bracket_out(db, cid)}


# ---------------------------------------------------------------------------
# Quitar de la llave
# ---------------------------------------------------------------------------


def _pending_match_of(rows: list[Match], rid: int) -> Match | None:
    mine = [
        m
        for m in rows
        if rid in (m.aka_registration_id, m.ao_registration_id)
        and m.winner_registration_id is None
        and m.status != "void"
    ]
    return min(mine, key=lambda m: (m.round, m.position), default=None)


def remove_from_bracket(db: Session, user: User, c: Category, r: Registration, reason: str) -> dict[str, Any]:
    """Saca a ``r`` de la llave vigente de ``c`` (sin commit ni cambio de
    estado de la inscripción: quien llama decide si la retira o la mueve)."""
    b, v = _current(db, c)
    label = reason or f"{r.display_name} sale de la llave"
    rows = current_matches(db, c.id)
    if v.format == "single_elimination":
        mine = [m for m in rows if r.id in (m.aka_registration_id, m.ao_registration_id)]
        played = [m for m in mine if m.status in LIVE and m.status != "bye" or _has_events(db, m.id)]
        if r.id in v.slots and not played:
            pos = v.slots.index(r.id)
            slots = list(v.slots)
            slots[pos] = None
            nv = _new_version(db, user, b, v, slots, label)
            _recount_same_dojo(db, nv)
            r1 = next(m for m in current_matches(db, c.id) if m.code == bd.match_code(1, pos // 2))
            r1.winner_registration_id, r1.method, r1.status = None, None, "pending"
            db.flush()
            sync(db, c)
            return {"mode": "bye", "position": pos}
        pending = _pending_match_of(rows, r.id)
        if pending is None:
            return {"mode": "none"}  # ya eliminado o sin combates por disputar
        if _started(db, pending):
            raise InvalidState(
                f"Su combate {pending.code} ya empezó: ciérralo en la mesa (kiken, shikkaku o walkover)",
                code="MATCH_STARTED",
            )
        if pending.aka_registration_id and pending.ao_registration_id:
            color = "ao" if pending.aka_registration_id == r.id else "aka"
            record_finish(db, user, pending, c, color, "walkover", utcnow(), str(uuid.uuid4()), label, None)
            return {"mode": "walkover", "match": pending.code}
        return {"mode": "walkover_pending", "match": pending.code}
    if v.format in ("round_robin", "groups_knockout"):
        mine = [m for m in rows if r.id in (m.aka_registration_id, m.ao_registration_id)]
        live = [m for m in mine if m.status == "in_progress" or (m.status != "finished" and _has_events(db, m.id))]
        if live:
            raise InvalidState(f"Su combate {live[0].code} está en curso: ciérralo en la mesa", code="MATCH_STARTED")
        knockout = [m for m in mine if m.kind != "group"] if v.format == "groups_knockout" else []
        if knockout:  # ya clasificó a la fase final: pierde por walkover su combate pendiente
            pending = _pending_match_of(knockout, r.id)
            if pending is None:
                return {"mode": "none"}
            if pending.aka_registration_id and pending.ao_registration_id:
                color = "ao" if pending.aka_registration_id == r.id else "aka"
                record_finish(db, user, pending, c, color, "walkover", utcnow(), str(uuid.uuid4()), label, None)
                return {"mode": "walkover", "match": pending.code}
            return {"mode": "walkover_pending", "match": pending.code}
        drop = {m.id for m in mine if m.status != "finished" and m.kind in ("main", "group")}
        _new_version(db, user, b, v, list(v.slots), label, drop)
        db.flush()
        sync(db, c)
        return {"mode": "round_robin", "matches_voided": len(drop)}
    if v.format == "kata_rounds":
        perf = db.scalar(
            select(KataPerformance)
            .where(
                KataPerformance.category_id == c.id,
                KataPerformance.registration_id == r.id,
                KataPerformance.match_id.is_(None),
            )
            .order_by(KataPerformance.round_number.desc())
        )
        if perf is None:
            return {"mode": "none"}
        if perf.scores:
            raise InvalidState("Ya ejecutó su kata: su nota queda en la ronda", code="MATCH_STARTED")
        db.delete(perf)
        slots = [x for x in v.slots if x != r.id]
        _new_version(db, user, b, v, slots, label)
        db.flush()
        sync(db, c)
        return {"mode": "kata_rounds"}
    raise InvalidState("Formato de llave desconocido")


def _bracketed(db: Session, c: Category) -> bool:
    b = _bracket(db, c.id)
    return b is not None and b.current_version_id is not None and c.status in ("ready", "in_progress")


def remove_entrant(db: Session, user: User, cid: int, data: s.BracketEntrantIn) -> dict[str, Any]:
    """Quita a un competidor de la llave y retira su inscripción."""
    c = get_category(db, cid)
    r = db.get(Registration, data.registration_id)
    if r is None or r.category_id != c.id:
        raise InvalidState("La inscripción no pertenece a esta categoría")
    if r.status != "active":
        raise InvalidState("La inscripción ya está retirada")
    if c.status == "finished":
        raise InvalidState("La categoría ya terminó", code="CATEGORY_FINISHED")
    b, _ = _current(db, c)
    check_version(b, data.version, "La llave")
    reason = data.reason or (data.override.reason if data.override else "") or "Retiro de la llave"
    result = remove_from_bracket(db, user, c, r, reason)
    r.status, r.withdrawn_reason = "withdrawn", reason
    bump(r, user)
    db.flush()
    sync(db, c)
    auto = auto_walkovers(db, user, c)
    audit(
        db,
        user,
        "bracket",
        b.id,
        "remove_entrant",
        after={"registration_id": r.id, **result, "auto_walkovers": auto},
        reason=reason,
        tournament_id=c.tournament_id,
    )
    audit(db, user, "registration", r.id, "withdraw", reason=reason, tournament_id=c.tournament_id)
    db.commit()
    return {"result": result, "bracket": bracket_out(db, cid)}


# ---------------------------------------------------------------------------
# Descalificación del torneo completo (shikkaku)
# ---------------------------------------------------------------------------


def disqualify(db: Session, user: User, rid: int, data: s.DisqualifyIn) -> dict[str, Any]:
    """Shikkaku con alcance de torneo: retira todas las inscripciones activas
    de la persona (o del equipo) en el torneo. En cada llave su lugar queda
    como bye o sus combates pendientes se pierden por walkover. Requiere
    confirmación (override) con la lista de lo que se retira."""
    r = db.get(Registration, rid)
    if r is None:
        raise NotFound("Inscripción no encontrada")
    stmt = select(Registration).where(Registration.tournament_id == r.tournament_id, Registration.status == "active")
    stmt = stmt.where(Registration.person_id == r.person_id) if r.person_id else stmt.where(Registration.id == r.id)
    regs = list(db.scalars(stmt).all())
    cats = {x.category_id: get_category(db, x.category_id) for x in regs}
    ws = [{"code": "DISQUALIFY_TOURNAMENT", "message": f"Se retira de {cats[x.category_id].name}"} for x in regs] or [
        {"code": "DISQUALIFY_TOURNAMENT", "message": "No tiene otras inscripciones activas"}
    ]
    apply_warnings(db, user, ws, data.override.reason if data.override else None, "registration", lambda: r.id)
    reason = f"Shikkaku (descalificación del torneo): {data.reason}"
    done = []
    for x in regs:
        c = cats[x.category_id]
        result: dict[str, Any] = {"mode": "none"}
        if _bracketed(db, c):
            result = remove_from_bracket(db, user, c, x, reason)
        x.status, x.withdrawn_reason = "withdrawn", reason
        bump(x, user)
        db.flush()
        refresh_category_status(db, c)
        if _bracketed(db, c):
            sync(db, c)
            auto_walkovers(db, user, c)
        audit(db, user, "registration", x.id, "disqualify", after=result, reason=reason, tournament_id=c.tournament_id)
        done.append({"registration_id": x.id, "category_id": c.id, "category_name": c.name, **result})
    db.commit()
    return {"withdrawn": done}


# ---------------------------------------------------------------------------
# Cambio de categoría con llave generada
# ---------------------------------------------------------------------------


def move_warnings(db: Session, old: Category, new: Category) -> list[dict[str, str]]:
    ws = []
    if _bracketed(db, old):
        ws.append(
            {
                "code": "BRACKET_MOVE_OUT",
                "message": f"{old.name} ya tiene llave: su lugar queda como bye o pierde por walkover "
                "su combate pendiente",
            }
        )
    if _bracketed(db, new):
        ws.append(
            {"code": "BRACKET_MOVE_IN", "message": f"{new.name} ya tiene llave: ocupará un bye libre de primera ronda"}
        )
    return ws


def move_between_brackets(db: Session, user: User, r: Registration, old: Category, new: Category, reason: str) -> dict:
    """Mueve una inscripción entre categorías con llave: sale de la llave de
    origen y entra a la de destino (sin commit)."""
    out: dict[str, Any] = {}
    if _bracketed(db, old):
        out["out"] = remove_from_bracket(db, user, old, r, reason)
    r.category_id = new.id
    db.flush()
    if _bracketed(db, old):
        sync(db, old)
        auto_walkovers(db, user, old)
    if _bracketed(db, new):
        out["in"] = add_to_bracket(db, user, new, r, reason)
    return out
