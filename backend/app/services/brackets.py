"""Llaves, combates y mesa (secciones 16–19).

La lógica deportiva vive en ``app.domain``; aquí solo se orquesta: se leen
filas, se llama al dominio y se guarda lo que el dominio decidió.
"""

from __future__ import annotations

import random
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
from app.domain.kata import ScoringRules, decide_flags, kata_round_medals, rank_performances, score_performance
from app.domain.kumite import EventType, MatchEvent, compute_scoreboard, finish_warnings, suggest_decision
from app.services.audit import apply_warnings, audit, bump, check_version
from app.services.tournaments import (
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
    stmt = select(Match).where(Match.category_id == cid, Match.is_current.is_(True))
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
        .where(Match.category_id == cid, Match.is_current.is_(True), Match.status.in_(("in_progress", "finished")))
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
            "Hay combates iniciados: la llave ya no se puede regenerar; edítala manualmente",
            code="BRACKET_STARTED",
        )
    regs = _active_regs(db, cid)
    if not regs:
        raise InvalidState("La categoría no tiene inscritos")
    fmt = data.format or effective_format(c, t)
    if c.modality == "kata" and effective_kata(c, t)["structure"] == "rounds":
        fmt = "kata_rounds"
    rule = bd.ThirdPlaceRule(data.third_place_rule) if data.third_place_rule else effective_third_place(c, t)

    warnings: list[dict[str, str]] = []
    if fmt == "round_robin" and len(regs) > 6:
        warnings.append(
            {"code": "ROUND_ROBIN_LARGE", "message": f"Round robin con {len(regs)} inscritos: muchos combates"}
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

    seed = data.seed if data.seed is not None else random.SystemRandom().randrange(1, 2**31)
    number = (
        db.scalar(select(func.max(BracketVersion.number)).where(BracketVersion.bracket_id == bracket.id)) or 0
    ) + 1

    if fmt == "kata_rounds":
        rng = random.Random(seed)
        order = regs[:]
        rng.shuffle(order)
        v = BracketVersion(
            bracket_id=bracket.id,
            number=number,
            format=fmt,
            third_place_rule=rule.value,
            seed=seed,
            size=len(order),
            slots=[r.id for r in order],
            reason=data.reason,
            created_by_id=user.id,
        )
        db.add(v)
        db.flush()
        db.execute(delete(KataPerformance).where(KataPerformance.category_id == cid))
        for i, r in enumerate(order):
            db.add(KataPerformance(category_id=cid, registration_id=r.id, order=i + 1, round_number=1))
        specs: list[bd.MatchSpec] = []
    elif fmt == "round_robin":
        rng = random.Random(seed)
        order = regs[:]
        rng.shuffle(order)
        slots = [r.id for r in order]
        specs = bd.round_robin_schedule([str(x) for x in slots])
        v = BracketVersion(
            bracket_id=bracket.id,
            number=number,
            format=fmt,
            third_place_rule=rule.value,
            seed=seed,
            size=len(slots),
            slots=slots,
            reason=data.reason,
            created_by_id=user.id,
        )
    else:
        entrants = [bd.Entrant(str(r.id), str(r.dojo_id), r.seed) for r in regs]
        gen = bd.generate_single_elimination(entrants, seed=seed, third_place_rule=rule)
        specs = list(gen.matches)
        v = BracketVersion(
            bracket_id=bracket.id,
            number=number,
            format="single_elimination",
            third_place_rule=rule.value,
            seed=gen.seed,
            size=gen.size,
            slots=[_to_int(x) for x in gen.slots],
            same_dojo_first_round=gen.same_dojo_first_round,
            reason=data.reason,
            created_by_id=user.id,
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
    if cur.format != "single_elimination":
        raise InvalidState("Solo se editan posiciones en eliminación directa")
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

    slots = tuple(str(x) if x is not None else None for x in v.slots)
    specs = [_spec(m) for m in rows if m.kind != bd.MatchKind.REPECHAGE]
    res = bd.resolve(slots, specs, winners, bd.ThirdPlaceRule(v.third_place_rule))
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
    slots = v.slots
    results = []
    for m in rows:
        a, b = slots[int(m.aka_source.split(":")[1])], slots[int(m.ao_source.split(":")[1])]
        m.aka_registration_id, m.ao_registration_id = a, b
        _update_status(db, m, True, False, str(m.winner_registration_id) if m.winner_registration_id else None)
        if m.status == "finished":
            results.append(
                bd.RRResult(str(a), str(b), str(m.winner_registration_id), m.aka_score or 0, m.ao_score or 0)
            )
    complete = all(m.status == "finished" for m in rows)
    standings = bd.round_robin_standings([str(x) for x in slots], results)
    places: list[tuple[int, str]] = []
    if complete:
        top = [st for st in standings if st.rank <= 3]
        if not any(st.tied for st in top):
            places = [(st.rank, st.entrant) for st in top]
        else:
            complete = False  # empate sin resolver: el organizador decide
    _store_results(db, c, places, complete)
    return {"standings": standings}


def _sync_kata_rounds(db: Session, c: Category, v: BracketVersion) -> dict[str, Any]:
    t = get_tournament(db, c.tournament_id)
    cfg = effective_kata(c, t)
    rules = _scoring_rules(cfg)
    perfs = list(db.scalars(select(KataPerformance).where(KataPerformance.category_id == c.id)).all())
    scored = {str(p.registration_id): score_performance(p.scores, rules) for p in perfs if p.scores}
    ranked = rank_performances(scored)
    # Desempate manual (nueva ejecución o juez principal) registrado por el organizador.
    manual = {str(p.registration_id): p.tie_break_place for p in perfs if p.tie_break_place}
    if manual:
        ranked.sort(key=lambda r: (r.rank, manual.get(r.entrant, 10**6)))
        for i, r in enumerate(ranked):
            if r.unresolved_tie and r.entrant in manual:
                r.unresolved_tie = False
                r.rank = i + 1
    complete = len(scored) == len(perfs) and perfs
    bronzes = 1 if v.third_place_rule == "third_place_match" else 2
    medals = kata_round_medals(ranked, bronzes=bronzes)
    places = [(place, e) for place, es in medals.items() for e in es]
    expected = min(len(perfs), 2 + bronzes)
    ok = bool(complete) and len(places) >= expected
    _store_results(db, c, places if ok else [], complete=ok)
    return {"ranking": ranked}


def _scoring_rules(cfg: dict[str, Any]) -> ScoringRules:
    return ScoringRules(
        judges=int(cfg["judges"]),
        min_score=Decimal(str(cfg["min_score"])),
        max_score=Decimal(str(cfg["max_score"])),
        discard_each_side=cfg.get("discard_each_side"),
    )


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
        perfs = {
            p.registration_id: p
            for p in db.scalars(select(KataPerformance).where(KataPerformance.category_id == cid)).all()
        }
        ranked = {int(r.entrant): r for r in info["ranking"]}
        standings = [
            {
                "registration_id": rid,
                "order": p.order,
                "kata_name": p.kata_name,
                "scores": p.scores,
                "judge_person_ids": p.judge_person_ids,
                "total": float(ranked[rid].result.total) if rid in ranked else None,
                "rank": ranked[rid].rank if rid in ranked else None,
                "tied": ranked[rid].unresolved_tie if rid in ranked else False,
                "version": p.version,
            }
            for rid, p in sorted(perfs.items(), key=lambda kv: kv[1].order)
        ]
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
    )


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
    time_over = sb.elapsed_seconds >= rules.duration_seconds
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
        },
        score=sb.score,
        sanction=sb.sanction,
        sanction_labels=list(rules.sanction_levels),
        senshu=sb.senshu,
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
        levels = effective_kumite_rules(c, t).sanction_levels
        if not data.value or not 1 <= int(data.value) <= len(levels):
            raise InvalidState(f"Nivel de sanción inválido (1..{len(levels)})")
    if data.type == "point":
        c, t = _ctx(db, m)
        if int(data.value or 0) not in effective_kumite_rules(c, t).point_values:
            raise InvalidState("Valor de punto inválido")
    db.add(
        MatchEventRow(
            id=data.id,
            match_id=mid,
            type=data.type,
            color=data.color,
            value=data.value,
            target_id=data.target_id,
            reason=data.reason,
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
    rules = effective_kumite_rules(c, t)
    rows = _events(db, m.id)
    sb = compute_scoreboard(_domain_events(rows), rules)
    method = "draw" if draw else data.method
    winner_id = None if draw else (m.aka_registration_id if data.winner == "aka" else m.ao_registration_id)
    ws: list[dict[str, str]] = []
    if c.modality == "kumite" and method not in ("walkover", "kiken", "shikkaku", "hantei", "decision"):
        if draw:
            if sb.score["aka"] != sb.score["ao"]:
                ws.append({"code": "SCORE_MISMATCH", "message": "El marcador no está empatado"})
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
    db.commit()
    return scoreboard(db, m), affected


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
    judges = int(cfg["judges"]) if cfg["method"] == "flags" else 3
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


def record_kata_score(db: Session, user: User, cid: int, data: s.KataScoreIn) -> s.BracketOut:
    c = get_category(db, cid)
    t = get_tournament(db, c.tournament_id)
    perf = db.scalar(
        select(KataPerformance).where(
            KataPerformance.category_id == cid, KataPerformance.registration_id == data.registration_id
        )
    )
    if perf is None:
        raise NotFound("El participante no está en la ronda de kata")
    check_version(perf, data.version, "La ejecución de kata")
    rules = _scoring_rules(effective_kata(c, t))
    result = score_performance(data.scores, rules)  # valida
    before = {"scores": perf.scores, "total": float(perf.total) if perf.total is not None else None}
    perf.scores = [float(x) for x in data.scores]
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
    perfs = {
        p.registration_id: p
        for p in db.scalars(select(KataPerformance).where(KataPerformance.category_id == cid)).all()
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
            Match.is_current.is_(True),
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
