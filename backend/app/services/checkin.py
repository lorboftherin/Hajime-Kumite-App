"""Acreditación (check-in) y pesaje el día del torneo.

Ver ``docs/acreditacion-y-pesaje.md``. Resumen:

* Cada inscripción tiene ``checkin_status`` (pending | present | absent). La
  mesa de acreditación marca a la **persona**: marcar presente a alguien marca
  todas sus inscripciones activas del torneo.
* El pesaje guarda el peso medido y lo compara con el rango de la categoría
  (más la tolerancia del torneo): ``ok``, ``over`` (pasado) o ``under`` (debajo).
  Fuera de rango se advierte y se ofrece mover a una categoría sugerida o
  aceptar con motivo (override auditado). Nunca se bloquea.
* Ausente: al generar la llave se advierte y se puede excluir (se retira con
  «No se presentó»); si la llave ya existe, se retira y se da walkover.
* Nada de esto es obligatorio: sin ``checkin_required`` el torneo funciona igual
  que antes; con él, la verificación previa avisa de los que faltan acreditar.
"""

from __future__ import annotations

import re
import secrets
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api import schemas as s
from app.api.errors import InvalidState, NotFound
from app.db.base import utcnow
from app.db.models import Category, Registration, RuleOverride, Tournament, User
from app.domain.identity import normalize_name
from app.services.audit import apply_warnings, audit, bump
from app.services.registrations import get_registration, registration_out, suggestions, update_registration
from app.services.tournaments import get_category, get_tournament, refresh_category_status

CHECKIN_STATUSES = ("pending", "present", "absent")
NO_SHOW_REASON = "No se presentó"
WEIGH_IN_OVERRIDE_CODE = "WEIGH_IN_OUT_OF_RANGE"
# Alfabeto del código de credencial: sin 0/O ni 1/I/L, para dictarlo o tipearlo sin dudas.
CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
CODE_LENGTH = 6

# ---------------------------------------------------------------------------
# Rango de peso de una categoría
# ---------------------------------------------------------------------------

_NUM = r"(\d+(?:[.,]\d+)?)"


def parse_weight_class(label: str | None) -> tuple[Decimal | None, Decimal | None]:
    """Rango (mínimo, máximo) en kg a partir de la etiqueta ``weight_class``.

    «-45» o «-45 kg» → (None, 45); «+68» → (68, None); «45-50» → (45, 50);
    «45» → (None, 45). Una etiqueta que no se entiende → (None, None).

    Al integrar con las reglas deportivas (``weight_min_kg``/``weight_max_kg``
    en la categoría) esta función queda solo como respaldo para las
    categorías que no tengan el rango explícito: ver :func:`weight_range`.
    """
    if not label:
        return None, None
    txt = label.strip().lower().replace("kg", "").replace("−", "-").replace("–", "-").replace(" ", "")
    txt = txt.replace("menosde", "-").replace("masde", "+").replace("másde", "+")

    def num(x: str) -> Decimal:
        return Decimal(x.replace(",", "."))

    try:
        if m := re.fullmatch(_NUM + "-" + _NUM, txt):
            lo, hi = num(m.group(1)), num(m.group(2))
            return (lo, hi) if lo <= hi else (hi, lo)
        if m := re.fullmatch(r"-" + _NUM, txt):
            return None, num(m.group(1))
        if m := re.fullmatch(r"\+" + _NUM, txt):
            return num(m.group(1)), None
        if m := re.fullmatch(_NUM, txt):
            return None, num(m.group(1))
    except InvalidOperation:  # pragma: no cover - el regex ya filtra
        pass
    return None, None


def weight_range(c: Category) -> tuple[Decimal | None, Decimal | None]:
    """Rango de peso de la categoría: columnas explícitas si existen, si no la etiqueta."""
    lo = getattr(c, "weight_min_kg", None)
    hi = getattr(c, "weight_max_kg", None)
    if lo is not None or hi is not None:
        return (Decimal(str(lo)) if lo is not None else None, Decimal(str(hi)) if hi is not None else None)
    return parse_weight_class(c.weight_class)


def weigh_in_result(weight: Decimal, rng: tuple[Decimal | None, Decimal | None], tolerance: Decimal) -> str:
    lo, hi = rng
    if hi is not None and weight > hi + tolerance:
        return "over"
    if lo is not None and weight < lo - tolerance:
        return "under"
    return "ok"


def _range_text(rng: tuple[Decimal | None, Decimal | None]) -> str:
    lo, hi = rng
    if lo is not None and hi is not None:
        return f"{lo:g}–{hi:g} kg"
    if hi is not None:
        return f"hasta {hi:g} kg"
    if lo is not None:
        return f"más de {lo:g} kg"
    return "sin rango"


# ---------------------------------------------------------------------------
# Códigos de credencial
# ---------------------------------------------------------------------------


def _new_code() -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))


def ensure_codes(db: Session, regs: list[Registration]) -> None:
    """Asigna un código corto único a las inscripciones que aún no lo tienen.

    La credencial de una persona lleva el código de su primera inscripción;
    leer cualquiera de sus códigos la acredita en todas sus categorías.
    """
    missing = [r for r in regs if not r.credential_code]
    if not missing:
        return
    taken = set(db.scalars(select(Registration.credential_code).where(Registration.credential_code.is_not(None))).all())
    for r in sorted(missing, key=lambda x: x.id):
        code = _new_code()
        while code in taken:
            code = _new_code()
        taken.add(code)
        r.credential_code = code
    db.flush()


def normalize_code(code: str) -> str:
    """El lector puede traer espacios, minúsculas o un prefijo («HJ:ABC234»)."""
    txt = code.strip().upper()
    if ":" in txt:
        txt = txt.rsplit(":", 1)[1]
    return re.sub(r"[^0-9A-Z]", "", txt)


# ---------------------------------------------------------------------------
# Lista de acreditación
# ---------------------------------------------------------------------------


def _row(r: Registration, c: Category | None, tolerance: Decimal) -> dict[str, Any]:
    rng = weight_range(c) if c else (None, None)
    return {
        "registration_id": r.id,
        "person_id": r.person_id,
        "team_id": r.team_id,
        "name": r.display_name,
        "dojo_id": r.dojo_id,
        "dojo_name": r.dojo.name if r.dojo else "",
        "category_id": r.category_id,
        "category_name": c.name if c else "",
        "category_status": c.status if c else "",
        "modality": c.modality if c else "",
        "weight_class": c.weight_class if c else None,
        "weight_min_kg": float(rng[0]) if rng[0] is not None else None,
        "weight_max_kg": float(rng[1]) if rng[1] is not None else None,
        "needs_weigh_in": bool(c and c.modality == "kumite" and not c.is_team and (rng[0] or rng[1])),
        "status": r.status,
        "checkin_status": r.checkin_status,
        "checked_in_at": r.checked_in_at,
        "weight_kg": float(r.weight_kg) if r.weight_kg is not None else None,
        "weighed_at": r.weighed_at,
        "weigh_in_result": r.weigh_in_result,
        "code": r.credential_code,
        "version": r.version,
    }


def _resolved_ids(db: Session, ids: list[int]) -> set[int]:
    """Inscripciones fuera de peso cuyo resultado se aceptó con motivo."""
    if not ids:
        return set()
    return set(
        db.scalars(
            select(RuleOverride.entity_id).where(
                RuleOverride.entity == "registration",
                RuleOverride.code == WEIGH_IN_OVERRIDE_CODE,
                RuleOverride.entity_id.in_(ids),
            )
        ).all()
    )


def checkin_list(
    db: Session,
    tid: int,
    *,
    dojo_id: int | None = None,
    category_id: int | None = None,
    status: str | None = None,
    q: str | None = None,
    out_of_weight: bool = False,
) -> dict[str, Any]:
    """Lista de la mesa de acreditación con contadores por categoría (tres consultas)."""
    t = get_tournament(db, tid)
    tolerance = Decimal(t.weigh_in_tolerance_kg or 0)
    regs = list(
        db.scalars(
            select(Registration)
            .where(Registration.tournament_id == tid, Registration.status == "active")
            .order_by(Registration.id)
        )
        .unique()
        .all()
    )
    ensure_codes(db, regs)
    db.commit()
    cats = {
        c.id: c
        for c in db.scalars(
            select(Category).where(Category.tournament_id == tid, Category.status.not_in(("merged", "cancelled")))
        ).all()
    }
    resolved = _resolved_ids(db, [r.id for r in regs if r.weigh_in_result in ("over", "under")])
    summary: dict[int, dict[str, Any]] = {}
    for r in regs:
        c = cats.get(r.category_id)
        if c is None:
            continue
        row = summary.setdefault(
            c.id,
            {"category_id": c.id, "category_name": c.name, "total": 0, "present": 0, "absent": 0, "pending": 0},
        )
        row["total"] += 1
        row[r.checkin_status if r.checkin_status in CHECKIN_STATUSES else "pending"] += 1
    rows = []
    nq = normalize_name(q) if q else ""
    for r in regs:
        if dojo_id and r.dojo_id != dojo_id:
            continue
        if category_id and r.category_id != category_id:
            continue
        if status and r.checkin_status != status:
            continue
        if out_of_weight and r.weigh_in_result not in ("over", "under"):
            continue
        if nq:
            hay = normalize_name(f"{r.display_name} {r.dojo.name if r.dojo else ''}")
            if nq not in hay and nq.upper() != (r.credential_code or ""):
                continue
        row = _row(r, cats.get(r.category_id), tolerance)
        row["weigh_in_resolved"] = r.id in resolved
        rows.append(row)
    rows.sort(key=lambda x: (normalize_name(x["name"]), x["category_name"]))
    totals = {k: sum(v[k] for v in summary.values()) for k in ("total", "present", "absent", "pending")}
    return {
        "tournament_id": tid,
        "checkin_required": t.checkin_required,
        "weigh_in_tolerance_kg": float(tolerance),
        "rows": rows,
        "categories": sorted(summary.values(), key=lambda x: x["category_name"]),
        "totals": totals,
    }


# ---------------------------------------------------------------------------
# Marcar presente / ausente
# ---------------------------------------------------------------------------


def _person_regs(db: Session, r: Registration) -> list[Registration]:
    """Todas las inscripciones activas de la misma persona en el torneo."""
    if r.person_id is None:
        return [r]
    return list(
        db.scalars(
            select(Registration).where(
                Registration.tournament_id == r.tournament_id,
                Registration.person_id == r.person_id,
                Registration.status == "active",
            )
        )
        .unique()
        .all()
    )


def _set_status(db: Session, user: User, r: Registration, status: str) -> bool:
    if r.checkin_status == status:
        return False  # idempotente: reenviar el mismo toque no cambia nada ni audita
    before = r.checkin_status
    r.checkin_status = status
    r.checked_in_at = utcnow() if status != "pending" else None
    r.checked_in_by_id = user.id if status != "pending" else None
    bump(r, user)
    audit(
        db,
        user,
        "registration",
        r.id,
        "checkin",
        {"checkin_status": before},
        {"checkin_status": status},
        tournament_id=r.tournament_id,
    )
    return True


def _absent_options(db: Session, regs: list[Registration]) -> list[dict[str, Any]]:
    """Para cada ausente con llave ya generada: opciones (walkover)."""
    out = []
    cat_ids = {r.category_id for r in regs if r.checkin_status == "absent"}
    if not cat_ids:
        return out
    cats = {c.id: c for c in db.scalars(select(Category).where(Category.id.in_(cat_ids))).all()}
    for r in regs:
        c = cats.get(r.category_id)
        if r.checkin_status == "absent" and c and c.status in ("ready", "in_progress"):
            out.append(
                {
                    "registration_id": r.id,
                    "category_id": c.id,
                    "category_name": c.name,
                    "options": ["walkover"],
                    "message": f"«{c.name}» ya tiene llave: retira con «{NO_SHOW_REASON}» y da walkover",
                }
            )
    return out


def set_checkin(
    db: Session, user: User, tid: int, registration_ids: list[int], status: str, *, whole_person: bool = True
) -> dict[str, Any]:
    """Marca presente, ausente o pendiente (individual o en lote).

    Con ``whole_person`` se marcan todas las inscripciones activas de cada
    persona. Idempotente: repetir la marca no cambia nada.
    """
    if status not in CHECKIN_STATUSES:
        raise InvalidState("Estado de acreditación inválido")
    regs = {
        r.id: r for r in db.scalars(select(Registration).where(Registration.id.in_(registration_ids))).unique().all()
    }
    missing = [i for i in registration_ids if i not in regs]
    if missing:
        raise NotFound(f"Inscripción no encontrada: {missing[0]}")
    if any(r.tournament_id != tid for r in regs.values()):
        raise InvalidState("Una inscripción es de otro torneo")
    targets: dict[int, Registration] = {}
    for r in regs.values():
        for x in _person_regs(db, r) if whole_person else [r]:
            targets[x.id] = x
    changed = [x.id for x in targets.values() if x.status == "active" and _set_status(db, user, x, status)]
    db.commit()
    rows = sorted(targets.values(), key=lambda x: x.id)
    return {
        "changed": changed,
        "registrations": [registration_out(x) for x in rows],
        "absent_with_bracket": _absent_options(db, rows),
    }


def scan(db: Session, user: User, tid: int, code: str) -> dict[str, Any]:
    """Código de la credencial (tipeado o leído del QR): acredita a la persona."""
    norm = normalize_code(code)
    r = db.scalar(
        select(Registration).where(Registration.tournament_id == tid, Registration.credential_code == norm).limit(1)
    )
    if r is None:
        raise NotFound(f"No hay ninguna inscripción con el código {norm or code!r} en este torneo")
    out = set_checkin(db, user, tid, [r.id], "present")
    out["code"] = norm
    out["person_id"] = r.person_id
    out["name"] = r.display_name
    return out


def no_show(db: Session, user: User, rid: int) -> dict[str, Any]:
    """Ausente con la llave ya generada: retira con «No se presentó» y da walkover
    al rival en todos sus combates pendientes (reutiliza el walkover por retiro)."""
    from app.services.organizer import walkover_pending

    r = get_registration(db, rid)
    if r.checkin_status != "absent":
        _set_status(db, user, r, "absent")
    if r.status == "active":
        r.status, r.withdrawn_reason = "withdrawn", NO_SHOW_REASON
        bump(r, user)
        refresh_category_status(db, get_category(db, r.category_id))
        audit(db, user, "registration", r.id, "withdraw", reason=NO_SHOW_REASON, tournament_id=r.tournament_id)
        db.flush()
    c = get_category(db, r.category_id)
    if c.is_team or c.status not in ("ready", "in_progress"):
        db.commit()
        return {"registration_id": r.id, "walkover_matches": [], "waiting_matches": []}
    return walkover_pending(db, user, rid, NO_SHOW_REASON)


# ---------------------------------------------------------------------------
# Pesaje
# ---------------------------------------------------------------------------


def _weight_suggestions(db: Session, r: Registration, weight: Decimal, tolerance: Decimal) -> list[dict[str, Any]]:
    """Categorías sugeridas para la persona (las de siempre) cuyo rango incluye el peso."""
    if r.person_id is None:
        return []
    c = get_category(db, r.category_id)
    out = []
    for cand in suggestions(db, r.tournament_id, r.person_id, c.modality):
        if cand.id == c.id or cand.is_team != c.is_team:
            continue
        rng = weight_range(cand)
        if rng == (None, None):
            continue
        if weigh_in_result(weight, rng, tolerance) == "ok":
            out.append(
                {
                    "category_id": cand.id,
                    "name": cand.name,
                    "weight_class": cand.weight_class,
                    "range": _range_text(rng),
                }
            )
    return out


def weigh_in(db: Session, user: User, rid: int, weight_kg: Decimal, *, whole_person: bool = True) -> dict[str, Any]:
    """Registra el peso. Se guarda aunque esté fuera de rango (advertir, no bloquear)
    y se devuelven las advertencias con las categorías sugeridas."""
    r = get_registration(db, rid)
    t = get_tournament(db, r.tournament_id)
    tolerance = Decimal(t.weigh_in_tolerance_kg or 0)
    weight = Decimal(weight_kg).quantize(Decimal("0.01"))
    targets = [r]
    if whole_person:
        # El mismo peso vale para todas sus categorías de kumite individual.
        others = [x for x in _person_regs(db, r) if x.id != r.id]
        kumite = {
            c.id
            for c in db.scalars(select(Category).where(Category.id.in_({x.category_id for x in others}))).all()
            if c.modality == "kumite" and not c.is_team
        }
        targets += [x for x in others if x.category_id in kumite]
    results = []
    for x in targets:
        c = get_category(db, x.category_id)
        rng = weight_range(c)
        res = weigh_in_result(weight, rng, tolerance) if rng != (None, None) else "ok"
        before = {"weight_kg": float(x.weight_kg) if x.weight_kg is not None else None, "result": x.weigh_in_result}
        x.weight_kg, x.weighed_at, x.weigh_in_result = weight, utcnow(), res
        # Un peso nuevo invalida la aceptación anterior del fuera de rango.
        if before["result"] != res or before["weight_kg"] != float(weight):
            bump(x, user)
            audit(
                db,
                user,
                "registration",
                x.id,
                "weigh_in",
                before,
                {"weight_kg": float(weight), "result": res},
                tournament_id=x.tournament_id,
            )
        # Pesarse también acredita: quien sube a la balanza está presente.
        if x.status == "active" and x.checkin_status != "present":
            _set_status(db, user, x, "present")
        item: dict[str, Any] = {
            "registration_id": x.id,
            "category_id": c.id,
            "category_name": c.name,
            "result": res,
            "range": _range_text(rng),
            "warnings": [],
            "suggestions": [],
        }
        if res != "ok":
            word = "sobre" if res == "over" else "debajo de"
            item["warnings"].append(
                {
                    "code": "WEIGHT_OVER" if res == "over" else "WEIGHT_UNDER",
                    "message": f"{weight:g} kg está {word}l rango de «{c.name}» ({_range_text(rng)}"
                    + (f", tolerancia {tolerance:g} kg" if tolerance else "")
                    + ")",
                }
            )
            item["suggestions"] = _weight_suggestions(db, x, weight, tolerance)
        results.append(item)
    db.commit()
    return {"weight_kg": float(weight), "results": results}


def accept_weight(db: Session, user: User, rid: int, reason: str) -> Registration:
    """Deja a la persona en su categoría aunque el peso esté fuera de rango (override auditado)."""
    r = get_registration(db, rid)
    if r.weigh_in_result not in ("over", "under"):
        raise InvalidState("El peso de esta inscripción no está fuera de rango")
    c = get_category(db, r.category_id)
    apply_warnings(
        db,
        user,
        [
            {
                "code": WEIGH_IN_OVERRIDE_CODE,
                "message": f"Compite en «{c.name}» con {r.weight_kg:g} kg (fuera de rango)",
            }
        ],
        reason,
        "registration",
        lambda: r.id,
    )
    audit(db, user, "registration", r.id, "weigh_in_accept", reason=reason, tournament_id=r.tournament_id)
    db.commit()
    return r


def move_after_weigh_in(
    db: Session, user: User, rid: int, category_id: int, reason: str, version: int | None = None
) -> Registration:
    """Mueve a la categoría sugerida por el peso (la de inscripciones valida y audita)."""
    r = get_registration(db, rid)
    t = get_tournament(db, r.tournament_id)
    target = get_category(db, category_id)
    moved = update_registration(
        db,
        user,
        rid,
        s.RegistrationUpdate(
            version=version if version is not None else r.version,
            category_id=category_id,
            weight_class=target.weight_class,
            override=s.Override(reason=reason),
        ),
    )
    if moved.weight_kg is not None:
        rng = weight_range(target)
        moved.weigh_in_result = (
            weigh_in_result(Decimal(moved.weight_kg), rng, Decimal(t.weigh_in_tolerance_kg or 0))
            if rng != (None, None)
            else "ok"
        )
    audit(
        db,
        user,
        "registration",
        moved.id,
        "weigh_in_move",
        after={"category_id": category_id},
        reason=reason,
        tournament_id=moved.tournament_id,
    )
    db.commit()
    db.refresh(moved)
    return moved


# ---------------------------------------------------------------------------
# Llaves y verificación previa
# ---------------------------------------------------------------------------


def bracket_absent_check(
    db: Session, user: User, t: Tournament, regs: list[Registration], exclude_absent: bool
) -> tuple[list[Registration], list[dict[str, str]]]:
    """Antes de sortear: advierte de ausentes (y de no acreditados si el check-in
    es obligatorio). Con ``exclude_absent`` retira a los ausentes con «No se
    presentó» y los deja fuera de la llave."""
    absent = [r for r in regs if r.checkin_status == "absent"]
    warnings: list[dict[str, str]] = []
    if absent and exclude_absent:
        for r in absent:
            r.status, r.withdrawn_reason = "withdrawn", NO_SHOW_REASON
            bump(r, user)
            audit(db, user, "registration", r.id, "withdraw", reason=NO_SHOW_REASON, tournament_id=r.tournament_id)
        regs = [r for r in regs if r.checkin_status != "absent"]
    elif absent:
        names = ", ".join(r.display_name for r in absent[:5])
        warnings.append(
            {
                "code": "ABSENT_ENTRANTS",
                "message": f"{len(absent)} inscrito(s) marcado(s) ausente(s): {names}. "
                "Genera con «excluir ausentes» para dejarlos fuera",
            }
        )
    if t.checkin_required:
        pending = [r for r in regs if r.checkin_status == "pending"]
        if pending:
            warnings.append(
                {
                    "code": "NOT_CHECKED_IN",
                    "message": f"{len(pending)} inscrito(s) sin acreditar: "
                    + ", ".join(r.display_name for r in pending[:5]),
                }
            )
    return regs, warnings


def readiness_issues(db: Session, t: Tournament) -> list[dict[str, Any]]:
    """Problemas de acreditación y pesaje para la verificación previa."""
    issues: list[dict[str, Any]] = []
    if t.checkin_required:
        n_pending = db.scalar(
            select(func.count())
            .select_from(Registration)
            .where(
                Registration.tournament_id == t.id,
                Registration.status == "active",
                Registration.checkin_status == "pending",
            )
        )
        if n_pending:
            pending = db.scalars(
                select(Registration)
                .where(
                    Registration.tournament_id == t.id,
                    Registration.status == "active",
                    Registration.checkin_status == "pending",
                )
                .order_by(Registration.id)
                .limit(30)
            ).all()
            issues.append(
                {
                    "code": "NOT_CHECKED_IN",
                    "severity": "warning",
                    "message": f"{n_pending} "
                    + ("inscripción sin acreditar" if n_pending == 1 else "inscripciones sin acreditar")
                    + " (el check-in es obligatorio en este torneo)",
                    "items": sorted({r.display_name for r in pending}),
                    "registration_ids": [r.id for r in pending],
                }
            )
    out = db.scalars(
        select(Registration).where(
            Registration.tournament_id == t.id,
            Registration.status == "active",
            Registration.weigh_in_result.in_(("over", "under")),
        )
    ).all()
    resolved = _resolved_ids(db, [r.id for r in out])
    unresolved = [r for r in out if r.id not in resolved]
    if unresolved:
        issues.append(
            {
                "code": "WEIGHT_OUT_OF_RANGE",
                "severity": "warning",
                "message": f"{len(unresolved)} "
                + ("peso fuera de rango sin resolver" if len(unresolved) == 1 else "pesos fuera de rango sin resolver")
                + ": mueve de categoría o acepta con motivo",
                "items": sorted(f"{r.display_name} ({float(r.weight_kg or 0):g} kg)" for r in unresolved),
                "registration_ids": [r.id for r in unresolved],
            }
        )
    return issues
