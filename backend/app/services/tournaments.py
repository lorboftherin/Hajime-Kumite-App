from __future__ import annotations

from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api import schemas as s
from app.api.errors import Forbidden, InvalidState, NotFound
from app.db.base import utcnow
from app.db.models import (
    Category,
    CategoryMerge,
    CategorySplit,
    CategoryTemplate,
    Match,
    Registration,
    Tatami,
    TemplateCategory,
    Tournament,
    User,
)
from app.domain.brackets import DEFAULT_RR_CRITERIA, RR_CRITERIA, ThirdPlaceRule
from app.domain.categories import (
    AGE_MODES,
    can_transition,
    competition_age,
    few_entrants_advice,
    is_reopen,
    parse_weight_range,
)
from app.domain.kumite import KumiteRules, SanctionPreset, TieRule, TimeMode
from app.services.audit import apply_warnings, audit, bump, check_version, snapshot

CATEGORY_FIELDS = list(s.CategoryFields.model_fields)


def get_tournament(db: Session, tid: int) -> Tournament:
    t = db.get(Tournament, tid)
    if t is None:
        raise NotFound("Torneo no encontrado")
    return t


def get_category(db: Session, cid: int) -> Category:
    c = db.get(Category, cid)
    if c is None:
        raise NotFound("Categoría no encontrada")
    return c


# ---------------------------------------------------------------------------
# Plantillas
# ---------------------------------------------------------------------------


def create_template(db: Session, user: User, data: s.TemplateCreate) -> CategoryTemplate:
    t = CategoryTemplate(name=data.name, description=data.description, updated_by_id=user.id)
    db.add(t)
    db.flush()
    for i, item in enumerate(data.items):
        fields = item.model_dump()
        fields["sort_order"] = fields.get("sort_order") or i
        db.add(TemplateCategory(template_id=t.id, **fields))
    audit(db, user, "template", t.id, "create", after={"name": t.name, "items": len(data.items)})
    db.commit()
    db.refresh(t)
    return t


# ---------------------------------------------------------------------------
# Torneos
# ---------------------------------------------------------------------------


def _validate_tournament_rules(fields: dict[str, Any]) -> None:
    validate_kumite_rules(fields.get("kumite_rules"))
    validate_kata_rules(fields.get("kata_defaults"))
    validate_competition_rules(fields.get("competition_rules"))
    if fields.get("age_mode") is not None:
        _check(fields["age_mode"] in AGE_MODES, "Modo de edad: date o birth_year")


def create_tournament(db: Session, user: User, data: s.TournamentCreate) -> Tournament:
    fields = data.model_dump(exclude={"tatami_count"})
    _validate_tournament_rules(fields)
    fields["age_reference_date"] = data.age_reference_date or data.start_date
    t = Tournament(**fields, updated_by_id=user.id)
    db.add(t)
    db.flush()
    for i in range(data.tatami_count):
        db.add(Tatami(tournament_id=t.id, number=i + 1, name=f"Tatami {i + 1}"))
    audit(db, user, "tournament", t.id, "create", after=snapshot(t), tournament_id=t.id)
    if data.template_id:
        _copy_template(db, t, data.template_id)
    db.commit()
    db.refresh(t)
    return t


def update_tournament(db: Session, user: User, tid: int, data: s.TournamentUpdate) -> Tournament:
    t = get_tournament(db, tid)
    check_version(t, data.version, "El torneo")
    before = snapshot(t)
    changes = data.model_dump(exclude_unset=True, exclude={"version"})
    _validate_tournament_rules(changes)
    if "is_test" in changes and changes["is_test"] != t.is_test and not user.is_admin:
        # Cambiar la marca altera el historial y las estadísticas (sección 12).
        raise Forbidden("Solo el Admin Global puede cambiar la marca de torneo de prueba")
    for k, v in changes.items():
        setattr(t, k, v)
    if ("age_reference_date" in changes and before.get("age_reference_date") != t.age_reference_date.isoformat()) or (
        "age_mode" in changes and before.get("age_mode") != t.age_mode
    ):
        _recompute_ages(db, t)
    bump(t, user)
    audit(db, user, "tournament", t.id, "update", before, snapshot(t), tournament_id=t.id)
    db.commit()
    db.refresh(t)
    return t


def _recompute_ages(db: Session, t: Tournament) -> None:
    """La edad de cada inscripción se calcula a la fecha de referencia, según
    el modo de edad del torneo (sección 13)."""
    for r in db.scalars(select(Registration).where(Registration.tournament_id == t.id)).all():
        if r.person and r.person.birth_date:
            r.age_at_reference = competition_age(r.person.birth_date, t.age_reference_date, t.age_mode or "date")


def change_status(db: Session, user: User, tid: int, data: s.StatusChange) -> Tournament:
    t = get_tournament(db, tid)
    check_version(t, data.version, "El torneo")
    if not can_transition(t.status, data.status):
        raise InvalidState(f"No se puede pasar de {t.status} a {data.status}")
    reopen = is_reopen(t.status, data.status)
    if reopen:
        if not user.is_admin:
            raise Forbidden("Solo el Admin Global puede reabrir un torneo")
        if not data.reason:
            raise InvalidState("Reabrir requiere un motivo", code="REASON_REQUIRED")
    before = t.status
    t.status = data.status
    if data.status in ("registration_closed", "in_progress"):
        for c in db.scalars(select(Category).where(Category.tournament_id == t.id)).all():
            refresh_category_status(db, c)
    bump(t, user)
    audit(
        db,
        user,
        "tournament",
        t.id,
        "reopen" if reopen else "status",
        {"status": before},
        {"status": t.status},
        reason=data.reason,
        tournament_id=t.id,
    )
    db.commit()
    db.refresh(t)
    return t


def add_tatami(db: Session, user: User, tid: int, data: s.TatamiIn) -> Tatami:
    t = get_tournament(db, tid)
    n = max((x.number for x in t.tatamis), default=0) + 1
    tt = Tatami(tournament_id=t.id, number=n, name=data.name or f"Tatami {n}")
    db.add(tt)
    audit(db, user, "tournament", t.id, "add_tatami", after={"name": tt.name}, tournament_id=t.id)
    db.commit()
    return tt


# ---------------------------------------------------------------------------
# Categorías
# ---------------------------------------------------------------------------


def _copy_template(db: Session, t: Tournament, template_id: int) -> int:
    tpl = db.get(CategoryTemplate, template_id)
    if tpl is None:
        raise NotFound("Plantilla no encontrada")
    existing = set(db.scalars(select(Category.code).where(Category.tournament_id == t.id)).all())
    n = 0
    for item in tpl.items:
        if item.code in existing:
            continue
        db.add(Category(tournament_id=t.id, status="empty", **{f: getattr(item, f) for f in CATEGORY_FIELDS}))
        n += 1
    t.template_id = template_id
    return n


def generate_categories(db: Session, user: User, tid: int, template_id: int | None) -> int:
    """Copia la plantilla al torneo. Cambiar la plantilla después no afecta al torneo."""
    t = get_tournament(db, tid)
    tpl_id = template_id or t.template_id
    if not tpl_id:
        raise InvalidState("El torneo no tiene plantilla asignada")
    n = _copy_template(db, t, tpl_id)
    audit(
        db,
        user,
        "tournament",
        t.id,
        "generate_categories",
        after={"template_id": tpl_id, "created": n},
        tournament_id=t.id,
    )
    db.commit()
    return n


def entrant_counts(db: Session, tid: int) -> dict[int, int]:
    """Inscritos activos por categoría en una sola consulta."""
    rows = db.execute(
        select(Registration.category_id, func.count())
        .where(Registration.tournament_id == tid, Registration.status == "active")
        .group_by(Registration.category_id)
    ).all()
    return {cid: n for cid, n in rows}


def entrant_count(db: Session, cid: int) -> int:
    return (
        db.scalar(
            select(func.count())
            .select_from(Registration)
            .where(Registration.category_id == cid, Registration.status == "active")
        )
        or 0
    )


def refresh_category_status(db: Session, c: Category) -> None:
    """Abierta ↔ Vacía según inscritos. Los demás estados los mueven las llaves."""
    if c.status in ("open", "empty"):
        c.status = "open" if entrant_count(db, c.id) else "empty"


def category_out(db: Session, c: Category, count: int | None = None) -> s.CategoryOut:
    out = s.CategoryOut.model_validate(c)
    out.entrant_count = entrant_count(db, c.id) if count is None else count
    out.advice = few_entrants_advice(out.entrant_count) if c.status in ("open", "empty") else []
    if c.max_entrants and out.entrant_count > c.max_entrants and c.status in ("open", "empty", "ready"):
        out.advice = [*out.advice, "split"]
    out.split_from_id = _split_source(db, c.id)
    out.has_split = _has_split(db, c.id)
    return out


def _split_source(db: Session, cid: int) -> int | None:
    return db.scalar(
        select(CategorySplit.source_category_id).where(
            CategorySplit.new_category_id == cid, CategorySplit.undone_at.is_(None)
        )
    )


def _has_split(db: Session, cid: int) -> bool:
    return bool(
        db.scalar(
            select(CategorySplit.id).where(CategorySplit.source_category_id == cid, CategorySplit.undone_at.is_(None))
        )
    )


def _fill_weight_range(fields: dict[str, Any]) -> None:
    """Sin rango explícito, se deduce de la etiqueta ("-45", "+84", "45-50")."""
    if fields.get("weight_class") and fields.get("weight_min_kg") is None and fields.get("weight_max_kg") is None:
        fields["weight_min_kg"], fields["weight_max_kg"] = parse_weight_range(fields["weight_class"])


def _validate_category_rules(fields: dict[str, Any]) -> None:
    validate_kumite_rules(fields.get("kumite_rules"))
    validate_kata_rules(fields.get("kata_rules"))
    validate_competition_rules(fields.get("competition_rules"))
    if fields.get("max_entrants") is not None:
        _check(int(fields["max_entrants"]) >= 2, "El cupo debe ser de al menos 2")


def create_category(db: Session, user: User, tid: int, data: s.CategoryCreate) -> Category:
    get_tournament(db, tid)
    fields = data.model_dump()
    _validate_category_rules(fields)
    _fill_weight_range(fields)
    c = Category(tournament_id=tid, status="empty", is_manual=True, **fields, updated_by_id=user.id)
    db.add(c)
    db.flush()
    audit(db, user, "category", c.id, "create", after=snapshot(c), tournament_id=tid)
    db.commit()
    db.refresh(c)
    return c


def update_category(db: Session, user: User, cid: int, data: s.CategoryUpdate) -> Category:
    c = get_category(db, cid)
    check_version(c, data.version, "La categoría")
    before = snapshot(c)
    changes = data.model_dump(exclude_unset=True, exclude={"version"})
    _validate_category_rules(changes)
    if "weight_class" in changes and "weight_min_kg" not in changes and "weight_max_kg" not in changes:
        changes["weight_min_kg"], changes["weight_max_kg"] = parse_weight_range(changes["weight_class"])
    structural = {"format", "third_place_rule", "kata_method", "kata_structure", "kata_judges", "kata_rules"} & set(
        changes
    )
    if structural and c.status in ("in_progress", "finished"):
        raise InvalidState("No se puede cambiar el formato de una categoría con combates iniciados")
    if "tatami_id" in changes and changes["tatami_id"] is not None:
        tat = db.get(Tatami, changes["tatami_id"])
        if tat is None or tat.tournament_id != c.tournament_id:
            raise InvalidState("Tatami inválido para este torneo")
    for k, v in changes.items():
        setattr(c, k, v)
    bump(c, user)
    audit(db, user, "category", c.id, "update", before, snapshot(c), tournament_id=c.tournament_id)
    db.commit()
    db.refresh(c)
    return c


def cancel_category(db: Session, user: User, cid: int, reason: str, version: int | None = None) -> Category:
    c = get_category(db, cid)
    check_version(c, version, "La categoría")
    if c.status in ("in_progress", "finished"):
        raise InvalidState("La categoría ya tiene combates")
    if c.status == "merged":
        raise InvalidState("La categoría está fusionada; deshaz la fusión primero")
    before = c.status
    c.status, c.cancel_reason = "cancelled", reason
    bump(c, user)
    audit(db, user, "category", c.id, "cancel", {"status": before}, {"status": "cancelled"}, reason, c.tournament_id)
    db.commit()
    return c


def _has_started_matches(db: Session, cid: int) -> bool:
    return bool(
        db.scalar(
            select(func.count())
            .select_from(Match)
            .where(Match.category_id == cid, Match.is_current, Match.status.in_(("in_progress", "finished")))
        )
    )


def merge_categories(db: Session, user: User, tid: int, data: s.CategoryMergeIn) -> Category:
    sources = [get_category(db, i) for i in data.source_ids]
    if any(c.tournament_id != tid for c in sources):
        raise InvalidState("Todas las categorías deben ser del mismo torneo")
    for c in sources:
        if c.status in ("merged", "cancelled", "in_progress", "finished"):
            raise InvalidState(f"La categoría {c.name} no se puede fusionar (estado {c.status})")
    if data.target_id:
        target = get_category(db, data.target_id)
        if target.id in data.source_ids:
            raise InvalidState("El destino no puede estar entre los orígenes")
        if any(c.is_team != target.is_team for c in sources):
            raise InvalidState("No se fusionan categorías individuales con categorías por equipos")
        if target.status in ("merged", "cancelled", "in_progress", "finished"):
            raise InvalidState("La categoría destino no admite fusiones")
        if target.status == "ready":
            apply_warnings(
                db,
                user,
                [
                    {
                        "code": "TARGET_BRACKET_DISCARDED",
                        "message": "La llave del destino se descartará; hay que regenerarla",
                    }
                ],
                data.override.reason if data.override else None,
                "category",
                lambda: target.id,
            )
    else:
        base = sources[0]
        if any(c.is_team != base.is_team for c in sources):
            raise InvalidState("No se fusionan categorías individuales con categorías por equipos")
        fields = {f: getattr(base, f) for f in CATEGORY_FIELDS}
        # El rango de la categoría nueva cubre a todas las de origen.
        for f, agg in (("age_min", min), ("grade_min", min), ("age_max", max), ("grade_max", max)):
            vals = [getattr(c, f) for c in sources]
            fields[f] = None if any(v is None for v in vals) else agg(vals)
        if len({c.sex for c in sources}) > 1:
            fields["sex"] = "X"
        if len({c.weight_class for c in sources}) > 1:
            fields["weight_class"] = None
        fields["code"] = "+".join(c.code for c in sources)[:40]
        fields["name"] = data.new_name or " + ".join(c.name for c in sources)
        target = Category(tournament_id=tid, status="open", is_manual=True, **fields)
        db.add(target)
        db.flush()
    from app.services.brackets import discard_bracket  # evitar ciclo

    if data.target_id:
        discard_bracket(db, target)  # los nuevos inscritos no están en la llave vieja
    for c in sources:
        discard_bracket(db, c)  # una llave generada (sin combates) deja de valer
        regs = db.scalars(
            select(Registration).where(Registration.category_id == c.id, Registration.status == "active")
        ).all()
        for r in regs:
            r.category_id = target.id
            bump(r, user)
        db.add(
            CategoryMerge(
                target_category_id=target.id,
                source_category_id=c.id,
                moved_registration_ids=[r.id for r in regs],
                reason=data.reason,
                created_by_id=user.id,
            )
        )
        c.status, c.merged_into_id = "merged", target.id
        bump(c, user)
        audit(db, user, "category", c.id, "merge", after={"into": target.id}, reason=data.reason, tournament_id=tid)
    db.flush()
    refresh_category_status(db, target)
    db.commit()
    db.refresh(target)
    return target


def undo_merge(db: Session, user: User, target_id: int) -> Category:
    """Deshace las fusiones hacia ``target_id`` si no hay combates iniciados."""
    target = get_category(db, target_id)
    if _has_started_matches(db, target.id):
        raise InvalidState("No se puede deshacer: ya hay combates iniciados")
    merges = db.scalars(
        select(CategoryMerge).where(CategoryMerge.target_category_id == target.id, CategoryMerge.undone_at.is_(None))
    ).all()
    if not merges:
        raise InvalidState("La categoría no tiene fusiones activas")
    for m in merges:
        src = get_category(db, m.source_category_id)
        for rid in m.moved_registration_ids:
            r = db.get(Registration, rid)
            if r and r.category_id == target.id:
                r.category_id = src.id
                bump(r, user)
        src.status, src.merged_into_id = "open", None
        refresh_category_status(db, src)
        m.undone_at = utcnow()
        audit(db, user, "category", src.id, "unmerge", after={"from": target.id}, tournament_id=target.tournament_id)
    db.flush()
    from app.services.brackets import discard_bracket  # evitar ciclo

    discard_bracket(db, target)
    if target.is_manual and entrant_count(db, target.id) == 0:
        target.status = "cancelled"
        target.cancel_reason = "Fusión deshecha"
    else:
        refresh_category_status(db, target)
    db.commit()
    db.refresh(target)
    return target


# ---------------------------------------------------------------------------
# Configuración efectiva (herencia torneo → categoría)
# ---------------------------------------------------------------------------


def effective_format(c: Category, t: Tournament) -> str:
    if c.modality == "kata" and (c.kata_structure or t.kata_defaults.get("structure")) == "rounds":
        return "kata_rounds"
    return c.format or t.default_format


def effective_third_place(c: Category, t: Tournament) -> ThirdPlaceRule:
    return ThirdPlaceRule(c.third_place_rule or t.default_third_place_rule)


def effective_kumite_rules(c: Category, t: Tournament) -> KumiteRules:
    cfg = {**(t.kumite_rules or {}), **(c.kumite_rules or {})}
    if c.duration_seconds:
        cfg["duration_seconds"] = c.duration_seconds
    return kumite_rules_from(cfg)


def kumite_rules_from(cfg: dict[str, Any]) -> KumiteRules:
    kw: dict[str, Any] = {}
    if "duration_seconds" in cfg:
        kw["duration_seconds"] = int(cfg["duration_seconds"])
    if "time_mode" in cfg:
        kw["time_mode"] = TimeMode(cfg["time_mode"])
    if "auto_pause_on_point" in cfg:
        kw["auto_pause_on_point"] = bool(cfg["auto_pause_on_point"])
    if cfg.get("point_values"):
        kw["point_values"] = tuple(sorted({int(x) for x in cfg["point_values"]}))
    if "lead_victory" in cfg:
        kw["lead_victory"] = cfg["lead_victory"] or None
    if "tie_rule" in cfg:
        kw["tie_rule"] = TieRule(cfg["tie_rule"])
    if cfg.get("sanction_levels"):
        kw["sanction_levels"] = tuple(cfg["sanction_levels"])
    if cfg.get("sanction_preset"):
        kw["sanction_preset"] = SanctionPreset(cfg["sanction_preset"])
    if cfg.get("sanction_levels_c2"):
        kw["sanction_levels_c2"] = tuple(cfg["sanction_levels_c2"])
    if "senshu_auto_loss" in cfg:
        kw["senshu_auto_loss"] = bool(cfg["senshu_auto_loss"])
    for k in ("senshu_loss_level", "senshu_loss_last_seconds", "golden_point_seconds"):
        if cfg.get(k) is not None:
            kw[k] = int(cfg[k])
    return KumiteRules(**kw)


# Kata: valores por defecto de cada opción (torneo ``kata_defaults``, con
# override por categoría en ``kata_rules`` y en las columnas kata_*).
KATA_DEFAULTS: dict[str, Any] = {
    "min_score": "5.0",
    "max_score": "10.0",
    "discard_each_side": None,  # None = 1 con 5 o 7 jueces, 0 con 3
    "preset": None,  # "wkf" = 7 jueces, 2 + 2 descartes y notas técnico / atléticas
    "split": False,  # dos notas por juez: técnica y atlética
    "technical_weight": "0.7",
    "rounds": [],  # cuántos pasan en cada ronda antes de la final, p. ej. [8, 4]
    "first_round_groups": 1,  # grupos de la primera ronda (WKF simplificado)
    "round_order": "reverse_rank",  # orden de salida desde la 2.ª ronda: reverse_rank | rank | random
    "no_repeat_kata": False,  # advertir si repite un kata ya ejecutado en la categoría
    "flags_judges": 3,  # jueces si se decide por banderas en una categoría por puntuación
}


def effective_kata(c: Category, t: Tournament) -> dict:
    d = {**KATA_DEFAULTS, **(t.kata_defaults or {}), **(c.kata_rules or {})}
    method = c.kata_method or d.get("method") or "flags"
    out = {
        **d,
        "method": method,
        "structure": c.kata_structure or d.get("structure") or "bracket",
        "judges": c.kata_judges or d.get("judges") or (5 if method == "scores" else 3),
    }
    if d.get("preset") == "wkf":
        # Preset WKF: lo que la configuración no fije explícitamente.
        explicit = {**(t.kata_defaults or {}), **(c.kata_rules or {})}
        if not c.kata_judges and "judges" not in explicit:
            out["judges"] = 7
        if "discard_each_side" not in explicit or explicit.get("discard_each_side") is None:
            out["discard_each_side"] = 2
        if "split" not in explicit:
            out["split"] = True
    return out


# Llaves, round robin, repechaje y separación: ``competition_rules`` del
# torneo con override por categoría.
COMPETITION_DEFAULTS: dict[str, Any] = {
    "round_robin_criteria": list(DEFAULT_RR_CRITERIA),
    "round_robin_bronzes": 1,  # 2 = el 4.º también recibe bronce (desde ``round_robin_two_bronzes_min``)
    "round_robin_two_bronzes_min": 5,
    "repechage_excluded_methods": ["kiken", "shikkaku", "hansoku"],  # WKF
    "separation": ["dojo"],  # agregar "city" para separar también por ciudad del dojo
    "groups": 2,  # formato groups_knockout: número de grupos
    "group_qualifiers": 2,  # cuántos pasan de cada grupo a la llave
    "shikkaku_tournament_wide": False,  # la mesa propone descalificar del torneo completo
}


def effective_competition(c: Category, t: Tournament) -> dict[str, Any]:
    return {**COMPETITION_DEFAULTS, **(t.competition_rules or {}), **(c.competition_rules or {})}


# ---------------------------------------------------------------------------
# Validación de la configuración (formularios y API)
# ---------------------------------------------------------------------------


def _check(cond: bool, msg: str) -> None:
    if not cond:
        raise InvalidState(msg, code="INVALID_RULES")


def validate_kumite_rules(cfg: dict[str, Any] | None) -> None:
    if not cfg:
        return
    try:
        rules = kumite_rules_from(cfg)
    except (ValueError, TypeError) as e:
        raise InvalidState(f"Reglas de kumite inválidas: {e}", code="INVALID_RULES") from e
    _check(rules.duration_seconds > 0, "La duración debe ser mayor que cero")
    _check(all(v in (1, 2, 3) for v in rules.point_values), "Los puntos válidos son 1, 2 y 3")
    _check(rules.lead_victory is None or rules.lead_victory > 0, "La diferencia de victoria debe ser positiva")
    _check(len(rules.sanction_levels) >= 1, "La escala de sanciones no puede estar vacía")
    _check(1 <= rules.senshu_loss_level <= len(rules.sanction_levels), "Nivel de sanción del senshu fuera de la escala")
    _check(rules.golden_point_seconds >= 0, "El punto de oro no puede durar menos de 0 s")
    if cfg.get("team_extra_bout_tie") is not None:
        _check(cfg["team_extra_bout_tie"] in ("hantei", "repeat"), "Empate del combate extra: hantei o repeat")
    if cfg.get("team_min_starters") is not None:
        _check(int(cfg["team_min_starters"]) >= 1, "El mínimo de titulares debe ser al menos 1")


def validate_kata_rules(cfg: dict[str, Any] | None) -> None:
    if not cfg:
        return
    if cfg.get("judges") is not None:
        _check(int(cfg["judges"]) in (3, 5, 7), "Jueces de kata: 3, 5 o 7")
    if cfg.get("discard_each_side") is not None:
        _check(0 <= int(cfg["discard_each_side"]) <= 2, "Descartes por extremo: 0, 1 o 2")
    if cfg.get("preset") is not None:
        _check(cfg["preset"] in ("wkf",), "Preset de kata desconocido")
    rounds = cfg.get("rounds") or []
    _check(isinstance(rounds, list) and all(int(x) >= 1 for x in rounds), "Rondas: lista de cuántos pasan")
    _check(all(int(a) > int(b) for a, b in zip(rounds, rounds[1:], strict=False)), "Cada ronda debe dejar menos")
    if cfg.get("first_round_groups") is not None:
        _check(1 <= int(cfg["first_round_groups"]) <= 4, "Grupos de la primera ronda: de 1 a 4")
    if cfg.get("round_order") is not None:
        _check(cfg["round_order"] in ("reverse_rank", "rank", "random"), "Orden de salida desconocido")
    if cfg.get("technical_weight") is not None:
        _check(0 < float(cfg["technical_weight"]) < 1, "El peso técnico debe estar entre 0 y 1")


def validate_competition_rules(cfg: dict[str, Any] | None) -> None:
    if not cfg:
        return
    crit = cfg.get("round_robin_criteria")
    if crit is not None:
        _check(
            isinstance(crit, list) and len(crit) >= 1 and all(c in RR_CRITERIA for c in crit),
            f"Criterios de round robin: {', '.join(RR_CRITERIA)}",
        )
    if cfg.get("round_robin_bronzes") is not None:
        _check(int(cfg["round_robin_bronzes"]) in (1, 2), "Bronces en round robin: 1 o 2")
    sep = cfg.get("separation")
    if sep is not None:
        _check(isinstance(sep, list) and all(x in ("dojo", "city") for x in sep), "Separación: dojo y/o city")
    if cfg.get("groups") is not None:
        _check(2 <= int(cfg["groups"]) <= 16, "Grupos: de 2 a 16")
    if cfg.get("group_qualifiers") is not None:
        _check(1 <= int(cfg["group_qualifiers"]) <= 4, "Clasificados por grupo: de 1 a 4")
