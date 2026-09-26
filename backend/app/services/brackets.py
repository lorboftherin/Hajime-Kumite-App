"""Llaves, combates y mesa (secciones 16–19).

La lógica deportiva vive en ``app.domain``; aquí solo se orquesta: se leen
filas, se llama al dominio y se guarda lo que el dominio decidió.
"""

from __future__ import annotations

import random
import uuid
from decimal import Decimal
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api import schemas as s
from app.api.errors import InvalidState, NotFound
from app.db.base import utcnow
from app.db.models import (
    AuditEntry,
    Bracket,
    BracketVersion,
    Category,
    CategoryResult,
    JudgeVote,
    KataPerformance,
    Match,
    MatchEventRow,
    Person,
    Registration,
    Tatami,
    Tournament,
    User,
)
from app.domain import brackets as bd
from app.domain.kata import (
    RankedPerformance,
    ScoringRules,
    decide_flags,
    decide_kata_match,
    kata_round_medals,
    qualifiers,
    rank_performances,
    score_performance,
)
from app.domain.kumite import (
    INFRACTIONS,
    EventType,
    MatchEvent,
    TieRule,
    compute_scoreboard,
    finish_warnings,
    is_time_over,
    period_seconds,
    suggest_decision,
)
from app.services.audit import apply_warnings, audit, bump, check_version
from app.services.tournaments import (
    effective_competition,
    effective_format,
    effective_kata,
    effective_kumite_rules,
    effective_third_place,
    get_category,
    get_tournament,
    refresh_category_status,
)

# ---------------------------------------------------------------------------
# Utilidades
# ---------------------------------------------------------------------------


def _src_to_str(src: bd.Source) -> str:
    return f"{src.kind}:{src.ref}"


def _str_to_src(v: str) -> bd.Source:
    kind, ref = v.split(":", 1)
    return bd.Source(kind, int(ref) if kind == "slot" else ref)


def _spec(m: Match) -> bd.MatchSpec:
    return bd.MatchSpec(
        m.code, m.round, m.position, _str_to_src(m.aka_source), _str_to_src(m.ao_source), bd.MatchKind(m.kind)
    )


def get_match(db: Session, mid: int) -> Match:
    m = db.get(Match, mid)
    if m is None:
        raise NotFound("Combate no encontrado")
    return m


def _bracket(db: Session, cid: int) -> Bracket | None:
    return db.scalar(select(Bracket).where(Bracket.category_id == cid))


def current_matches(db: Session, cid: int, *, bouts: bool = False) -> list[Match]:
    """Combates vigentes de la llave. Los combates individuales de un
    enfrentamiento por equipos no son parte de la llave: solo se incluyen
    con ``bouts=True``."""
    stmt = select(Match).where(Match.category_id == cid, Match.is_current)
    if not bouts:
        stmt = stmt.where(Match.parent_match_id.is_(None))
    return list(db.scalars(stmt.order_by(Match.round, Match.position)).all())


def _active_regs(db: Session, cid: int) -> list[Registration]:
    return list(
        db.scalars(
            select(Registration)
            .where(Registration.category_id == cid, Registration.status == "active")
            .order_by(Registration.id)
        ).all()
    )


def _started(db: Session, cid: int) -> bool:
    started_matches = db.scalar(
        select(func.count())
        .select_from(Match)
        .where(Match.category_id == cid, Match.is_current, Match.status.in_(("in_progress", "finished")))
    )
    scored = db.scalar(
        select(func.count())
        .select_from(KataPerformance)
        .where(KataPerformance.category_id == cid, KataPerformance.total.is_not(None))
    )
    return bool(started_matches or scored)


def _to_int(x: str | None) -> int | None:
    return int(x) if x is not None else None


# ---------------------------------------------------------------------------
# Generación
# ---------------------------------------------------------------------------


def generate(db: Session, user: User, cid: int, data: s.BracketGenerateIn) -> Bracket | None:
    c = get_category(db, cid)
    t = get_tournament(db, c.tournament_id)
    if c.status in ("merged", "cancelled", "finished"):
        raise InvalidState(f"No se puede generar la llave de una categoría {c.status}")
    if _started(db, cid):
        raise InvalidState(
            "Hay combates iniciados: la llave ya no se puede regenerar completa. Para cambios puntuales "
            "usa «Añadir a la llave» (ocupa un bye libre) o «Quitar de la llave» (bye o walkover)",
            code="BRACKET_STARTED",
        )
    regs = _active_regs(db, cid)
    if not regs:
        raise InvalidState("La categoría no tiene inscritos")
    fmt = data.format or effective_format(c, t)
    if c.modality == "kata" and effective_kata(c, t)["structure"] == "rounds":
        fmt = "kata_rounds"
    rule = bd.ThirdPlaceRule(data.third_place_rule) if data.third_place_rule else effective_third_place(c, t)
    comp = effective_competition(c, t)

    warnings: list[dict[str, str]] = []
    if fmt == "round_robin" and len(regs) > 6:
        warnings.append(
            {"code": "ROUND_ROBIN_LARGE", "message": f"Round robin con {len(regs)} inscritos: muchos combates"}
        )
    if fmt == "groups_knockout":
        groups = int(comp["groups"])
        if len(regs) < 2 * groups:
            raise InvalidState(
                f"Grupos + eliminación con {groups} grupos necesita al menos {2 * groups} inscritos",
                code="GROUPS_TOO_FEW",
            )
        if int(comp["group_qualifiers"]) >= len(regs) // groups + (1 if len(regs) % groups else 0):
            warnings.append(
                {
                    "code": "GROUPS_ALL_QUALIFY",
                    "message": "Clasifican todos los de algún grupo: revisa la configuración",
                }
            )
    if c.max_entrants and len(regs) > c.max_entrants:
        warnings.append(
            {
                "code": "CATEGORY_OVER_CAPACITY",
                "message": f"{len(regs)} inscritos para un cupo de {c.max_entrants}: considera dividir la categoría",
            }
        )
    if c.status in ("ready",):
        warnings.append({"code": "REGENERATE", "message": "La llave actual será reemplazada (se guarda la versión)"})
    apply_warnings(db, user, warnings, data.override.reason if data.override else None, "category", lambda: c.id)

    bracket = _bracket(db, cid)
    if bracket is None:
        bracket = Bracket(category_id=cid)
        db.add(bracket)
        db.flush()
    _retire_current(db, cid)
    # Ninguna ejecución tiene nota (si no, la llave ya habría empezado).
    db.execute(delete(KataPerformance).where(KataPerformance.category_id == cid))

    seed = data.seed if data.seed is not None else random.SystemRandom().randrange(1, 2**31)
    number = (
        db.scalar(select(func.max(BracketVersion.number)).where(BracketVersion.bracket_id == bracket.id)) or 0
    ) + 1

    def version(fmt_: str, size: int, slots: list[int | None], same_dojo: int = 0, seed_: int = seed):
        return BracketVersion(
            bracket_id=bracket.id,
            number=number,
            format=fmt_,
            third_place_rule=rule.value,
            seed=seed_,
            size=size,
            slots=slots,
            same_dojo_first_round=same_dojo,
            reason=data.reason,
            created_by_id=user.id,
        )

    specs: list[bd.MatchSpec] = []
    extra_rows: list[Match] = []
    if fmt == "kata_rounds":
        rng = random.Random(seed)
        order = regs[:]
        rng.shuffle(order)
        v = version(fmt, len(order), [r.id for r in order])
        db.add(v)
        db.flush()
        cfg = effective_kata(c, t)
        groups = max(1, int(cfg.get("first_round_groups") or 1)) if cfg.get("rounds") else 1
        for i, r in enumerate(order):
            db.add(
                KataPerformance(
                    category_id=cid,
                    registration_id=r.id,
                    order=i + 1,
                    round_number=1,
                    group_number=(i % groups) + 1 if groups > 1 else None,
                )
            )
    elif fmt == "round_robin":
        rng = random.Random(seed)
        order = regs[:]
        rng.shuffle(order)
        slots = [r.id for r in order]
        specs = bd.round_robin_schedule([str(x) for x in slots])
        v = version(fmt, len(slots), slots)
    elif fmt == "groups_knockout":
        v, extra_rows = _generate_groups(db, c, regs, comp, rule, seed, version)
    else:
        entrants = _entrants(regs, comp)
        gen = bd.generate_single_elimination(entrants, seed=seed, third_place_rule=rule)
        specs = list(gen.matches)
        v = version(
            "single_elimination", gen.size, [_to_int(x) for x in gen.slots], gen.same_dojo_first_round, gen.seed
        )
    if v.id is None:
        db.add(v)
        db.flush()
    for sp in specs:
        db.add(
            Match(
                category_id=cid,
                bracket_version_id=v.id,
                code=sp.code,
                kind=sp.kind.value,
                round=sp.round,
                position=sp.position,
                aka_source=_src_to_str(sp.aka),
                ao_source=_src_to_str(sp.ao),
            )
        )
    for m in extra_rows:
        m.bracket_version_id = v.id
        db.add(m)
    bracket.current_version_id = v.id
    bump(bracket, user)
    c.status = "ready"
    db.flush()
    sync(db, c)
    audit(
        db,
        user,
        "bracket",
        bracket.id,
        "generate",
        after={"version": number, "format": v.format, "seed": v.seed, "same_dojo_first_round": v.same_dojo_first_round},
        reason=data.reason or None,
        tournament_id=c.tournament_id,
    )
    db.commit()
    db.refresh(bracket)
    return bracket


def _entrants(regs: list[Registration], comp: dict[str, Any]) -> list[bd.Entrant]:
    """Participantes para el dominio; con separación por ciudad se agrega la
    ciudad del dojo como segundo criterio."""
    by_city = "city" in (comp.get("separation") or [])
    return [
        bd.Entrant(str(r.id), str(r.dojo_id), r.seed, (r.dojo.city or None) if by_city and r.dojo else None)
        for r in regs
    ]


def _generate_groups(db: Session, c: Category, regs: list[Registration], comp: dict[str, Any], rule, seed, version):
    """Grupos + eliminación: N grupos todos contra todos; pasan K por grupo a
    una llave de eliminación con cruces A1–B2, B1–A2…

    ``slots`` guarda a los inscritos agrupados (grupo A, luego B…); los
    combates de grupo son de tipo ``group`` (código ``GA1-1``) y los de la
    fase final apuntan a «clasificados» (``qual:i``) que se conocen al
    terminar todos los grupos.
    """
    n_groups = int(comp["groups"])
    per_group = int(comp["group_qualifiers"])
    rng = random.Random(seed)
    groups = bd.split_groups(_entrants(regs, comp), n_groups, rng)
    slots: list[int | None] = []
    rows: list[Match] = []
    for gi, members in enumerate(groups):
        base = len(slots)
        slots.extend(int(e.id) for e in members)
        letter = bd.group_letter(gi)
        for sp in bd.round_robin_schedule([e.id for e in members]):
            rows.append(
                Match(
                    category_id=c.id,
                    code=f"G{letter}{sp.round}-{sp.position + 1}",
                    kind="group",
                    round=sp.round,
                    position=gi * 100 + sp.position,
                    aka_source=f"slot:{base + int(sp.aka.ref)}",
                    ao_source=f"slot:{base + int(sp.ao.ref)}",
                )
            )
    size, _layout = bd.knockout_positions(n_groups, per_group)
    for sp in bd.build_single_elimination(size, rule):
        rows.append(
            Match(
                category_id=c.id,
                code=sp.code,
                kind=sp.kind.value,
                round=sp.round,
                position=sp.position,
                aka_source=_src_to_str(sp.aka).replace("slot:", "qual:"),
                ao_source=_src_to_str(sp.ao).replace("slot:", "qual:"),
            )
        )
    dojo_of = {str(r.id): str(r.dojo_id) for r in regs}
    same = sum(
        1
        for gi, members in enumerate(groups)
        for a in range(len(members))
        for b in range(a + 1, len(members))
        if dojo_of[members[a].id] == dojo_of[members[b].id]
    )
    v = version("groups_knockout", len(slots), slots, same)
    db.add(v)
    db.flush()
    return v, rows


def _retire_current(db: Session, cid: int) -> None:
    for m in current_matches(db, cid, bouts=True):
        m.is_current = False
    db.execute(delete(CategoryResult).where(CategoryResult.category_id == cid))


def discard_bracket(db: Session, c: Category) -> None:
    """Descarta la llave vigente (sin combates iniciados), p. ej. al deshacer una fusión."""
    b = _bracket(db, c.id)
    if b is None or b.current_version_id is None:
        return
    if _started(db, c.id):
        raise InvalidState("La llave tiene combates iniciados")
    _retire_current(db, c.id)
    db.execute(delete(KataPerformance).where(KataPerformance.category_id == c.id))
    b.current_version_id = None
    if c.status == "ready":
        c.status = "open"
    refresh_category_status(db, c)


def swap_slots(db: Session, user: User, bracket_id: int, data: s.SlotSwapIn) -> Bracket:
    """Mover o intercambiar posiciones (o un competidor con un bye).

    Se guarda una nueva versión. Si un combate de primera ronda afectado ya
    empezó se bloquea (corrompería sus eventos); si hay otros combates
    iniciados se advierte.
    """
    b = db.get(Bracket, bracket_id)
    if b is None or b.current_version_id is None:
        raise NotFound("Llave no encontrada")
    check_version(b, data.version, "La llave")
    cur = db.get(BracketVersion, b.current_version_id)
    assert cur is not None
    if cur.format == "kata_rounds":
        return _swap_kata_order(db, user, b, cur, data)
    if cur.format != "single_elimination":
        raise InvalidState("Solo se editan posiciones en eliminación directa y en rondas de kata")
    if not (0 <= data.a < cur.size and 0 <= data.b < cur.size) or data.a == data.b:
        raise InvalidState("Posiciones inválidas")
    c = get_category(db, b.category_id)
    matches = current_matches(db, c.id)
    affected = {f"slot:{data.a}", f"slot:{data.b}"}
    touched = [m for m in matches if m.aka_source in affected or m.ao_source in affected]
    if any(m.status in ("in_progress", "finished") for m in touched):
        raise InvalidState("Un combate de esas posiciones ya empezó; usa walkover o corrección", code="MATCH_STARTED")
    others = [m for m in matches if m.status in ("in_progress", "finished")]
    ws = []
    if others:
        ws.append({"code": "BRACKET_IN_PROGRESS", "message": f"Hay {len(others)} combates ya iniciados en la llave"})
    apply_warnings(db, user, ws, data.override.reason if data.override else None, "bracket", lambda: b.id)

    slots = list(cur.slots)
    slots[data.a], slots[data.b] = slots[data.b], slots[data.a]
    for i in range(0, len(slots), 2):
        if slots[i] is None and slots[i + 1] is None:
            raise InvalidState("No puede quedar un combate de bye contra bye")
    regs = {r.id: r for r in _active_regs(db, c.id)}
    dojo_of = {str(k): str(v.dojo_id) for k, v in regs.items()}
    v = BracketVersion(
        bracket_id=b.id,
        number=cur.number + 1,
        format=cur.format,
        third_place_rule=cur.third_place_rule,
        seed=cur.seed,
        size=cur.size,
        slots=slots,
        same_dojo_first_round=bd.count_same_dojo_first_round(
            tuple(str(x) if x is not None else None for x in slots), dojo_of
        ),
        reason=data.reason or f"Intercambio {data.a}↔{data.b}",
        created_by_id=user.id,
    )
    db.add(v)
    db.flush()
    for m in current_matches(db, c.id, bouts=True):  # mismos combates, ahora sobre la nueva versión
        m.bracket_version_id = v.id
    b.current_version_id = v.id
    bump(b, user)
    db.flush()
    sync(db, c)
    audit(
        db,
        user,
        "bracket",
        b.id,
        "swap",
        before={"slots": cur.slots},
        after={"slots": slots},
        reason=data.reason or None,
        tournament_id=c.tournament_id,
    )
    db.commit()
    db.refresh(b)
    return b


def _swap_kata_order(db: Session, user: User, b: Bracket, cur: BracketVersion, data: s.SlotSwapIn) -> Bracket:
    """Rondas de kata: intercambia el orden de salida de dos posiciones (1-based
    en ``order`` = posición + 1) de la ronda en curso. Se bloquea si alguno ya
    ejecutó."""
    c = get_category(db, b.category_id)
    round_number = _current_kata_round(db, c.id)
    perfs = {
        p.order: p
        for p in db.scalars(
            select(KataPerformance).where(
                KataPerformance.category_id == c.id,
                KataPerformance.round_number == round_number,
                KataPerformance.match_id.is_(None),
            )
        ).all()
    }
    pa, pb = perfs.get(data.a + 1), perfs.get(data.b + 1)
    if pa is None or pb is None or data.a == data.b:
        raise InvalidState("Posiciones inválidas")
    if pa.scores or pb.scores:
        raise InvalidState("Uno de los dos ya ejecutó; su orden no se cambia", code="MATCH_STARTED")
    pa.order, pb.order = pb.order, pa.order
    bump(pa, user)
    bump(pb, user)
    slots = list(cur.slots)
    if round_number == 1 and pa.registration_id in slots and pb.registration_id in slots:
        ia, ib = slots.index(pa.registration_id), slots.index(pb.registration_id)
        slots[ia], slots[ib] = slots[ib], slots[ia]
    v = BracketVersion(
        bracket_id=b.id,
        number=cur.number + 1,
        format=cur.format,
        third_place_rule=cur.third_place_rule,
        seed=cur.seed,
        size=cur.size,
        slots=slots,
        reason=data.reason or f"Orden de salida {data.a + 1}↔{data.b + 1}",
        created_by_id=user.id,
    )
    db.add(v)
    db.flush()
    b.current_version_id = v.id
    bump(b, user)
    audit(
        db,
        user,
        "bracket",
        b.id,
        "swap",
        before={"slots": cur.slots},
        after={"slots": slots},
        reason=data.reason or None,
        tournament_id=c.tournament_id,
    )
    db.commit()
    db.refresh(b)
    return b


# ---------------------------------------------------------------------------
# Sincronización: resultados → participantes, estados y podio
# ---------------------------------------------------------------------------


def sync(db: Session, c: Category) -> dict[str, Any]:
    b = _bracket(db, c.id)
    if b is None or b.current_version_id is None:
        return {}
    v = db.get(BracketVersion, b.current_version_id)
    assert v is not None
    if v.format == "kata_rounds":
        return _sync_kata_rounds(db, c, v)
    rows = current_matches(db, c.id)
    by_code = {m.code: m for m in rows}
    winners = {m.code: str(m.winner_registration_id) for m in rows if m.winner_registration_id}

    if v.format == "round_robin":
        return _sync_round_robin(db, c, v, rows)
    if v.format == "groups_knockout":
        return _sync_groups_knockout(db, c, v, rows)

    slots = tuple(str(x) if x is not None else None for x in v.slots)
    specs = [_spec(m) for m in rows if m.kind != bd.MatchKind.REPECHAGE]
    res = bd.resolve(slots, specs, winners, bd.ThirdPlaceRule(v.third_place_rule), _repechage_excluded(db, c, rows))
    # Repechaje: el dominio lo arma cuando hay finalistas; se crean filas nuevas.
    for code, rm in res.matches.items():
        if code not in by_code and rm.spec.kind == bd.MatchKind.REPECHAGE:
            m = Match(
                category_id=c.id,
                bracket_version_id=v.id,
                code=code,
                kind=rm.spec.kind.value,
                round=rm.spec.round,
                position=rm.spec.position,
                aka_source=_src_to_str(rm.spec.aka),
                ao_source=_src_to_str(rm.spec.ao),
            )
            db.add(m)
            db.flush()
            by_code[code] = m

    for code, m in by_code.items():
        rm = res.matches.get(code)
        if rm is None:
            m.status = "void"  # p. ej. repechaje que dejó de existir tras una corrección
            continue
        m.aka_registration_id = _to_int(rm.aka)
        m.ao_registration_id = _to_int(rm.ao)
        _update_status(db, m, rm.ready, rm.is_bye, rm.winner)

    places = res.podium.places() if res.podium.complete else []
    _store_results(db, c, places, complete=res.podium.complete)
    return {"podium": res.podium}


def _update_status(db: Session, m: Match, ready: bool, is_bye: bool, winner: str | None) -> None:
    has_events = db.scalar(select(func.count()).select_from(MatchEventRow).where(MatchEventRow.match_id == m.id))
    if not has_events:  # enfrentamiento por equipos con alineación: ya empezó
        has_events = db.scalar(select(func.count()).select_from(Match).where(Match.parent_match_id == m.id))
    if is_bye:
        m.status = "bye"
        m.winner_registration_id = _to_int(winner)
        m.method = "bye"
    elif m.winner_registration_id is not None:
        if winner is not None and int(winner) == m.winner_registration_id:
            m.status = "finished"
        else:
            m.status = "needs_review"  # su ganador ya no es uno de los participantes
    elif has_events:
        m.status = "in_progress"
    else:
        m.status = "ready" if ready else "pending"


def _store_results(db: Session, c: Category, places: list[tuple[int, str]], complete: bool) -> None:
    """Guarda el podio solo si cambió: una lectura no debe generar escrituras."""
    # La sesión no hace autoflush: sin esto, un podio agregado antes en la misma
    # transacción (p. ej. al cerrar el combate que decide la final por equipos)
    # no se ve aquí y se insertaría dos veces.
    db.flush()
    current = {
        (r.place, r.registration_id)
        for r in db.scalars(select(CategoryResult).where(CategoryResult.category_id == c.id)).all()
    }
    wanted = {(place, int(rid)) for place, rid in places}
    if current != wanted:
        db.execute(delete(CategoryResult).where(CategoryResult.category_id == c.id))
        for place, rid in places:
            db.add(CategoryResult(category_id=c.id, registration_id=int(rid), place=place))
    if c.status in ("merged", "cancelled"):
        return
    if complete and not _reopened_pending(db, c):
        new_status = "finished"
    elif _started(db, c.id):
        new_status = "in_progress"
    else:
        new_status = "ready"
    if c.status != new_status:
        c.status = new_status


def _reopened_pending(db: Session, c: Category) -> bool:
    """Tras reabrir, la categoría no vuelve a finalizar sola: espera una
    corrección (nuevo ``finish`` o nota de kata) del operador."""
    last = db.scalar(
        select(AuditEntry)
        .where(
            AuditEntry.entity == "category",
            AuditEntry.entity_id == str(c.id),
            AuditEntry.action.in_(("reopen", "refinish")),
        )
        .order_by(AuditEntry.id.desc())
    )
    return last is not None and last.action == "reopen"


def _close_reopen(db: Session, user: User, c: Category) -> None:
    if _reopened_pending(db, c):
        audit(db, user, "category", c.id, "refinish", tournament_id=c.tournament_id)
        db.flush()


def reopen_category(db: Session, user: User, cid: int, reason: str) -> Category:
    """Sección 12: una categoría finalizada se reabre con auditoría, sin reabrir el torneo."""
    c = get_category(db, cid)
    if c.status != "finished":
        raise InvalidState("Solo se reabre una categoría finalizada")
    c.status = "in_progress"
    db.execute(delete(CategoryResult).where(CategoryResult.category_id == c.id))
    bump(c, user)
    audit(
        db, user, "category", c.id, "reopen", {"status": "finished"}, {"status": "in_progress"}, reason, c.tournament_id
    )
    db.commit()
    db.refresh(c)
    return c


def _sync_round_robin(db: Session, c: Category, v: BracketVersion, rows: list[Match]) -> dict[str, Any]:
    t = get_tournament(db, c.tournament_id)
    comp = effective_competition(c, t)
    standings, complete = _rr_table(db, c, v, list(v.slots), rows, comp)
    bronzes = 1
    if int(comp["round_robin_bronzes"]) >= 2 and len(standings) >= int(comp["round_robin_two_bronzes_min"]):
        bronzes = 2
    places: list[tuple[int, str]] = []
    if complete:
        places, complete = bd.round_robin_places(standings, bronzes)  # empate sin resolver: decide el organizador
    _store_results(db, c, places, complete)
    return {"standings": standings}


def _withdrawn_ids(db: Session, c: Category, ids: list[int]) -> set[int]:
    """Inscripciones que ya no compiten en la categoría (retiradas o movidas)."""
    rows = db.scalars(select(Registration).where(Registration.id.in_(ids or [0]))).all()
    return {r.id for r in rows if r.status != "active" or r.category_id != c.id}


def _rr_table(
    db: Session, c: Category, v: BracketVersion, slots: list[int | None], rows: list[Match], comp: dict[str, Any]
) -> tuple[list[bd.RRStanding], bool]:
    """Clasificación de un todos contra todos (round robin o un grupo).

    Quien se retiró o fue quitado de la llave no se clasifica y sus
    resultados no cuentan para los demás (sus combates pendientes ya se
    anularon al quitarlo)."""
    results = []
    gone = _withdrawn_ids(db, c, [x for x in slots if x])
    for m in rows:
        a, b = v.slots[int(m.aka_source.split(":")[1])], v.slots[int(m.ao_source.split(":")[1])]
        m.aka_registration_id, m.ao_registration_id = a, b
        _update_status(db, m, True, False, str(m.winner_registration_id) if m.winner_registration_id else None)
        if m.status == "finished" and a not in gone and b not in gone and m.winner_registration_id:
            results.append(
                bd.RRResult(str(a), str(b), str(m.winner_registration_id), m.aka_score or 0, m.ao_score or 0)
            )
    complete = all(m.status == "finished" for m in rows)
    criteria = tuple(comp["round_robin_criteria"])
    sanctions = _sanction_totals(db, c, rows) if "fewer_sanctions" in criteria else None
    entrants = [str(x) for x in slots if x and x not in gone]
    return bd.round_robin_standings(entrants, results, criteria, sanctions, v.seed), complete


def _sanction_totals(db: Session, c: Category, rows: list[Match]) -> dict[str, int]:
    """Suma, por participante, del nivel de sanción más alto de cada combate cerrado."""
    t = get_tournament(db, c.tournament_id)
    rules = effective_kumite_rules(c, t)
    out: dict[str, int] = {}
    for m in rows:
        if m.status != "finished":
            continue
        sb = compute_scoreboard(_domain_events(_events(db, m.id)), rules)
        for color, rid in (("aka", m.aka_registration_id), ("ao", m.ao_registration_id)):
            if rid:
                out[str(rid)] = out.get(str(rid), 0) + sb.sanction[color] + sb.sanction_c2[color]
    return out


def _repechage_excluded(db: Session, c: Category, rows: list[Match]) -> set[str]:
    """Combates cuyo perdedor no va al repechaje (por defecto kiken, shikkaku
    y hansoku, como WKF; configurable en ``repechage_excluded_methods``)."""
    t = get_tournament(db, c.tournament_id)
    methods = set(effective_competition(c, t)["repechage_excluded_methods"] or [])
    return {m.code for m in rows if m.method in methods and m.status == "finished"}


def _sync_groups_knockout(db: Session, c: Category, v: BracketVersion, rows: list[Match]) -> dict[str, Any]:
    """Grupos todos contra todos y, al terminarlos, la fase final por eliminación."""
    t = get_tournament(db, c.tournament_id)
    comp = effective_competition(c, t)
    group_rows: dict[str, list[Match]] = {}
    members: dict[str, list[int]] = {}
    for m in rows:
        if m.kind == "group":
            letter = m.code[1]
            group_rows.setdefault(letter, []).append(m)
            for src in (m.aka_source, m.ao_source):
                rid = v.slots[int(src.split(":")[1])]
                if rid not in members.setdefault(letter, []):
                    members[letter].append(rid)
    per_group = int(comp["group_qualifiers"])
    tables: dict[str, list[bd.RRStanding]] = {}
    qualified: dict[tuple[int, int], str] = {}
    all_done = True
    for gi, letter in enumerate(sorted(group_rows)):
        standings, complete = _rr_table(db, c, v, sorted(members[letter]), group_rows[letter], comp)
        tables[letter] = standings
        cut_tied = any(st.tied for st in standings if st.rank <= per_group)
        if not complete or cut_tied:
            all_done = False
        for st in standings[:per_group]:
            qualified[(gi, st.rank)] = st.entrant
    size, layout = bd.knockout_positions(len(group_rows), per_group)
    ko_rows = [m for m in rows if m.kind != "group"]
    by_code = {m.code: m for m in ko_rows}
    res = None
    if all_done:
        ko_slots = tuple(qualified.get(q) if q else None for q in layout)
        winners = {m.code: str(m.winner_registration_id) for m in ko_rows if m.winner_registration_id}

        def as_slot(x: str) -> bd.Source:
            src = _str_to_src(x)
            return bd.Source("slot", int(src.ref)) if src.kind == "qual" else src

        specs = [
            bd.MatchSpec(m.code, m.round, m.position, as_slot(m.aka_source), as_slot(m.ao_source), bd.MatchKind(m.kind))
            for m in ko_rows
            if m.kind != bd.MatchKind.REPECHAGE
        ]
        res = bd.resolve(
            ko_slots, specs, winners, bd.ThirdPlaceRule(v.third_place_rule), _repechage_excluded(db, c, rows)
        )
        for code, rm in res.matches.items():
            if code not in by_code and rm.spec.kind == bd.MatchKind.REPECHAGE:
                m = Match(
                    category_id=c.id,
                    bracket_version_id=v.id,
                    code=code,
                    kind=rm.spec.kind.value,
                    round=rm.spec.round,
                    position=rm.spec.position,
                    aka_source=_src_to_str(rm.spec.aka),
                    ao_source=_src_to_str(rm.spec.ao),
                )
                db.add(m)
                db.flush()
                by_code[code] = m
    for code, m in by_code.items():
        rm = res.matches.get(code) if res else None
        if rm is None:
            if res is not None:
                m.status = "void"
                continue
            m.aka_registration_id = m.ao_registration_id = None
            if m.winner_registration_id is None:
                m.status = "pending"
            continue
        m.aka_registration_id = _to_int(rm.aka)
        m.ao_registration_id = _to_int(rm.ao)
        _update_status(db, m, rm.ready, rm.is_bye, rm.winner)
    complete = bool(res and res.podium.complete)
    _store_results(db, c, res.podium.places() if complete and res else [], complete=complete)
    return {"groups": tables, "podium": res.podium if res else None}


def _rank_round(perfs: list[KataPerformance], rules: ScoringRules) -> list[RankedPerformance]:
    """Clasificación de un grupo de ejecuciones, con el desempate manual
    (nueva ejecución o juez principal) que registró el organizador."""
    scored = {
        str(p.registration_id): score_performance(p.scores, rules, p.athletic_scores if rules.split else None)
        for p in perfs
        if p.scores
    }
    ranked = rank_performances(scored)
    manual = {str(p.registration_id): p.tie_break_place for p in perfs if p.tie_break_place}
    if manual:
        ranked.sort(key=lambda r: (r.rank, manual.get(r.entrant, 10**6)))
        for i, r in enumerate(ranked):
            if r.unresolved_tie and r.entrant in manual:
                r.unresolved_tie = False
                r.rank = i + 1
    return ranked


def _kata_cuts(cfg: dict[str, Any]) -> list[int]:
    return [int(x) for x in (cfg.get("rounds") or [])]


def _sync_kata_rounds(db: Session, c: Category, v: BracketVersion) -> dict[str, Any]:
    """Rondas de kata por puntuación.

    Con ``rounds`` vacío (por defecto) hay una ronda única, como antes. Con
    ``rounds = [8, 4]`` pasan los 8 mejores a la 2.ª ronda y los 4 mejores a
    la final. En la primera ronda puede haber grupos (``first_round_groups``):
    pasan los mejores de cada grupo. Las notas no se arrastran entre rondas.
    La ronda siguiente se arma sola al completarse la anterior, con el orden
    de salida configurado (``round_order``); si una corrección cambia los
    clasificados y la ronda siguiente ya tiene notas, se marca para revisión.
    """
    t = get_tournament(db, c.tournament_id)
    cfg = effective_kata(c, t)
    rules = _scoring_rules(cfg)
    cuts = _kata_cuts(cfg)
    total_rounds = len(cuts) + 1
    all_perfs = list(db.scalars(select(KataPerformance).where(KataPerformance.category_id == c.id)).all())
    by_round: dict[int, list[KataPerformance]] = {}
    for p in all_perfs:
        by_round.setdefault(p.round_number, []).append(p)
    info_rounds: list[dict[str, Any]] = []
    needs_review = False
    r = 1
    ranked: list[RankedPerformance] = []
    while r in by_round:
        perfs = by_round[r]
        groups: dict[int | None, list[KataPerformance]] = {}
        for p in perfs:
            groups.setdefault(p.group_number, []).append(p)
        ranked = []
        ranked_by_group = {}
        for g, members in sorted(groups.items(), key=lambda kv: kv[0] or 0):
            ranked_by_group[g] = _rank_round(members, rules)
            ranked.extend(ranked_by_group[g])
        complete = bool(perfs) and all(p.scores for p in perfs)
        entry: dict[str, Any] = {"round": r, "complete": complete, "qualified": [], "cut_tied": False}
        if r < total_rounds and complete:
            n = cuts[r - 1]
            qualified: list[str] = []
            ok = True
            share = [n // len(groups) + (1 if i < n % len(groups) else 0) for i in range(len(groups))]
            for i, g in enumerate(sorted(groups, key=lambda x: x or 0)):
                q, fine = qualifiers(ranked_by_group[g], share[i])
                qualified += q
                ok = ok and fine
            entry["qualified"] = [int(x) for x in qualified]
            entry["cut_tied"] = not ok
            if ok:
                needs_review |= _ensure_next_round(db, c, v, cfg, r, ranked_by_group, qualified, by_round.get(r + 1))
                if (r + 1) not in by_round:
                    by_round[r + 1] = list(
                        db.scalars(
                            select(KataPerformance).where(
                                KataPerformance.category_id == c.id, KataPerformance.round_number == r + 1
                            )
                        ).all()
                    )
        info_rounds.append(entry)
        if r == total_rounds:
            break
        r += 1
    final = by_round.get(total_rounds) or []
    ok = False
    places: list[tuple[int, str]] = []
    if final and all(p.scores for p in final) and not needs_review:
        bronzes = 1 if v.third_place_rule == "third_place_match" else 2
        medals = kata_round_medals(ranked, bronzes=bronzes)
        places = [(place, e) for place, es in medals.items() for e in es]
        ok = len(places) >= min(len(final), 2 + bronzes)
    _store_results(db, c, places if ok else [], complete=ok)
    current = max(by_round) if by_round else 1
    return {
        "ranking": ranked,
        "kata_rounds": {
            "current": current,
            "total": total_rounds,
            "cuts": cuts,
            "rounds": info_rounds,
            "needs_review": needs_review,
        },
    }


def _ensure_next_round(
    db: Session,
    c: Category,
    v: BracketVersion,
    cfg: dict[str, Any],
    r: int,
    ranked_by_group: dict[int | None, list[RankedPerformance]],
    qualified: list[str],
    existing: list[KataPerformance] | None,
) -> bool:
    """Crea (o rehace, si nadie ejecutó aún) la ronda ``r + 1`` con los
    clasificados. Devuelve True si la ronda siguiente ya tiene notas y sus
    participantes no coinciden (necesita revisión del organizador)."""
    wanted = [int(x) for x in qualified]
    if existing:
        if {p.registration_id for p in existing} == set(wanted):
            return False
        if any(p.scores for p in existing):
            return True
        for p in existing:
            db.delete(p)
        db.flush()
    rank_of: dict[str, int] = {}
    for ranked in ranked_by_group.values():
        for x in ranked:
            rank_of[x.entrant] = x.rank
    order = sorted(wanted, key=lambda rid: (rank_of.get(str(rid), 0), rid))
    mode = cfg.get("round_order") or "reverse_rank"
    if mode == "reverse_rank":
        order.reverse()  # el mejor clasificado sale al final (WKF)
    elif mode == "random":
        random.Random(v.seed + r).shuffle(order)
    for i, rid in enumerate(order):
        db.add(KataPerformance(category_id=c.id, registration_id=rid, order=i + 1, round_number=r + 1))
    db.flush()
    return False


def _scoring_rules(cfg: dict[str, Any]) -> ScoringRules:
    return ScoringRules(
        judges=int(cfg["judges"]),
        min_score=Decimal(str(cfg["min_score"])),
        max_score=Decimal(str(cfg["max_score"])),
        discard_each_side=cfg.get("discard_each_side"),
        split=bool(cfg.get("split")),
        technical_weight=Decimal(str(cfg.get("technical_weight") or "0.7")),
    )


def _kata_standings(db: Session, cid: int, info: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    """Tabla de la ronda en curso (lo que muestra la mesa de kata) y el detalle
    de todas las rondas."""
    rounds_info = info.get("kata_rounds")
    current = rounds_info["current"] if rounds_info else 1
    perfs = list(db.scalars(select(KataPerformance).where(KataPerformance.category_id == cid)).all())

    def rows(r: int) -> list[dict[str, Any]]:
        mine = [p for p in perfs if p.round_number == r]
        c = get_category(db, cid)
        rules = _scoring_rules(effective_kata(c, get_tournament(db, c.tournament_id)))
        groups: dict[int | None, list[KataPerformance]] = {}
        for p in mine:
            groups.setdefault(p.group_number, []).append(p)
        ranked = {int(x.entrant): x for g in groups.values() for x in _rank_round(g, rules)}
        return [
            {
                "registration_id": p.registration_id,
                "round_number": p.round_number,
                "group_number": p.group_number,
                "order": p.order,
                "kata_name": p.kata_name,
                "scores": p.scores,
                "athletic_scores": p.athletic_scores,
                "judge_person_ids": p.judge_person_ids,
                "total": float(ranked[p.registration_id].result.total) if p.registration_id in ranked else None,
                "technical": float(ranked[p.registration_id].result.technical)
                if p.registration_id in ranked and ranked[p.registration_id].result.technical is not None
                else None,
                "rank": ranked[p.registration_id].rank if p.registration_id in ranked else None,
                "tied": ranked[p.registration_id].unresolved_tie if p.registration_id in ranked else False,
                "version": p.version,
            }
            for p in sorted(mine, key=lambda p: (p.group_number or 0, p.order))
        ]

    standings = rows(current)
    if rounds_info is None:
        return standings, None
    detail = {**rounds_info, "rounds": [{**r, "standings": rows(r["round"])} for r in rounds_info["rounds"]]}
    return standings, detail


# ---------------------------------------------------------------------------
# Lectura
# ---------------------------------------------------------------------------


def participants(db: Session, ids: set[int]) -> dict[int, s.ParticipantOut]:
    if not ids:
        return {}
    regs = db.scalars(select(Registration).where(Registration.id.in_(ids))).all()
    out = {}
    for r in regs:
        out[r.id] = s.ParticipantOut(
            registration_id=r.id, name=r.display_name, dojo_id=r.dojo_id, dojo_name=r.dojo.name
        )
    return out


def bracket_out(db: Session, cid: int) -> s.BracketOut:
    b = _bracket(db, cid)
    if b is None or b.current_version_id is None:
        raise NotFound("La categoría no tiene llave")
    v = db.get(BracketVersion, b.current_version_id)
    assert v is not None
    c = get_category(db, cid)
    info = sync(db, c)
    if db.dirty or db.new or db.deleted:
        db.commit()
    rows = current_matches(db, cid)
    ids = {x for x in v.slots if x} | {x for m in rows for x in (m.aka_registration_id, m.ao_registration_id) if x}
    podium: dict[str, Any] = {}
    results = db.scalars(
        select(CategoryResult).where(CategoryResult.category_id == cid).order_by(CategoryResult.place)
    ).all()
    podium["places"] = [{"place": r.place, "registration_id": r.registration_id} for r in results]
    podium["complete"] = c.status == "finished"
    standings = None
    kata_rounds = None
    if "standings" in info:
        standings = [
            {
                "registration_id": int(st.entrant),
                "rank": st.rank,
                "wins": st.wins,
                "played": st.played,
                "points_for": st.points_for,
                "points_against": st.points_against,
                "tied": st.tied,
            }
            for st in info["standings"]
        ]
    if "ranking" in info:
        standings, kata_rounds = _kata_standings(db, cid, info)
    groups = _groups_out(info["groups"]) if info.get("groups") else None
    return s.BracketOut(
        id=b.id,
        category_id=cid,
        version=b.version,
        version_number=v.number,
        format=v.format,
        third_place_rule=v.third_place_rule,
        seed=v.seed,
        size=v.size,
        slots=v.slots,
        same_dojo_first_round=v.same_dojo_first_round,
        participants=participants(db, ids),
        matches=[s.MatchOut.model_validate(m) for m in rows],
        podium=podium,
        standings=standings,
        groups=groups,
        kata_rounds=kata_rounds,
    )


def _groups_out(tables: dict[str, list[bd.RRStanding]]) -> list[dict[str, Any]]:
    return [
        {
            "letter": letter,
            "standings": [
                {
                    "registration_id": int(st.entrant),
                    "rank": st.rank,
                    "wins": st.wins,
                    "played": st.played,
                    "points_for": st.points_for,
                    "points_against": st.points_against,
                    "tied": st.tied,
                }
                for st in rows
            ],
        }
        for letter, rows in sorted(tables.items())
    ]


def bracket_versions(db: Session, cid: int) -> list[dict[str, Any]]:
    b = _bracket(db, cid)
    if b is None:
        return []
    vs = db.scalars(
        select(BracketVersion).where(BracketVersion.bracket_id == b.id).order_by(BracketVersion.number)
    ).all()
    return [
        {
            "id": v.id,
            "number": v.number,
            "format": v.format,
            "seed": v.seed,
            "slots": v.slots,
            "reason": v.reason,
            "created_at": v.created_at.isoformat(),
            "current": v.id == b.current_version_id,
        }
        for v in vs
    ]


# ---------------------------------------------------------------------------
# Mesa de kumite
# ---------------------------------------------------------------------------


def _events(db: Session, mid: int) -> list[MatchEventRow]:
    return list(
        db.scalars(
            select(MatchEventRow)
            .where(MatchEventRow.match_id == mid)
            .order_by(MatchEventRow.device_at, MatchEventRow.received_at)
        ).all()
    )


def _domain_events(rows: list[MatchEventRow]) -> list[MatchEvent]:
    return [
        MatchEvent(
            id=e.id,
            type=EventType(e.type),
            at=e.device_at,
            color=e.color,
            value=float(e.value) if e.value is not None else None,
            target_id=e.target_id,
            method=e.method,
            reason=e.reason,
        )
        for e in rows
    ]


def _naive_utc(dt):
    if dt.tzinfo is not None:
        from datetime import UTC

        dt = dt.astimezone(UTC).replace(tzinfo=None)
    return dt


def _ctx(db: Session, m: Match) -> tuple[Category, Tournament]:
    c = get_category(db, m.category_id)
    return c, get_tournament(db, c.tournament_id)


def scoreboard(db: Session, m: Match) -> s.ScoreboardOut:
    c, t = _ctx(db, m)
    rules = effective_kumite_rules(c, t)
    rows = _events(db, m.id)
    sb = compute_scoreboard(_domain_events(rows), rules, now=utcnow())
    time_over = is_time_over(sb, rules)
    d = suggest_decision(sb, rules, time_over)
    parts = participants(db, {x for x in (m.aka_registration_id, m.ao_registration_id) if x})
    bout = _bout_info(db, m, parts) if m.parent_match_id else None
    return s.ScoreboardOut(
        match=s.MatchOut.model_validate(m),
        rules={
            "time_mode": rules.time_mode.value,
            "auto_pause_on_point": rules.auto_pause_on_point,
            "tie_rule": rules.tie_rule.value,
            "lead_victory": rules.lead_victory,
            "point_values": list(rules.point_values),
            "sanction_preset": rules.sanction_preset.value,
            "senshu_auto_loss": rules.senshu_auto_loss,
            "golden_point_seconds": rules.golden_point_seconds,
        },
        score=sb.score,
        sanction=sb.sanction,
        sanction_labels=list(rules.sanction_levels),
        sanction_c2=sb.sanction_c2 if rules.two_ladders else None,
        sanction_labels_c2=list(rules.levels_c2) if rules.two_ladders else None,
        infractions={k: {"label": label, "ladder": ladder} for k, (label, ladder) in INFRACTIONS.items()}
        if rules.two_ladders
        else None,
        senshu=sb.senshu,
        senshu_lost=sb.senshu_lost,
        golden_point=sb.golden_point,
        period_seconds=period_seconds(sb, rules),
        hantei_votes=_hantei_votes(db, m),
        elapsed_seconds=round(sb.elapsed_seconds, 1),
        duration_seconds=rules.duration_seconds,
        running=sb.running,
        started=sb.started,
        winner=sb.winner,
        method=sb.method,
        suggestion={"winner": d.winner, "method": d.method, "needs": d.needs, "reason": d.reason},
        # Qué sugeriría el marcador si el tiempo terminara ahora (la mesa puede
        # marcar «Tiempo cumplido» antes de que el reloj de la app llegue a cero).
        suggestion_at_time_end={
            "winner": (e := suggest_decision(sb, rules, True)).winner,
            "method": e.method,
            "needs": e.needs,
            "reason": e.reason,
        },
        events=[s.EventOut.model_validate(e) for e in rows],
        annulled_event_ids=sb.annulled_event_ids,
        aka=parts.get(m.aka_registration_id) if m.aka_registration_id else None,
        ao=parts.get(m.ao_registration_id) if m.ao_registration_id else None,
        is_team_match=c.is_team and c.modality == "kumite" and m.parent_match_id is None,
        bout=bout,
    )


def _bout_info(db: Session, m: Match, parts: dict[int, s.ParticipantOut]) -> dict[str, Any]:
    """Combate individual de un enfrentamiento por equipos: en el marcador se
    muestra al integrante; el equipo pasa a ser el subtítulo."""
    from app.services import teams

    parent = get_match(db, m.parent_match_id)
    team_names = {rid: p.name for rid, p in parts.items()}
    for color, pid in (("aka", m.aka_person_id), ("ao", m.ao_person_id)):
        rid = getattr(m, f"{color}_registration_id")
        team = parts.get(rid)
        if team is not None and pid is not None:
            p = db.get(Person, pid)
            if p is not None:
                parts[rid] = team.model_copy(update={"name": f"{p.first_names} {p.last_names}", "dojo_name": team.name})
    d = teams.decision_for(db, parent)
    return {
        "parent_match_id": parent.id,
        "parent_code": parent.code,
        "bout_number": m.bout_number,
        "is_extra": m.kind == "bout_extra",
        "aka_team": team_names.get(m.aka_registration_id),
        "ao_team": team_names.get(m.ao_registration_id),
        "wins": d.wins,
        "team_winner": d.winner,
    }


def _hantei_votes(db: Session, m: Match) -> list[dict[str, Any]]:
    """Votos de los jueces en un hantei de kumite (registro opcional)."""
    c = get_category(db, m.category_id)
    if c.modality != "kumite":
        return []
    return [
        {"judge_number": v.judge_number, "color": v.color, "judge_person_id": v.judge_person_id}
        for v in db.scalars(select(JudgeVote).where(JudgeVote.match_id == m.id).order_by(JudgeVote.judge_number)).all()
    ]


def _require_two(m: Match) -> None:
    if m.aka_registration_id is None or m.ao_registration_id is None or m.status in ("pending", "bye", "void"):
        raise InvalidState("El combate no tiene dos participantes definidos", code="MATCH_NOT_READY")


def add_event(db: Session, user: User, mid: int, data: s.EventIn) -> tuple[s.ScoreboardOut, bool]:
    """Registra un evento. Idempotente: si el id ya existe, no hace nada."""
    existing = db.get(MatchEventRow, data.id)
    m = get_match(db, mid)
    if existing is not None:
        if existing.match_id != mid:
            raise InvalidState("Ese id de evento pertenece a otro combate", code="EVENT_ID_CONFLICT")
        return scoreboard(db, m), False
    _require_two(m)
    finished_before = m.status in ("finished", "needs_review")
    if finished_before:
        # Tocar un combate cerrado es una corrección: requiere motivo y queda auditada.
        apply_warnings(
            db,
            user,
            [{"code": "MATCH_FINISHED", "message": "El combate ya está cerrado; el evento corrige su marcador"}],
            data.override.reason if data.override else None,
            "match",
            lambda: m.id,
        )
    if data.type == "annul":
        target = db.get(MatchEventRow, data.target_id) if data.target_id else None
        if target is None or target.match_id != mid:
            raise InvalidState("El evento a anular no existe en este combate")
    if (
        data.type in ("point", "sanction", "hantei", "kiken", "shikkaku", "walkover", "senshu_cancel")
        and not data.color
    ):
        raise InvalidState("El evento requiere color (aka/ao)")
    if data.type == "sanction":
        c, t = _ctx(db, m)
        rules = effective_kumite_rules(c, t)
        ladder = rules.ladder_of(data.infraction, data.ladder)
        levels = rules.levels_c2 if ladder == "c2" else rules.sanction_levels
        if not data.value or not 1 <= int(data.value) <= len(levels):
            raise InvalidState(f"Nivel de sanción inválido (1..{len(levels)})")
        if data.infraction is not None and data.infraction not in INFRACTIONS:
            raise InvalidState(f"Tipo de falta desconocido: {data.infraction}", code="INVALID_INFRACTION")
    elif data.infraction or data.ladder:
        raise InvalidState("El tipo de falta solo aplica a sanciones")
    if data.type == "point":
        c, t = _ctx(db, m)
        if int(data.value or 0) not in effective_kumite_rules(c, t).point_values:
            raise InvalidState("Valor de punto inválido")
    if data.type == "golden_point":
        c, t = _ctx(db, m)
        rules = effective_kumite_rules(c, t)
        sb0 = compute_scoreboard(_domain_events(_events(db, mid)), rules, now=_naive_utc(data.at))
        ws = []
        if rules.tie_rule != TieRule.GOLDEN_POINT:
            ws.append({"code": "GOLDEN_POINT_RULE", "message": "La categoría no usa punto de oro para el empate"})
        if sb0.score["aka"] != sb0.score["ao"]:
            ws.append({"code": "GOLDEN_POINT_NOT_TIED", "message": "El marcador no está empatado"})
        if sb0.golden_point:
            raise InvalidState("El combate ya está en punto de oro", code="GOLDEN_POINT_STARTED")
        apply_warnings(db, user, ws, data.override.reason if data.override else None, "match", lambda: m.id)
    if data.votes is not None:
        if data.type != "hantei":
            raise InvalidState("Los votos de jueces solo aplican al hantei")
        _store_hantei_votes(db, m, data)
    db.add(
        MatchEventRow(
            id=data.id,
            match_id=mid,
            type=data.type,
            color=data.color,
            value=data.value,
            target_id=data.target_id,
            reason=data.reason,
            infraction=data.infraction if data.type == "sanction" else None,
            ladder=data.ladder if data.type == "sanction" else None,
            device_at=_naive_utc(data.at),
            user_id=user.id,
        )
    )
    if m.started_at is None:
        m.started_at = _naive_utc(data.at)
    if m.status == "ready":
        m.status = "in_progress"
        c = get_category(db, m.category_id)
        if c.status == "ready":
            c.status = "in_progress"
    try:
        db.flush()
    except IntegrityError:
        # Dos reintentos del mismo evento llegaron a la vez: el otro ya lo
        # guardó. Idempotencia también bajo concurrencia.
        db.rollback()
        m = get_match(db, mid)
        return scoreboard(db, m), False
    sb = scoreboard(db, m)
    before = {"aka_score": m.aka_score, "ao_score": m.ao_score}
    m.aka_score, m.ao_score = sb.score["aka"], sb.score["ao"]
    if finished_before:
        c = get_category(db, m.category_id)
        if m.parent_match_id:  # los puntos del combate cuentan para el enfrentamiento
            from app.services import teams

            teams.settle(db, user, get_match(db, m.parent_match_id), _naive_utc(data.at), data.override.reason)
        sync(db, c)  # round robin usa los marcadores para la clasificación
        audit(
            db,
            user,
            "match",
            m.id,
            "correct_score",
            before,
            {"aka_score": m.aka_score, "ao_score": m.ao_score, "event": data.type},
            reason=data.override.reason if data.override else data.reason,
            tournament_id=c.tournament_id,
        )
    db.commit()
    return sb, True


def _store_hantei_votes(db: Session, m: Match, data: s.EventIn) -> None:
    """Hantei con votos (opcional): se guardan como JudgeVote. El color del
    hantei debe ser el de la mayoría de los votos emitidos."""
    votes = list(data.votes or [])
    if len(votes) not in (3, 5):
        raise InvalidState("El hantei se registra con 3 o 5 jueces", code="HANTEI_VOTES")
    counted = [v for v in votes if v]
    aka, ao = counted.count("aka"), counted.count("ao")
    if aka != ao and data.color != ("aka" if aka > ao else "ao"):
        raise InvalidState("El color del hantei no coincide con la mayoría de los votos", code="HANTEI_VOTES")
    db.execute(delete(JudgeVote).where(JudgeVote.match_id == m.id))
    ids = data.judge_person_ids or []
    for i, v in enumerate(votes):
        db.add(JudgeVote(match_id=m.id, judge_number=i + 1, color=v, judge_person_id=ids[i] if i < len(ids) else None))


def finish(db: Session, user: User, mid: int, data: s.FinishIn) -> tuple[s.ScoreboardOut, list[str]]:
    """Cierra el combate con ganador. Corregir un ganador es volver a llamar
    con otro ganador: se agrega un nuevo evento ``finish`` y se informan los
    combates siguientes afectados.

    Un combate individual de kumite por equipos puede terminar en empate
    (``winner="draw"``); al cerrarlo se recalcula el enfrentamiento.
    """
    m = get_match(db, mid)
    existing = db.get(MatchEventRow, data.id)
    if existing is not None:
        if existing.match_id != mid:
            raise InvalidState("Ese id de evento pertenece a otro combate", code="EVENT_ID_CONFLICT")
        return scoreboard(db, m), []
    _require_two(m)
    c, t = _ctx(db, m)
    is_bout = m.parent_match_id is not None
    draw = data.winner == "draw"
    if draw and not is_bout:
        raise InvalidState("Solo un combate individual por equipos puede terminar en empate", code="DRAW_NOT_ALLOWED")
    if draw and m.kind == "bout_extra":
        from app.services import teams

        if teams.team_options(c, t)["extra_bout_tie"] == "hantei":
            raise InvalidState(
                "El combate extra no puede terminar empatado: decide por hantei", code="EXTRA_BOUT_NEEDS_HANTEI"
            )
    rules = effective_kumite_rules(c, t)
    rows = _events(db, m.id)
    sb = compute_scoreboard(_domain_events(rows), rules)
    method = "draw" if draw else data.method
    winner_id = None if draw else (m.aka_registration_id if data.winner == "aka" else m.ao_registration_id)
    ws: list[dict[str, str]] = []
    if c.modality == "kumite" and method not in ("walkover", "kiken", "shikkaku"):
        if draw:
            if sb.score["aka"] != sb.score["ao"]:
                ws.append({"code": "SCORE_MISMATCH", "message": "El marcador no está empatado"})
        elif method in ("hantei", "decision"):
            # Una decisión de jueces no puede contradecir al marcador: si hay
            # ganador por puntos, hansoku o un hantei registrado, se advierte.
            ws += [{"code": "SCORE_MISMATCH", "message": w} for w in finish_warnings(sb, rules, data.winner, True)]
        else:
            ws += [
                {"code": "SCORE_MISMATCH", "message": w}
                for w in finish_warnings(sb, rules, data.winner, data.time_over)
            ]
    affected: list[str] = []
    if is_bout:
        from app.services import teams

        if m.status in ("finished", "needs_review") and (m.winner_registration_id, m.method) != (winner_id, method):
            ws.append({"code": "WINNER_CHANGE", "message": "Cambia el resultado de un combate cerrado"})
        team_ws, affected = teams.bout_change_warnings(db, m, None if draw else data.winner, sb.score)
        ws += team_ws
    elif m.winner_registration_id is not None and m.winner_registration_id != winner_id:
        affected = _affected_by(db, c, m)
        ws.append(
            {
                "code": "WINNER_CHANGE",
                "message": "Cambia el ganador de un combate cerrado"
                + (f"; afecta a: {', '.join(affected)}" if affected else ""),
            }
        )
    if c.status == "finished" or t.status == "finished":
        ws.append({"code": "CATEGORY_FINISHED", "message": "La categoría o el torneo ya estaban finalizados"})
    apply_warnings(db, user, ws, data.override.reason if data.override else None, "match", lambda: m.id)

    reason = data.reason or (data.override.reason if data.override else None)
    record_finish(db, user, m, c, None if draw else data.winner, method, _naive_utc(data.at), data.id, reason, sb.score)
    if is_bout:
        teams.settle(db, user, get_match(db, m.parent_match_id), _naive_utc(data.at), reason)
        sync(db, c)
    auto_walkovers(db, user, c)
    db.commit()
    return scoreboard(db, m), affected


def auto_walkovers(db: Session, user: User, c: Category) -> list[str]:
    """Walkover automático cuando un combate listo (sin eventos) tiene de un
    lado a alguien que ya no compite en la categoría (quitado de la llave,
    retirado, descalificado o movido a otra categoría). No hace commit."""
    done: list[str] = []
    for _ in range(64):  # cada walkover puede dejar listo el siguiente combate
        rows = [m for m in current_matches(db, c.id) if m.status == "ready"]
        ids = [x for m in rows for x in (m.aka_registration_id, m.ao_registration_id) if x]
        gone = _withdrawn_ids(db, c, ids)
        target: tuple[Match, str] | None = None
        for m in rows:
            if (m.aka_registration_id in gone) == (m.ao_registration_id in gone):
                continue
            if db.scalar(select(func.count()).select_from(MatchEventRow).where(MatchEventRow.match_id == m.id)):
                continue
            target = (m, "ao" if m.aka_registration_id in gone else "aka")
            break
        if target is None:
            break
        m, color = target
        reason = "Walkover automático: el rival ya no compite en la categoría"
        record_finish(db, user, m, c, color, "walkover", utcnow(), str(uuid.uuid4()), reason, None)
        done.append(m.code)
    return done


def _affected_by(db: Session, c: Category, m: Match) -> list[str]:
    """Combates siguientes ya iniciados que dependen del resultado de ``m``."""
    rows = current_matches(db, c.id)
    codes = bd.dependents([_spec(x) for x in rows], m.code)
    by_code = {x.code: x for x in rows}
    return [code for code in codes if by_code.get(code) and by_code[code].status in ("in_progress", "finished")]


def record_finish(
    db: Session,
    user: User,
    m: Match,
    c: Category,
    color: str | None,
    method: str,
    at,
    event_id: str,
    reason: str | None,
    score: dict[str, int] | None,
) -> None:
    """Escribe el cierre (evento ``finish``, ganador, auditoría) y resincroniza
    la llave. No valida ni hace commit: eso le toca a quien llama."""
    db.add(
        MatchEventRow(
            id=event_id,
            match_id=m.id,
            type="finish",
            color=color,
            method=method,
            reason=reason,
            device_at=at,
            user_id=user.id,
        )
    )
    winner_id = None if color is None else (m.aka_registration_id if color == "aka" else m.ao_registration_id)
    before = {"winner": m.winner_registration_id, "method": m.method}
    was_finished = m.status in ("finished", "needs_review")
    m.winner_registration_id = winner_id
    m.method = method
    if score is not None:
        m.aka_score, m.ao_score = score["aka"], score["ao"]
    m.finished_at = at
    if m.started_at is None:
        m.started_at = m.finished_at
    m.status = "finished"
    bump(m, user)
    db.flush()
    _close_reopen(db, user, c)
    sync(db, c)
    audit(
        db,
        user,
        "match",
        m.id,
        "correct_winner" if was_finished else "finish",
        before,
        {"winner": winner_id, "method": method},
        reason=reason,
        tournament_id=c.tournament_id,
    )


# ---------------------------------------------------------------------------
# Kata
# ---------------------------------------------------------------------------


def record_flags(db: Session, user: User, mid: int, data: s.FlagsIn) -> dict[str, Any]:
    m = get_match(db, mid)
    c, t = _ctx(db, m)
    if c.modality != "kata":
        raise InvalidState("Las banderas solo aplican a kata")
    cfg = effective_kata(c, t)
    if cfg["method"] == "flags":
        judges = int(cfg["judges"])
    else:
        # La categoría se decide por puntuación: usar banderas es una excepción
        # que el organizador acepta explícitamente (antes pasaba sin aviso).
        apply_warnings(
            db,
            user,
            [
                {
                    "code": "KATA_METHOD_MISMATCH",
                    "message": "La categoría se decide por puntuación; registrar banderas es una excepción",
                }
            ],
            data.override.reason if data.override else None,
            "match",
            lambda: m.id,
        )
        judges = len(data.votes) if len(data.votes) in (3, 5) else int(cfg.get("flags_judges") or 3)
    result = decide_flags(list(data.votes), judges, data.head_judge_vote)
    if result.winner is None:
        return {"winner": None, "needs_head_judge": True, "aka_votes": result.aka_votes, "ao_votes": result.ao_votes}
    db.execute(delete(JudgeVote).where(JudgeVote.match_id == mid))
    ids = data.judge_person_ids or []
    for i, vote in enumerate(data.votes):
        db.add(
            JudgeVote(match_id=mid, judge_number=i + 1, color=vote, judge_person_id=ids[i] if i < len(ids) else None)
        )
    sb, affected = finish(
        db,
        user,
        mid,
        s.FinishIn(
            id=data.event_id, at=data.at, winner=result.winner, method="flags", time_over=True, override=data.override
        ),
    )
    return {
        "winner": result.winner,
        "aka_votes": result.aka_votes,
        "ao_votes": result.ao_votes,
        "needs_head_judge": False,
        "affected": affected,
    }


def _current_kata_round(db: Session, cid: int) -> int:
    return db.scalar(select(func.max(KataPerformance.round_number)).where(KataPerformance.category_id == cid)) or 1


def _repeat_warnings(
    db: Session, cfg: dict[str, Any], c: Category, rid: int, kata_name: str | None, exclude_id: int | None
) -> list[dict[str, str]]:
    """Regla «no repetir kata» (opcional): advierte si la inscripción ya
    ejecutó ese kata en otra ronda o combate de la categoría."""
    if not cfg.get("no_repeat_kata") or not kata_name:
        return []
    name = kata_name.strip().lower()
    prev = db.scalars(
        select(KataPerformance).where(
            KataPerformance.category_id == c.id,
            KataPerformance.registration_id == rid,
            KataPerformance.id != (exclude_id or 0),
            KataPerformance.kata_name.is_not(None),
        )
    ).all()
    if any((p.kata_name or "").strip().lower() == name for p in prev):
        return [{"code": "KATA_REPEATED", "message": f"Ya ejecutó {kata_name} en esta categoría"}]
    return []


def record_kata_score(db: Session, user: User, cid: int, data: s.KataScoreIn) -> s.BracketOut:
    c = get_category(db, cid)
    t = get_tournament(db, c.tournament_id)
    round_number = data.round_number or _current_kata_round(db, cid)
    perf = db.scalar(
        select(KataPerformance).where(
            KataPerformance.category_id == cid,
            KataPerformance.registration_id == data.registration_id,
            KataPerformance.round_number == round_number,
            KataPerformance.match_id.is_(None),
        )
    )
    if perf is None:
        raise NotFound("El participante no está en la ronda de kata")
    check_version(perf, data.version, "La ejecución de kata")
    cfg = effective_kata(c, t)
    rules = _scoring_rules(cfg)
    result = score_performance(data.scores, rules, data.athletic_scores)  # valida (KataError = 400)
    kata_name = data.kata_name if data.kata_name is not None else perf.kata_name
    ws = _repeat_warnings(db, cfg, c, perf.registration_id, kata_name, perf.id)
    apply_warnings(db, user, ws, data.override.reason if data.override else None, "kata_performance", lambda: perf.id)
    before = {"scores": perf.scores, "total": float(perf.total) if perf.total is not None else None}
    perf.scores = [float(x) for x in data.scores]
    perf.athletic_scores = [float(x) for x in data.athletic_scores] if data.athletic_scores else None
    perf.total = float(result.total)
    perf.judge_person_ids = data.judge_person_ids
    if data.kata_name is not None:
        perf.kata_name = data.kata_name
    bump(perf, user)
    if c.status == "ready":
        c.status = "in_progress"
    db.flush()
    _close_reopen(db, user, c)
    sync(db, c)
    audit(
        db,
        user,
        "kata_performance",
        perf.id,
        "correct_scores" if before["scores"] else "score",
        before,
        {"scores": perf.scores, "total": perf.total},
        tournament_id=t.id,
    )
    db.commit()
    return bracket_out(db, cid)


def resolve_kata_tie(db: Session, user: User, cid: int, data: s.TieBreakIn) -> s.BracketOut:
    c = get_category(db, cid)
    round_number = data.round_number or _current_kata_round(db, cid)
    perfs = {
        p.registration_id: p
        for p in db.scalars(
            select(KataPerformance).where(
                KataPerformance.category_id == cid,
                KataPerformance.round_number == round_number,
                KataPerformance.match_id.is_(None),
            )
        ).all()
    }
    for i, rid in enumerate(data.registration_ids_in_order):
        if rid not in perfs:
            raise InvalidState(f"Inscripción {rid} no está en la ronda")
        perfs[rid].tie_break_place = i + 1
    db.flush()
    _close_reopen(db, user, c)
    sync(db, c)
    audit(
        db,
        user,
        "category",
        cid,
        "kata_tie_break",
        after={"order": data.registration_ids_in_order},
        reason=data.reason,
        tournament_id=c.tournament_id,
    )
    db.commit()
    return bracket_out(db, cid)


def set_kata_order(db: Session, user: User, cid: int, data: s.KataOrderIn) -> s.BracketOut:
    """Orden de salida de una ronda de kata (lista completa de inscripciones).
    Quien ya ejecutó conserva su nota; se advierte si alguien ya tiene nota."""
    c = get_category(db, cid)
    round_number = data.round_number or _current_kata_round(db, cid)
    perfs = {
        p.registration_id: p
        for p in db.scalars(
            select(KataPerformance).where(
                KataPerformance.category_id == cid,
                KataPerformance.round_number == round_number,
                KataPerformance.match_id.is_(None),
            )
        ).all()
    }
    if not perfs:
        raise NotFound("La categoría no tiene ronda de kata")
    if sorted(data.registration_ids) != sorted(perfs):
        raise InvalidState("El orden debe incluir exactamente a todos los de la ronda", code="KATA_ORDER_MISMATCH")
    before = {rid: p.order for rid, p in perfs.items()}
    for i, rid in enumerate(data.registration_ids):
        if perfs[rid].order != i + 1:
            perfs[rid].order = i + 1
            bump(perfs[rid], user)
    audit(
        db,
        user,
        "category",
        cid,
        "kata_order",
        {"round": round_number, "order": sorted(before, key=lambda r: before[r])},
        {"round": round_number, "order": data.registration_ids},
        reason=data.reason or None,
        tournament_id=c.tournament_id,
    )
    db.commit()
    return bracket_out(db, cid)


def record_kata_match_scores(db: Session, user: User, mid: int, data: s.KataMatchScoreIn) -> dict[str, Any]:
    """Kata por puntuación en llave: aka y ao reciben la nota del panel y gana
    la mayor, con los desempates de la puntuación (nota mínima y máxima
    descartadas; o técnica y atlética). Si siguen empatados decide el juez
    principal (``head_judge_vote``)."""
    m = get_match(db, mid)
    c, t = _ctx(db, m)
    if c.modality != "kata":
        raise InvalidState("Las notas de kata solo aplican a kata")
    _require_two(m)
    cfg = effective_kata(c, t)
    ws: list[dict[str, str]] = []
    if cfg["method"] != "scores":
        ws.append(
            {
                "code": "KATA_METHOD_MISMATCH",
                "message": "La categoría se decide por banderas; usar notas es una excepción",
            }
        )
    rules = _scoring_rules(cfg)
    aka = score_performance(data.aka_scores, rules, data.aka_athletic)  # valida (KataError = 400)
    ao = score_performance(data.ao_scores, rules, data.ao_athletic)
    existing = {
        p.registration_id: p for p in db.scalars(select(KataPerformance).where(KataPerformance.match_id == m.id)).all()
    }
    for rid, name in ((m.aka_registration_id, data.aka_kata_name), (m.ao_registration_id, data.ao_kata_name)):
        prev = existing.get(rid)
        ws += _repeat_warnings(db, cfg, c, rid, name, prev.id if prev else None)
    winner = decide_kata_match(aka, ao, data.head_judge_vote)
    out = {"aka_total": float(aka.total), "ao_total": float(ao.total)}
    if winner is None:
        return {**out, "winner": None, "needs_head_judge": True}
    apply_warnings(db, user, ws, data.override.reason if data.override else None, "match", lambda: m.id)
    for rid, scores, athletic, name in (
        (m.aka_registration_id, data.aka_scores, data.aka_athletic, data.aka_kata_name),
        (m.ao_registration_id, data.ao_scores, data.ao_athletic, data.ao_kata_name),
    ):
        perf = existing.get(rid) or KataPerformance(
            category_id=c.id, match_id=m.id, registration_id=rid, round_number=m.round
        )
        result = aka if rid == m.aka_registration_id else ao
        perf.scores = [float(x) for x in scores]
        perf.athletic_scores = [float(x) for x in athletic] if athletic else None
        perf.total = float(result.total)
        perf.judge_person_ids = data.judge_person_ids
        if name is not None:
            perf.kata_name = name
        if perf.id is None:
            db.add(perf)
        else:
            bump(perf, user)
    sb, affected = finish(
        db,
        user,
        mid,
        s.FinishIn(
            id=data.event_id, at=data.at, winner=winner, method="scores", time_over=True, override=data.override
        ),
    )
    return {**out, "winner": winner, "needs_head_judge": False, "affected": affected}


# ---------------------------------------------------------------------------
# Tatamis
# ---------------------------------------------------------------------------


def _queue_key(m: Match, final_round: int) -> tuple:
    if m.kind == "main" and m.round == final_round:
        return (final_round + 2, m.position)
    if m.kind != "main":
        return (final_round + 1, m.round, m.position)
    return (m.round, m.position)


def tatami_schedule(db: Session, tatami_id: int) -> dict[str, Any]:
    """Orden completo de combates del tatami con número estable (T1-001…).

    Incluye combates futuros (aún sin participantes) para que la planilla en
    papel y la app usen la misma numeración. Excluye byes y combates anulados.
    """
    tat = db.get(Tatami, tatami_id)
    if tat is None:
        raise NotFound("Tatami no encontrado")
    cats = db.scalars(
        select(Category)
        .where(Category.tatami_id == tatami_id, Category.status.in_(("ready", "in_progress", "finished")))
        .order_by(Category.queue_position, Category.id)
    ).all()
    items: list[dict[str, Any]] = []
    for c in cats:
        rows = current_matches(db, c.id)
        main = [m for m in rows if m.kind == "main"]
        if not main:
            continue
        final_round = max(m.round for m in main)
        for m in sorted(rows, key=lambda x: _queue_key(x, final_round)):
            if m.status in ("bye", "void"):
                continue
            items.append(
                {
                    "number": f"T{tat.number}-{len(items) + 1:03d}",
                    "category_id": c.id,
                    "category_name": c.name,
                    "match": s.MatchOut.model_validate(m),
                }
            )
    return {"tatami": tat, "items": items}


def tatami_queue(db: Session, tatami_id: int) -> dict[str, Any]:
    sched = tatami_schedule(db, tatami_id)
    tat = sched["tatami"]
    queue = [it for it in sched["items"] if it["match"].status in ("ready", "in_progress", "needs_review")]
    ids = {x for q in queue for x in (q["match"].aka_registration_id, q["match"].ao_registration_id) if x}
    parts = participants(db, ids)
    # Advertencia: el mismo competidor con combates pendientes en dos tatamis.
    conflicts = []
    person_of = {r.id: r.person_id for r in db.scalars(select(Registration).where(Registration.id.in_(ids))).all()}
    others = db.scalars(
        select(Match)
        .join(Category, Category.id == Match.category_id)
        .where(
            Match.is_current,
            Match.status.in_(("ready", "in_progress")),
            Category.tatami_id.is_not(None),
            Category.tatami_id != tatami_id,
            Category.tournament_id == tat.tournament_id,
        )
    ).all()
    other_people = set()
    for om in others:
        for rid in (om.aka_registration_id, om.ao_registration_id):
            if rid:
                r = db.get(Registration, rid)
                if r and r.person_id:
                    other_people.add(r.person_id)
    for rid, pid in person_of.items():
        if pid and pid in other_people:
            conflicts.append({"registration_id": rid, "name": parts[rid].name if rid in parts else ""})
    current = next((q for q in queue if q["match"].status == "in_progress"), None)
    from app.services import operation, referees

    return {
        "tatami": {"id": tat.id, "name": tat.name, "number": tat.number},
        "current": current,
        "queue": queue,
        "participants": {k: v.model_dump() for k, v in parts.items()},
        "conflicts": conflicts,
        # Vista de varios tatamis: avance, quién opera ahora, operadores y árbitros asignados.
        "progress": {
            "done": sum(1 for it in sched["items"] if it["match"].status == "finished"),
            "total": len(sched["items"]),
        },
        "operators": operation.tatami_operators(db, tat.id),
        "assigned_operators": operation.assigned_operators(db, tat.id),
        "referees": referees.for_tatami(db, tat.id),
    }
