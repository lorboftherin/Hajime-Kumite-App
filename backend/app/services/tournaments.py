from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api import schemas as s
from app.api.errors import Forbidden, InvalidState, NotFound
from app.db.base import utcnow
from app.db.models import (
    Category,
    CategoryMerge,
    CategoryTemplate,
    Match,
    Registration,
    Tatami,
    TemplateCategory,
    Tournament,
    User,
)
from app.domain.brackets import ThirdPlaceRule
from app.domain.categories import can_transition, few_entrants_advice, is_reopen
from app.domain.kumite import KumiteRules, TieRule, TimeMode
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


def create_tournament(db: Session, user: User, data: s.TournamentCreate) -> Tournament:
    fields = data.model_dump(exclude={"tatami_count"})
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
    if "is_test" in changes and changes["is_test"] != t.is_test and not user.is_admin:
        # Cambiar la marca altera el historial y las estadísticas (sección 12).
        raise Forbidden("Solo el Admin Global puede cambiar la marca de torneo de prueba")
    for k, v in changes.items():
        setattr(t, k, v)
    if "age_reference_date" in changes and before.get("age_reference_date") != t.age_reference_date.isoformat():
        _recompute_ages(db, t)
    bump(t, user)
    audit(db, user, "tournament", t.id, "update", before, snapshot(t), tournament_id=t.id)
    db.commit()
    db.refresh(t)
    return t


def _recompute_ages(db: Session, t: Tournament) -> None:
    """La edad de cada inscripción se calcula a la fecha de referencia (sección 13)."""
    from app.domain.categories import age_at

    for r in db.scalars(select(Registration).where(Registration.tournament_id == t.id)).all():
        if r.person and r.person.birth_date:
            r.age_at_reference = age_at(r.person.birth_date, t.age_reference_date)


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
    return out


def create_category(db: Session, user: User, tid: int, data: s.CategoryCreate) -> Category:
    get_tournament(db, tid)
    c = Category(tournament_id=tid, status="empty", is_manual=True, **data.model_dump(), updated_by_id=user.id)
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
    structural = {"format", "third_place_rule", "kata_method", "kata_structure"} & set(changes)
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
            .where(Match.category_id == cid, Match.is_current.is_(True), Match.status.in_(("in_progress", "finished")))
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
    kw = {}
    if "duration_seconds" in cfg:
        kw["duration_seconds"] = int(cfg["duration_seconds"])
    if "time_mode" in cfg:
        kw["time_mode"] = TimeMode(cfg["time_mode"])
    if "auto_pause_on_point" in cfg:
        kw["auto_pause_on_point"] = bool(cfg["auto_pause_on_point"])
    if "lead_victory" in cfg:
        kw["lead_victory"] = cfg["lead_victory"] or None
    if "tie_rule" in cfg:
        kw["tie_rule"] = TieRule(cfg["tie_rule"])
    if cfg.get("sanction_levels"):
        kw["sanction_levels"] = tuple(cfg["sanction_levels"])
    return KumiteRules(**kw)


def effective_kata(c: Category, t: Tournament) -> dict:
    d = t.kata_defaults or {}
    return {
        "method": c.kata_method or d.get("method", "flags"),
        "structure": c.kata_structure or d.get("structure", "bracket"),
        "judges": c.kata_judges or d.get("judges", 5 if (c.kata_method or d.get("method")) == "scores" else 3),
        "min_score": d.get("min_score", "5.0"),
        "max_score": d.get("max_score", "10.0"),
        "discard_each_side": d.get("discard_each_side"),
    }
