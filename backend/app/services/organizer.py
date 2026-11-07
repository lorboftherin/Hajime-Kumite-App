"""Herramientas del organizador en el día del torneo.

* Walkover en todos los combates pendientes de una inscripción retirada.
* Cola de un tatami: orden completo de categorías en una sola transacción.
* Verificación previa antes de iniciar el torneo (problemas con severidad).
* Corrección de filas de una importación en vista previa (se revalida la fila).
"""

from __future__ import annotations

import uuid
from datetime import date
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.api.errors import InvalidState, NotFound
from app.db.base import utcnow
from app.db.models import Category, DataConsent, ImportBatch, ImportRow, Match, PersonRole, Registration, Tatami, User
from app.domain.categories import Competitor, grade_to_ordinal, suggest_categories
from app.services import people
from app.services.audit import audit, bump
from app.services.brackets import record_finish
from app.services.registrations import COLUMNS, _validate_row, get_batch, get_registration, rule_of
from app.services.tournaments import entrant_counts, get_category, get_tournament

# ---------------------------------------------------------------------------
# Walkover por retiro
# ---------------------------------------------------------------------------

OPEN_MATCH = ("ready", "in_progress")


def _open_matches(db: Session, cid: int, rid: int) -> list[Match]:
    return list(
        db.scalars(
            select(Match).where(
                Match.category_id == cid,
                Match.is_current,
                Match.parent_match_id.is_(None),
                Match.status.in_(("pending", *OPEN_MATCH)),
                or_(Match.aka_registration_id == rid, Match.ao_registration_id == rid),
            )
        ).all()
    )


def walkover_pending(db: Session, user: User, rid: int, reason: str | None) -> dict[str, Any]:
    """Da walkover al rival en todos los combates pendientes de una inscripción retirada.

    Cada cierre es un evento ``finish`` con método ``walkover`` (auditado como
    cualquier cierre). Al cerrar, la llave avanza; si eso deja listo otro
    combate de la misma inscripción (repechaje), también se cierra. Los
    combates cuyo rival aún no se conoce quedan pendientes y se informan.
    """
    r = get_registration(db, rid)
    if r.status != "withdrawn":
        raise InvalidState("Retira primero la inscripción: el walkover es para quien ya no compite")
    c = get_category(db, r.category_id)
    if c.is_team:
        raise InvalidState("En categorías por equipos el walkover se registra en la mesa del enfrentamiento")
    note = reason or f"Retiro: {r.withdrawn_reason or 'sin motivo'}"
    closed: list[str] = []
    for _ in range(64):  # tope de seguridad: cada vuelta cierra al menos un combate
        ready = [m for m in _open_matches(db, c.id, r.id) if m.status in OPEN_MATCH]
        ready = [m for m in ready if m.aka_registration_id and m.ao_registration_id]
        if not ready:
            break
        for m in ready:
            rival = "ao" if m.aka_registration_id == r.id else "aka"
            record_finish(db, user, m, c, rival, "walkover", utcnow(), str(uuid.uuid4()), note, None)
            closed.append(m.code)
        db.flush()
    waiting = [m.code for m in _open_matches(db, c.id, r.id)]
    audit(
        db,
        user,
        "registration",
        r.id,
        "walkover",
        after={"matches": closed, "waiting": waiting},
        reason=note,
        tournament_id=r.tournament_id,
    )
    db.commit()
    return {"registration_id": r.id, "walkover_matches": closed, "waiting_matches": waiting}


# ---------------------------------------------------------------------------
# Cola de un tatami
# ---------------------------------------------------------------------------


def _queue_order(c: Category) -> tuple[int, int]:
    return (c.queue_position if c.queue_position is not None else 10**6, c.id)


def set_tatami_queue(db: Session, user: User, tatami_id: int, category_ids: list[int]) -> list[Category]:
    """Reemplaza la cola completa del tatami: las categorías listadas quedan en ese
    orden (posición 1, 2, …) y las que estaban y ya no figuran quedan sin tatami.
    Una categoría que estaba en otro tatami se mueve a este. Todo o nada."""
    tat = db.get(Tatami, tatami_id)
    if tat is None:
        raise NotFound("Tatami no encontrado")
    if len(set(category_ids)) != len(category_ids):
        raise InvalidState("Una categoría aparece dos veces en la cola")
    cats = {c.id: c for c in db.scalars(select(Category).where(Category.id.in_(category_ids))).all()}
    missing = [cid for cid in category_ids if cid not in cats]
    if missing:
        raise NotFound(f"Categoría no encontrada: {missing[0]}")
    for c in cats.values():
        if c.tournament_id != tat.tournament_id:
            raise InvalidState(f"«{c.name}» es de otro torneo")
        if c.status in ("merged", "cancelled"):
            raise InvalidState(f"«{c.name}» está fusionada o cancelada: no va a la cola")
    current = sorted(db.scalars(select(Category).where(Category.tatami_id == tatami_id)).all(), key=_queue_order)
    before = [c.id for c in current]
    for c in current:
        if c.id not in cats:
            c.tatami_id, c.queue_position = None, None
            bump(c, user)
    for pos, cid in enumerate(category_ids, start=1):
        c = cats[cid]
        if (c.tatami_id, c.queue_position) != (tatami_id, pos):
            c.tatami_id, c.queue_position = tatami_id, pos
            bump(c, user)
    if before != category_ids:
        audit(
            db,
            user,
            "tatami",
            tatami_id,
            "queue",
            {"categories": before},
            {"categories": category_ids},
            tournament_id=tat.tournament_id,
        )
    db.commit()
    return sorted(db.scalars(select(Category).where(Category.tatami_id == tatami_id)).all(), key=_queue_order)


# ---------------------------------------------------------------------------
# Verificación previa al inicio del torneo
# ---------------------------------------------------------------------------

SEVERITY_ORDER = {"error": 0, "warning": 1, "info": 2}


def _n(n: int, one: str, many: str) -> str:
    """«1 categoría», «3 categorías»."""
    return f"{n} {one if n == 1 else many}"


def _issue(code: str, severity: str, message: str, items: list[str] | None = None, **ids: Any) -> dict[str, Any]:
    return {"code": code, "severity": severity, "message": message, "items": items or [], **ids}


def readiness(db: Session, tid: int) -> dict[str, Any]:
    """Lista lo que conviene resolver antes de «Iniciar torneo». No bloquea nada:
    el organizador puede iniciar igual (con confirmación)."""
    t = get_tournament(db, tid)
    cats = db.scalars(
        select(Category)
        .where(Category.tournament_id == tid, Category.status.not_in(("merged", "cancelled")))
        .order_by(Category.sort_order, Category.id)
    ).all()
    counts = entrant_counts(db, tid)
    issues: list[dict[str, Any]] = []

    no_bracket = [c for c in cats if c.status == "open" and counts.get(c.id, 0) >= 2]
    if no_bracket:
        issues.append(
            _issue(
                "NO_BRACKET",
                "error",
                f"{_n(len(no_bracket), 'categoría con inscritos no tiene', 'categorías con inscritos no tienen')}"
                " llave: sus combates no aparecerán en las mesas",
                [f"{c.name} ({counts.get(c.id, 0)} inscritos)" for c in no_bracket],
                category_ids=[c.id for c in no_bracket],
            )
        )
    single = [c for c in cats if c.status == "open" and counts.get(c.id, 0) == 1]
    if single:
        issues.append(
            _issue(
                "SINGLE_ENTRANT",
                "warning",
                f"{_n(len(single), 'categoría', 'categorías')} con un solo inscrito: fusiona con otra o cancela",
                [c.name for c in single],
                category_ids=[c.id for c in single],
            )
        )
    with_bracket = [c for c in cats if c.status in ("ready", "in_progress")]
    no_tatami = [c for c in with_bracket if c.tatami_id is None]
    if no_tatami:
        issues.append(
            _issue(
                "NO_TATAMI",
                "error",
                f"{_n(len(no_tatami), 'categoría con llave no tiene', 'categorías con llave no tienen')}"
                " tatami: no entrarán en ninguna cola",
                [c.name for c in no_tatami],
                category_ids=[c.id for c in no_tatami],
            )
        )

    tatamis = list(t.tatamis)
    if not tatamis:
        issues.append(_issue("NO_TATAMIS", "error", "El torneo no tiene tatamis"))
    op_roles = db.scalars(select(PersonRole).where(PersonRole.role == "table_operator")).all()
    general_ops = any(
        r.scope_type == "global" or (r.scope_type == "tournament" and r.scope_id == tid) for r in op_roles
    )
    scoped = {r.scope_id for r in op_roles if r.scope_type == "tatami"}
    no_operator = [tt for tt in tatamis if tt.id not in scoped]
    if no_operator:
        issues.append(
            _issue(
                "TATAMI_WITHOUT_OPERATOR",
                "info" if general_ops else "warning",
                f"{_n(len(no_operator), 'tatami', 'tatamis')} sin operador de mesa asignado"
                + (" (hay operadores de todo el torneo que pueden cubrirlos)" if general_ops else ""),
                [tt.name or f"Tatami {tt.number}" for tt in no_operator],
                tatami_ids=[tt.id for tt in no_operator],
            )
        )
    used = {c.tatami_id for c in with_bracket if c.tatami_id}
    idle = [tt for tt in tatamis if tt.id not in used]
    if idle and with_bracket:
        issues.append(
            _issue(
                "TATAMI_WITHOUT_CATEGORIES",
                "info",
                f"{_n(len(idle), 'tatami', 'tatamis')} sin categorías en su cola",
                [tt.name or f"Tatami {tt.number}" for tt in idle],
                tatami_ids=[tt.id for tt in idle],
            )
        )

    minors = db.scalars(
        select(Registration).where(
            Registration.tournament_id == tid,
            Registration.status == "active",
            Registration.person_id.is_not(None),
            Registration.age_at_reference.is_not(None),
            Registration.age_at_reference < 18,
        )
    ).all()
    if minors:
        with_consent = set(
            db.scalars(
                select(DataConsent.person_id).where(DataConsent.person_id.in_({r.person_id for r in minors}))
            ).all()
        )
        missing = {r.person_id: r for r in minors if r.person_id not in with_consent}
        if missing:
            issues.append(
                _issue(
                    "MINOR_WITHOUT_CONSENT",
                    "warning",
                    f"{_n(len(missing), 'menor de edad inscrito', 'menores de edad inscritos')}"
                    " sin consentimiento de datos registrado (Ley 29733)",
                    sorted(f"{r.person.first_names} {r.person.last_names}" for r in missing.values() if r.person),
                    registration_ids=[r.id for r in missing.values()],
                )
            )
    from app.services.checkin import readiness_issues  # acreditación y pesaje

    issues.extend(readiness_issues(db, t))
    issues.sort(key=lambda i: SEVERITY_ORDER[i["severity"]])
    return {
        "tournament_id": tid,
        "ready": not any(i["severity"] == "error" for i in issues),
        "issues": issues,
    }


# ---------------------------------------------------------------------------
# Importación: corregir una fila en la vista previa
# ---------------------------------------------------------------------------

EDITABLE = {k for k, _ in COLUMNS}


# Los roles se guardan con su código; para revalidar vuelven a la palabra de la planilla.
ROLE_TEXT = {"competitor": "competidor", "referee": "árbitro", "sensei": "sensei"}


def _as_text(v: Any, key: str = "") -> Any:
    if isinstance(v, list):
        return ", ".join(ROLE_TEXT.get(str(x), str(x)) if key == "rol" else str(x) for x in v)
    return v


def update_import_row(db: Session, user: User, bid: int, row_id: int, changes: dict[str, Any]) -> ImportBatch:
    """Corrige celdas de una fila y la vuelve a validar como al subir el archivo
    (errores, posibles duplicados y categorías sugeridas)."""
    batch = get_batch(db, bid)
    if batch.status != "preview":
        raise InvalidState("La importación ya no está en vista previa")
    row = db.get(ImportRow, row_id)
    if row is None or row.batch_id != bid:
        raise NotFound("Fila no encontrada en esta importación")
    t = get_tournament(db, batch.tournament_id)
    rec: dict[str, Any] = {k: _as_text(row.data.get(k, ""), k) for k in EDITABLE}
    rec.update({k: _as_text(v, k) if v is not None else "" for k, v in changes.items() if k in EDITABLE})
    before = {k: row.data.get(k) for k in changes if k in EDITABLE}
    data, errors = _validate_row(rec)
    dups: list[dict[str, Any]] = []
    suggested: list[int] = []
    if not errors:
        bd = date.fromisoformat(data["fecha_nacimiento"]) if data["fecha_nacimiento"] else None
        found = people.detect_duplicates(
            db,
            data["nombres"],
            data["apellidos"],
            bd,
            data["tipo_documento"] or None,
            data["numero_documento"] or None,
        )
        dups = [d.model_dump(mode="json") for d in found]
        key = (people.normalize_name(f"{data['nombres']} {data['apellidos']}"), data["fecha_nacimiento"])
        for other in batch.rows:
            if other.id == row.id or other.status == "error":
                continue
            od = other.data
            okey = (
                people.normalize_name(f"{od.get('nombres', '')} {od.get('apellidos', '')}"),
                od.get("fecha_nacimiento"),
            )
            if okey == key and other.row_number < row.row_number:
                dups.append({"row_number": other.row_number, "reason": "same_file", "score": 1.0})
                break
        cats = db.scalars(
            select(Category).where(Category.tournament_id == t.id, Category.status.in_(("open", "empty")))
        ).all()
        rules = [rule_of(c) for c in cats]
        grade_ord = grade_to_ordinal(data["grado"]) if data["grado"] else None
        comp = Competitor(data["sexo"], bd, grade_ord, data["categoria_peso"] or None)
        if "competitor" in data["rol"]:
            for mod in data["modalidades"]:
                suggested += [int(r.id) for r in suggest_categories(comp, rules, t.age_reference_date, mod)]
        existing_dojo = people.find_dojo_by_name(db, data["dojo"]) if data["dojo"] else None
        data["dojo_id"] = existing_dojo.id if existing_dojo else None
    row.data = data
    row.errors = errors
    row.duplicates = dups
    row.suggested_category_ids = suggested
    row.status = "error" if errors else ("duplicate" if dups else "new")
    audit(
        db,
        user,
        "import",
        batch.id,
        "edit_row",
        before,
        {k: data.get(k) for k in before},
        reason=f"Fila {row.row_number} corregida en la vista previa",
        tournament_id=t.id,
    )
    db.commit()
    db.refresh(batch)
    return batch
