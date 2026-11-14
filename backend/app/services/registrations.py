from __future__ import annotations

import io
import itertools
import re
import zipfile
from datetime import date, datetime, timedelta
from typing import Any

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill
from openpyxl.worksheet.datavalidation import DataValidation
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.api import schemas as s
from app.api.errors import AppError, InvalidState, NotFound, WarningsRequireOverride
from app.db.base import utcnow
from app.db.models import (
    Category,
    DojoMembership,
    GradeRecord,
    ImportBatch,
    ImportRow,
    Match,
    Person,
    PersonRole,
    Registration,
    Tournament,
    User,
)
from app.domain.categories import (
    CategoryRule,
    Competitor,
    competition_age,
    grade_to_ordinal,
    registration_warnings,
    suggest_categories,
)
from app.domain.errors import DomainError
from app.services import people
from app.services.audit import apply_warnings, audit, bump, check_version, snapshot
from app.services.tournaments import get_category, get_tournament, refresh_category_status

OPEN_FOR_REGISTRATION = ("draft", "registration_open", "registration_closed", "in_progress")


def rule_of(c: Category) -> CategoryRule:
    return CategoryRule(
        str(c.id),
        c.modality,
        c.sex,
        c.age_min,
        c.age_max,
        c.grade_min,
        c.grade_max,
        c.weight_class,
        c.is_team,
    )


def _warnings(
    p: Person, grade_ord: int | None, weight: str | None, c: Category, t: Tournament, age: int | None = None
) -> list[dict[str, str]]:
    comp = Competitor(p.sex, p.birth_date, grade_ord, weight, age=age)
    ws = [
        {"code": w.code, "message": w.message}
        for w in registration_warnings(comp, rule_of(c), t.age_reference_date, t.age_mode or "date")
    ]
    if t.status not in ("draft", "registration_open"):
        ws.append({"code": "REGISTRATION_CLOSED", "message": "Las inscripciones del torneo están cerradas"})
    if c.status not in ("open", "empty"):
        ws.append({"code": "CATEGORY_NOT_OPEN", "message": f"La categoría está en estado {c.status}"})
    return ws


def capacity_warnings(db: Session, c: Category) -> list[dict[str, str]]:
    """Cupo de la categoría (``max_entrants``): al superarlo se advierte."""
    if not c.max_entrants:
        return []
    from app.services.tournaments import entrant_count

    n = entrant_count(db, c.id)
    if n < c.max_entrants:
        return []
    return [
        {
            "code": "CATEGORY_FULL",
            "message": f"La categoría ya tiene {n} inscritos para un cupo de {c.max_entrants}: considera dividirla",
        }
    ]


def registration_out(r: Registration) -> s.RegistrationOut:
    from app.services.teams import members_out

    out = s.RegistrationOut.model_validate(r)
    out.person_name = r.display_name
    out.dojo_name = r.dojo.name if r.dojo else ""
    if r.team is not None:
        out.team_version = r.team.version
        out.team_members = members_out(r.team)
    return out


def create_registration(
    db: Session, user: User, tid: int, data: s.RegistrationCreate, *, commit: bool = True
) -> Registration:
    t = get_tournament(db, tid)
    if t.status not in OPEN_FOR_REGISTRATION:
        raise InvalidState(f"El torneo está en estado {t.status}")
    c = get_category(db, data.category_id)
    if c.tournament_id != tid:
        raise InvalidState("La categoría no pertenece al torneo")
    if c.status in ("merged", "cancelled"):
        raise InvalidState("La categoría está fusionada o cancelada; inscribe en la categoría destino")
    if c.is_team:
        raise InvalidState("La categoría es por equipos: inscribe un equipo", code="TEAM_CATEGORY")
    p = people.get_person(db, data.person_id)
    if p.merged_into_id:
        raise InvalidState("La persona fue fusionada; usa la persona conservada", details={"use": p.merged_into_id})
    dup = db.scalar(
        select(Registration).where(
            Registration.category_id == c.id, Registration.person_id == p.id, Registration.status == "active"
        )
    )
    if dup:
        raise InvalidState("La persona ya está inscrita en esta categoría", code="ALREADY_REGISTERED")

    # Foto al momento del torneo: dojo y grado vigentes a la fecha de referencia.
    m = people.current_membership(db, p.id, t.start_date)
    dojo_id = data.dojo_id or (m.dojo_id if m else people.independent_dojo(db).id)
    branch_id = data.branch_id if data.dojo_id else (m.branch_id if m else None)
    if data.grade:
        grade = data.grade
    else:
        g = people.current_grade(db, p.id, t.start_date)
        grade = g.grade if g else None
    grade_ord = grade_to_ordinal(grade) if grade else None

    r = Registration(
        tournament_id=tid,
        category_id=c.id,
        original_category_id=c.id,
        person_id=p.id,
        dojo_id=dojo_id,
        branch_id=branch_id,
        grade=grade,
        grade_ordinal=grade_ord,
        weight_class=data.weight_class,
        age_at_reference=competition_age(p.birth_date, t.age_reference_date, t.age_mode or "date")
        if p.birth_date
        else data.age,
        seed=data.seed,
        updated_by_id=user.id,
    )
    db.add(r)
    ws = _warnings(p, grade_ord, data.weight_class, c, t, data.age) + capacity_warnings(db, c)
    apply_warnings(db, user, ws, data.override.reason if data.override else None, "registration", lambda: r.id)
    db.flush()
    refresh_category_status(db, c)
    audit(db, user, "registration", r.id, "create", after=snapshot(r), tournament_id=tid)
    if commit:
        db.commit()
        db.refresh(r)
    return r


def update_registration(db: Session, user: User, rid: int, data: s.RegistrationUpdate) -> Registration:
    r = get_registration(db, rid)
    check_version(r, data.version, "La inscripción")
    t = get_tournament(db, r.tournament_id)
    before = snapshot(r)
    old_cat = get_category(db, r.category_id)
    changes = data.model_dump(exclude_unset=True, exclude={"version", "override"})
    if "grade" in changes:
        r.grade = changes["grade"]
        r.grade_ordinal = grade_to_ordinal(r.grade) if r.grade else None
    for f in ("weight_class", "dojo_id", "seed"):
        if f in changes:
            setattr(r, f, changes[f])
    new_cat = old_cat
    if changes.get("category_id") and changes["category_id"] != r.category_id:
        new_cat = get_category(db, changes["category_id"])
        if new_cat.tournament_id != r.tournament_id or new_cat.status in ("merged", "cancelled"):
            raise InvalidState("Categoría destino inválida")
        if new_cat.is_team != old_cat.is_team:
            raise InvalidState("No se mueve una inscripción entre categorías individuales y por equipos")
        if old_cat.status == "finished":
            raise InvalidState("La categoría actual ya terminó; no se mueve la inscripción")
        if new_cat.status == "finished":
            raise InvalidState("La categoría destino ya terminó")
        if r.status != "active":
            raise InvalidState("La inscripción está retirada")
        if r.person_id and db.scalar(
            select(Registration.id).where(
                Registration.category_id == new_cat.id,
                Registration.person_id == r.person_id,
                Registration.status == "active",
                Registration.id != r.id,
            )
        ):
            raise InvalidState("La persona ya está inscrita en esa categoría", code="ALREADY_REGISTERED")
    ws: list[dict[str, str]] = []
    move_ws: list[dict[str, str]] = []
    if new_cat is not old_cat:
        from app.services import bracket_changes

        # Cambio de categoría el día del torneo: con llave generada se sale de
        # la llave de origen (bye o walkover) y se entra a la de destino (bye
        # libre). Se advierte y requiere override.
        move_ws = bracket_changes.move_warnings(db, old_cat, new_cat)
    if r.person:
        skip = {"REGISTRATION_CLOSED"} | ({"CATEGORY_NOT_OPEN"} if move_ws else set())
        ws = [w for w in _warnings(r.person, r.grade_ordinal, r.weight_class, new_cat, t) if w["code"] not in skip]
    apply_warnings(
        db, user, ws + move_ws, data.override.reason if data.override else None, "registration", lambda: r.id
    )
    if new_cat is not old_cat:
        if move_ws:
            reason = data.override.reason if data.override else "Cambio de categoría"
            bracket_changes.move_between_brackets(db, user, r, old_cat, new_cat, reason)
        else:
            r.category_id = new_cat.id
    bump(r, user)
    refresh_category_status(db, old_cat)
    refresh_category_status(db, new_cat)
    audit(db, user, "registration", r.id, "update", before, snapshot(r), tournament_id=r.tournament_id)
    db.commit()
    db.refresh(r)
    return r


def get_registration(db: Session, rid: int) -> Registration:
    r = db.get(Registration, rid)
    if r is None:
        raise NotFound("Inscripción no encontrada")
    return r


def withdraw(db: Session, user: User, rid: int, reason: str, version: int | None = None) -> dict[str, Any]:
    """Marca retirada. Si ya tiene llave, informa las opciones: regenerar (si
    no empezó) o walkover en su combate pendiente.
    """
    r = get_registration(db, rid)
    check_version(r, version, "La inscripción")
    if r.status == "withdrawn":
        raise InvalidState("La inscripción ya está retirada")
    r.status, r.withdrawn_reason = "withdrawn", reason
    bump(r, user)
    c = get_category(db, r.category_id)
    refresh_category_status(db, c)
    audit(db, user, "registration", r.id, "withdraw", reason=reason, tournament_id=r.tournament_id)
    pending = db.scalars(
        select(Match).where(
            Match.category_id == c.id,
            Match.is_current,
            Match.parent_match_id.is_(None),
            Match.status.in_(("pending", "ready", "in_progress")),
            (Match.aka_registration_id == r.id) | (Match.ao_registration_id == r.id),
        )
    ).all()
    started = db.scalar(
        select(Match.id).where(
            Match.category_id == c.id, Match.is_current, Match.status.in_(("in_progress", "finished"))
        )
    )
    db.commit()
    options: list[str] = []
    if c.status in ("ready", "in_progress"):
        options = ["walkover"] if started else ["regenerate", "walkover"]
    return {"registration_id": r.id, "options": options, "pending_match_ids": [m.id for m in pending]}


def suggestions(
    db: Session, tid: int, person_id: int, modality: str | None = None, weight_class: str | None = None
) -> list[Category]:
    """Categorías compatibles. Con peso declarado se filtra por peso; sin él,
    se sugieren las compatibles en todo lo demás (igual que la importación)."""
    t = get_tournament(db, tid)
    p = people.get_person(db, person_id)
    g = people.current_grade(db, p.id, t.start_date)
    comp = Competitor(p.sex, p.birth_date, g.grade_ordinal if g else None, weight_class or None)
    cats = db.scalars(
        select(Category).where(Category.tournament_id == tid, Category.status.in_(("open", "empty")))
    ).all()
    by_id = {str(c.id): c for c in cats}
    rules = [rule_of(c) for c in cats]
    return [by_id[r.id] for r in suggest_categories(comp, rules, t.age_reference_date, modality, t.age_mode or "date")]


# ---------------------------------------------------------------------------
# Importación desde Excel (sección 14)
# ---------------------------------------------------------------------------

COLUMNS = [
    ("dojo", "Dojo"),
    ("sede", "Sede"),
    ("tipo_documento", "Tipo documento (DNI, CE, PASSPORT, OTHER)"),
    ("numero_documento", "Número documento"),
    ("nombres", "Nombres"),
    ("apellidos", "Apellidos"),
    ("fecha_nacimiento", "Fecha nacimiento (dd/mm/aaaa)"),
    ("sexo", "Sexo (M/F)"),
    ("grado", "Grado (p. ej. 8 kyu, 1 dan)"),
    ("categoria_peso", "Categoría de peso (p. ej. -45)"),
    ("modalidades", "Modalidades (kumite, kata)"),
    ("rol", "Rol (competidor, árbitro, sensei)"),
    # Al final para no mover las columnas de los archivos ya repartidos.
    ("edad", "Edad (si no hay fecha de nacimiento)"),
]

# Rol de la fila: vacío = competidor (compatibilidad con archivos anteriores).
ROLE_WORDS = {
    "competidor": "competitor",
    "competidora": "competitor",
    "arbitro": "referee",
    "árbitro": "referee",
    "arbitra": "referee",
    "árbitra": "referee",
    "juez": "referee",
    "sensei": "sensei",
}


def excel_template() -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = "Inscripciones"
    for i, (_, label) in enumerate(COLUMNS, start=1):
        cell = ws.cell(row=1, column=i, value=label)
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="B91C1C")
        ws.column_dimensions[cell.column_letter].width = max(14, len(label) + 2)
    ws.append(
        [
            "Dojo Ejemplo",
            "",
            "DNI",
            "71234567",
            "Ana María",
            "Pérez Soto",
            "15/03/2013",
            "F",
            "8 kyu",
            "-40",
            "kumite, kata",
            "competidor",
            "",
        ]
    )
    dv = DataValidation(type="list", formula1='"M,F"', allow_blank=False)
    ws.add_data_validation(dv)
    dv.add("H2:H2000")
    dv2 = DataValidation(type="list", formula1='"DNI,CE,PASSPORT,OTHER"', allow_blank=True)
    ws.add_data_validation(dv2)
    dv2.add("C2:C2000")
    info = wb.create_sheet("Instrucciones")
    info.append(["Una fila por competidor. La fila 2 es un ejemplo: bórrela antes de subir el archivo."])
    info.append(["El documento es opcional; sin documento la persona queda con identidad incompleta."])
    info.append(["Modalidades: kumite, kata o ambas separadas por coma."])
    info.append(["Rol: competidor (por defecto), árbitro o sensei; puede ir más de uno separado por coma."])
    info.append(["Un árbitro no necesita dojo ni modalidades; un sensei queda registrado en su dojo."])
    info.append(["Edad: solo si no se conoce la fecha de nacimiento; sirve para sugerir la categoría."])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _parse_date(v: Any) -> date | None:
    if v is None or v == "":
        return None
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    txt = str(v).strip()
    for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y", "%d.%m.%Y"):
        try:
            return datetime.strptime(txt, fmt).date()
        except ValueError:
            continue
    raise DomainError(f"Fecha inválida: {txt}")


def _cell(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v).strip()


MAX_IMPORT_ROWS = 2000
MAX_UNCOMPRESSED = 50 * 1024 * 1024


def parse_excel(content: bytes) -> list[dict[str, Any]]:
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as zf:
            if sum(i.file_size for i in zf.infolist()) > MAX_UNCOMPRESSED:
                raise AppError("El archivo es demasiado grande al descomprimir", code="FILE_TOO_LARGE")
        wb = load_workbook(io.BytesIO(content), data_only=True, read_only=True)
    except AppError:
        raise
    except Exception as e:  # noqa: BLE001 - cualquier archivo corrupto
        raise AppError("El archivo no es un Excel válido (.xlsx)", code="INVALID_FILE") from e
    ws = wb.worksheets[0]
    rows = list(itertools.islice(ws.iter_rows(values_only=True), MAX_IMPORT_ROWS + 1))
    if not rows:
        return []
    out = []
    for n, raw in enumerate(rows[1:], start=2):
        if raw is None or all(v in (None, "") for v in raw):
            continue
        rec: dict[str, Any] = {"_row": n}
        for i, (key, _) in enumerate(COLUMNS):
            v = raw[i] if i < len(raw) else None
            rec[key] = v if key == "fecha_nacimiento" else _cell(v)
        out.append(rec)
    return out


def _validate_row(rec: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    errors: list[str] = []
    data: dict[str, Any] = {k: rec.get(k, "") for k, _ in COLUMNS}
    if not data["nombres"]:
        errors.append("Falta nombres")
    if not data["apellidos"]:
        errors.append("Falta apellidos")
    sex = str(data["sexo"]).upper()[:1]
    if sex not in ("M", "F"):
        errors.append("Sexo debe ser M o F")
    data["sexo"] = sex
    try:
        bd = _parse_date(rec.get("fecha_nacimiento"))
        data["fecha_nacimiento"] = bd.isoformat() if bd else ""
    except ValueError as e:
        errors.append(str(e))
        data["fecha_nacimiento"] = _cell(rec.get("fecha_nacimiento"))
    if data["grado"]:
        try:
            grade_to_ordinal(data["grado"])
        except ValueError as e:
            errors.append(str(e))
    edad = re.sub(r"\s*a[ñn]os?\s*$", "", str(data.get("edad") or ""), flags=re.IGNORECASE).strip()
    if edad and not (edad.isdigit() and 0 <= int(edad) <= 99):
        errors.append("Edad inválida (un número de años)")
    data["edad"] = int(edad) if edad.isdigit() else ""
    doc_type = str(data["tipo_documento"]).upper()
    if data["numero_documento"] and doc_type not in ("DNI", "CE", "PASSPORT", "OTHER"):
        errors.append("Tipo de documento inválido")
    if data["numero_documento"] and not doc_type:
        doc_type = "DNI"
    data["tipo_documento"] = doc_type if data["numero_documento"] else ""
    if doc_type == "DNI" and data["numero_documento"] and not str(data["numero_documento"]).isdigit():
        errors.append("El DNI debe tener solo dígitos")
    mods = [m.strip().lower() for m in str(data["modalidades"]).replace(";", ",").split(",") if m.strip()]
    bad = [m for m in mods if m not in ("kumite", "kata")]
    if bad:
        errors.append(f"Modalidad inválida: {', '.join(bad)}")
    data["modalidades"] = [m for m in mods if m in ("kumite", "kata")]
    words = [w.strip().lower() for w in str(data.get("rol") or "").replace(";", ",").split(",") if w.strip()]
    unknown = [w for w in words if w not in ROLE_WORDS]
    if unknown:
        errors.append(f"Rol inválido: {', '.join(unknown)}")
    roles = sorted({ROLE_WORDS[w] for w in words if w in ROLE_WORDS}) or ["competitor"]
    data["rol"] = roles
    if not data["dojo"] and ("competitor" in roles or "sensei" in roles):
        errors.append("Falta dojo (use 'Independiente' si no tiene)")
    return data, errors


def create_import_preview(db: Session, user: User, tid: int, filename: str, content: bytes) -> ImportBatch:
    t = get_tournament(db, tid)
    records = parse_excel(content)
    if not records:
        raise AppError("El archivo no tiene filas de datos", code="EMPTY_FILE")
    batch = ImportBatch(tournament_id=tid, filename=filename, updated_by_id=user.id)
    db.add(batch)
    db.flush()
    cats = db.scalars(
        select(Category).where(Category.tournament_id == tid, Category.status.in_(("open", "empty")))
    ).all()
    rules = [rule_of(c) for c in cats]
    seen_in_file: dict[tuple[str, str], int] = {}
    for rec in records:
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
            if key in seen_in_file:
                dups.append({"row_number": seen_in_file[key], "reason": "same_file", "score": 1.0})
            seen_in_file.setdefault(key, rec["_row"])
            grade_ord = grade_to_ordinal(data["grado"]) if data["grado"] else None
            comp = Competitor(data["sexo"], bd, grade_ord, data["categoria_peso"] or None, age=data["edad"] or None)
            if "competitor" in data["rol"]:
                for mod in data["modalidades"]:
                    matches = suggest_categories(comp, rules, t.age_reference_date, mod, t.age_mode or "date")
                    suggested += [int(r.id) for r in matches]
                    # Sin peso: se sugieren igual las de kumite compatibles en lo
                    # demás, con aviso para confirmar la categoría de peso.
                    if mod == "kumite" and not data["categoria_peso"]:
                        weighted = [r for r in matches if r.weight_class]
                        if weighted:
                            data.setdefault("avisos", []).append(
                                "Sin categoría de peso: confirma la categoría de kumite sugerida"
                            )
            existing_dojo = people.find_dojo_by_name(db, data["dojo"]) if data["dojo"] else None
            data["dojo_id"] = existing_dojo.id if existing_dojo else None
        status = "error" if errors else ("duplicate" if dups else "new")
        db.add(
            ImportRow(
                batch_id=batch.id,
                row_number=rec["_row"],
                data=data,
                status=status,
                errors=errors,
                duplicates=dups,
                suggested_category_ids=suggested,
            )
        )
    audit(db, user, "import", batch.id, "preview", after={"rows": len(records), "file": filename}, tournament_id=tid)
    db.commit()
    db.refresh(batch)
    return batch


def get_batch(db: Session, bid: int) -> ImportBatch:
    b = db.get(ImportBatch, bid)
    if b is None:
        raise NotFound("Importación no encontrada")
    return b


def _import_roles(db: Session, person_id: int, roles: list[str], tid: int, dojo_id: int | None) -> None:
    """Árbitro del torneo y sensei de su dojo, sin duplicar roles existentes."""
    wanted = []
    if "referee" in roles:
        wanted.append(("referee", "tournament", tid))
    if "sensei" in roles and dojo_id:
        wanted.append(("sensei", "dojo", dojo_id))
    for role, scope, sid in wanted:
        exists = db.scalar(
            select(PersonRole.id).where(
                PersonRole.person_id == person_id,
                PersonRole.role == role,
                ((PersonRole.scope_type == scope) & (PersonRole.scope_id == sid)) | (PersonRole.scope_type == "global"),
            )
        )
        if not exists:
            db.add(PersonRole(person_id=person_id, role=role, scope_type=scope, scope_id=sid))


def confirm_import(db: Session, user: User, bid: int, data: s.ImportConfirm) -> dict[str, Any]:
    """Crea personas, vínculos con dojo e inscripciones en una sola transacción.
    Si algo falla, no se guarda nada.
    """
    batch = get_batch(db, bid)
    if batch.status != "preview":
        raise InvalidState("La importación ya fue confirmada o cancelada")
    t = get_tournament(db, batch.tournament_id)
    decisions = {d.row_id: d for d in data.decisions}
    override = data.override.reason if data.override else None
    created_people = registrations = skipped = 0
    row_warnings: list[dict[str, str]] = []
    try:
        for row in batch.rows:
            d = decisions.get(row.id)
            if row.status == "error" or (d and d.action == "skip"):
                row.resolution = {"action": "skip"}
                skipped += 1
                continue
            if d is None and row.status == "duplicate":
                # Sin decisión explícita, un posible duplicado se omite para no
                # crear personas repetidas en silencio.
                row_warnings.append(
                    {
                        "code": "UNRESOLVED_DUPLICATE",
                        "message": f"Fila {row.row_number}: posible duplicado sin decisión; se omitirá",
                    }
                )
                row.resolution = {"action": "skip", "reason": "unresolved_duplicate"}
                skipped += 1
                continue
            rd = row.data
            bd = date.fromisoformat(rd["fecha_nacimiento"]) if rd["fecha_nacimiento"] else None
            roles = rd.get("rol") or ["competitor"]
            dojo_id = rd.get("dojo_id")
            if not dojo_id and rd["dojo"]:
                existing = people.find_dojo_by_name(db, rd["dojo"])
                dojo_id = existing.id if existing else people.create_dojo_nocommit(db, user, rd["dojo"]).id
            if d and d.action == "use_existing":
                if not d.person_id:
                    raise InvalidState(f"Fila {row.row_number}: falta la persona existente")
                person = people.get_person(db, d.person_id)
                m = people.current_membership(db, person.id, t.start_date)
                if dojo_id and (m is None or m.dojo_id != dojo_id):
                    if m:
                        m.end_date = t.start_date
                    db.add(DojoMembership(person_id=person.id, dojo_id=dojo_id, start_date=t.start_date))
                if rd["grado"]:
                    g = people.current_grade(db, person.id, t.start_date)
                    if g is None or g.grade_ordinal != grade_to_ordinal(rd["grado"]):
                        db.add(
                            GradeRecord(
                                person_id=person.id,
                                grade=rd["grado"],
                                grade_ordinal=grade_to_ordinal(rd["grado"]),
                                awarded_on=t.start_date,
                            )
                        )
            else:
                pc = s.PersonCreate(
                    first_names=rd["nombres"],
                    last_names=rd["apellidos"],
                    birth_date=bd,
                    sex=rd["sexo"],
                    document=s.DocumentIn(doc_type=rd["tipo_documento"], number=rd["numero_documento"])
                    if rd["numero_documento"]
                    else None,
                    dojo_id=dojo_id,
                    grade=rd["grado"] or None,
                    override=s.Override(reason=f"Importación {batch.filename}, fila {row.row_number}"),
                )
                try:
                    person = people.create_person(db, user, pc, commit=False)
                except InvalidState as e:
                    if e.code != "DUPLICATE_DOCUMENT":
                        raise
                    raise InvalidState(
                        f"Fila {row.row_number}: el documento ya pertenece a otra persona; "
                        "elija 'usar existente' u 'omitir'",
                        code="DUPLICATE_DOCUMENT",
                        details={**e.details, "row_id": row.id, "row_number": row.row_number},
                    ) from e
                created_people += 1
            db.flush()
            _import_roles(db, person.id, roles, t.id, dojo_id)
            cat_ids = d.category_ids if d and d.category_ids else row.suggested_category_ids
            if "competitor" not in roles:
                cat_ids = []
            for cid in cat_ids:
                try:
                    create_registration(
                        db,
                        user,
                        t.id,
                        s.RegistrationCreate(
                            person_id=person.id,
                            category_id=cid,
                            dojo_id=dojo_id,
                            weight_class=rd["categoria_peso"] or None,
                            age=rd.get("edad") or None,
                            override=s.Override(reason=override) if override else None,
                        ),
                        commit=False,
                    )
                    registrations += 1
                except WarningsRequireOverride as w:
                    for x in w.details["warnings"]:
                        row_warnings.append({"code": x["code"], "message": f"Fila {row.row_number}: {x['message']}"})
                except InvalidState as e:
                    if e.code != "ALREADY_REGISTERED":
                        raise
            row.resolution = {"action": d.action if d else "create", "person_id": person.id, "category_ids": cat_ids}
        if row_warnings and not override:
            raise WarningsRequireOverride(row_warnings, "La importación tiene advertencias")
        batch.status = "confirmed"
        purge_batch_rows(batch)
        audit(
            db,
            user,
            "import",
            batch.id,
            "confirm",
            after={"people": created_people, "registrations": registrations, "skipped": skipped},
            reason=override,
            tournament_id=t.id,
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return {"created_people": created_people, "registrations": registrations, "skipped": skipped}


def cancel_import(db: Session, user: User, bid: int) -> None:
    batch = get_batch(db, bid)
    if batch.status != "preview":
        raise InvalidState("La importación ya no está en vista previa")
    batch.status = "cancelled"
    purge_batch_rows(batch)
    audit(db, user, "import", batch.id, "cancel", tournament_id=batch.tournament_id)
    db.commit()


# Datos sensibles de las filas de importación: solo hacen falta mientras la
# vista previa está abierta (detectar duplicados y crear personas).
SENSITIVE_ROW_FIELDS = ("tipo_documento", "numero_documento", "fecha_nacimiento")
IMPORT_RETENTION_DAYS = 30


def purge_batch_rows(batch: ImportBatch) -> None:
    """Quita DNI y fecha de nacimiento de las filas al confirmar o cancelar.

    Las filas se conservan (nombre, dojo, estado y decisión tomada) para que el
    organizador vea el resultado de la importación; los datos sensibles ya
    viven, si corresponde, en la ficha de la persona.
    """
    for row in batch.rows:
        if row.data and not row.data.get("redacted"):
            row.data = {**{k: v for k, v in row.data.items() if k not in SENSITIVE_ROW_FIELDS}, "purged": True}
        if row.duplicates:
            row.duplicates = [{k: v for k, v in d.items() if k != "birth_date"} for d in row.duplicates]


def purge_old_imports(db: Session, days: int = IMPORT_RETENTION_DAYS) -> dict[str, int]:
    """Borra las filas de las importaciones de hace más de ``days`` días.

    Una vista previa abandonada tanto tiempo se da por cancelada. El lote
    (nombre del archivo, estado) y su auditoría se conservan.
    """
    limit = utcnow() - timedelta(days=days)
    old = db.scalars(select(ImportBatch).where(ImportBatch.created_at < limit)).all()
    ids = [b.id for b in old]
    expired = 0
    for b in old:
        if b.status == "preview":
            b.status = "cancelled"
            audit(db, None, "import", b.id, "expire", tournament_id=b.tournament_id)
            expired += 1
    rows = 0
    if ids:
        rows = db.execute(delete(ImportRow).where(ImportRow.batch_id.in_(ids))).rowcount or 0
    db.commit()
    return {"batches": len(ids), "rows": rows, "expired_previews": expired}
