"""Plantillas de categorías: edición, duplicado, archivo e intercambio con Excel.

Una plantilla se copia al torneo al generar sus categorías; cambiarla después
no toca los torneos que ya la usaron. Por eso una plantilla usada no se borra:
se archiva (deja de ofrecerse para torneos nuevos).
"""

from __future__ import annotations

import io
import itertools
import zipfile
from typing import Any

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill
from openpyxl.worksheet.datavalidation import DataValidation
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api import schemas as s
from app.api.deps import is_staff
from app.api.errors import AppError, Forbidden, InvalidState, NotFound
from app.db.models import CategoryTemplate, TemplateCategory, Tournament, User
from app.domain.categories import grade_to_ordinal, ordinal_to_grade
from app.services.audit import audit, bump, check_version

FIELDS = list(s.CategoryFields.model_fields)


def can_edit_template(db: Session, user: User, tpl: CategoryTemplate | None = None) -> bool:
    """Quién edita plantillas: el Admin Global y los organizadores.

    Punto único para extender: cuando las plantillas tengan organización
    (``organization_id``), un organizador solo editará las de la suya; el
    Admin, todas. ``tpl=None`` pregunta si puede crear una plantilla nueva.
    """
    if user.is_admin:
        return True
    return is_staff(db, user)


def ensure_can_edit(db: Session, user: User, tpl: CategoryTemplate | None = None) -> None:
    if not can_edit_template(db, user, tpl):
        raise Forbidden("Solo el Admin y los organizadores editan plantillas")


def get_template(db: Session, template_id: int) -> CategoryTemplate:
    t = db.get(CategoryTemplate, template_id)
    if t is None:
        raise NotFound("Plantilla no encontrada")
    return t


def used_template_ids(db: Session) -> set[int]:
    return set(db.scalars(select(Tournament.template_id).where(Tournament.template_id.is_not(None))).all())


def template_out(db: Session, t: CategoryTemplate, user: User, used: set[int] | None = None) -> s.TemplateOut:
    out = s.TemplateOut.model_validate(t)
    out.in_use = t.id in (used if used is not None else used_template_ids(db))
    out.can_edit = can_edit_template(db, user, t)
    return out


def _check_codes(items: list[dict[str, Any]]) -> None:
    seen: set[str] = set()
    for it in items:
        code = (it.get("code") or "").strip()
        if not code:
            raise InvalidState("Cada categoría necesita un código")
        if code in seen:
            raise InvalidState(f"El código {code} está repetido en la plantilla", code="DUPLICATE_CODE")
        seen.add(code)


def _touch(t: CategoryTemplate, user: User) -> None:
    bump(t, user)


def update_template(db: Session, user: User, tpl_id: int, data: s.TemplateUpdate) -> CategoryTemplate:
    t = get_template(db, tpl_id)
    ensure_can_edit(db, user, t)
    check_version(t, data.version, "La plantilla")
    changes = data.model_dump(exclude_unset=True, exclude={"version"})
    before = {k: getattr(t, k) for k in changes}
    for k, v in changes.items():
        setattr(t, k, v.strip() if isinstance(v, str) and k == "name" else v)
    _touch(t, user)
    audit(db, user, "template", t.id, "update", before, {k: getattr(t, k) for k in changes})
    db.commit()
    db.refresh(t)
    return t


def duplicate_template(db: Session, user: User, tpl_id: int, name: str | None) -> CategoryTemplate:
    src = get_template(db, tpl_id)
    ensure_can_edit(db, user, None)
    t = CategoryTemplate(name=(name or f"{src.name} (copia)")[:200], description=src.description, updated_by_id=user.id)
    db.add(t)
    db.flush()
    for it in src.items:
        db.add(TemplateCategory(template_id=t.id, **{f: getattr(it, f) for f in FIELDS}))
    audit(db, user, "template", t.id, "duplicate", after={"from": src.id, "items": len(src.items)})
    db.commit()
    db.refresh(t)
    return t


def delete_template(db: Session, user: User, tpl_id: int) -> dict[str, Any]:
    """Borra la plantilla si ningún torneo la usó; si no, la archiva."""
    t = get_template(db, tpl_id)
    ensure_can_edit(db, user, t)
    if t.id in used_template_ids(db):
        if not t.is_archived:
            t.is_archived = True
            _touch(t, user)
            audit(db, user, "template", t.id, "archive", reason="La usa un torneo: se archiva en lugar de borrar")
        db.commit()
        return {"id": t.id, "deleted": False, "archived": True}
    audit(db, user, "template", t.id, "delete", before={"name": t.name, "items": len(t.items)})
    for it in list(t.items):
        db.delete(it)
    db.delete(t)
    db.commit()
    return {"id": tpl_id, "deleted": True, "archived": False}


def add_item(db: Session, user: User, tpl_id: int, data: s.CategoryFields) -> TemplateCategory:
    t = get_template(db, tpl_id)
    ensure_can_edit(db, user, t)
    fields = data.model_dump()
    _check_codes([*({"code": i.code} for i in t.items), fields])
    if not fields.get("sort_order"):
        fields["sort_order"] = max((i.sort_order for i in t.items), default=-1) + 1
    it = TemplateCategory(template_id=t.id, **fields)
    db.add(it)
    _touch(t, user)
    db.flush()
    audit(db, user, "template", t.id, "add_item", after={"id": it.id, "code": it.code, "name": it.name})
    db.commit()
    db.refresh(it)
    return it


def _get_item(db: Session, tpl_id: int, item_id: int) -> TemplateCategory:
    it = db.get(TemplateCategory, item_id)
    if it is None or it.template_id != tpl_id:
        raise NotFound("Categoría de plantilla no encontrada")
    return it


def update_item(db: Session, user: User, tpl_id: int, item_id: int, data: s.TemplateItemUpdate) -> TemplateCategory:
    t = get_template(db, tpl_id)
    ensure_can_edit(db, user, t)
    it = _get_item(db, tpl_id, item_id)
    changes = data.model_dump(exclude_unset=True)
    for req in ("code", "name", "modality", "sex", "is_team", "sort_order"):
        if req in changes and changes[req] is None:
            raise InvalidState(f"El campo {req} no puede quedar vacío")
    if "code" in changes:
        _check_codes([*({"code": i.code} for i in t.items if i.id != it.id), {"code": changes["code"]}])
    before = {k: getattr(it, k) for k in changes}
    for k, v in changes.items():
        setattr(it, k, v)
    _touch(t, user)
    audit(db, user, "template", t.id, "update_item", before, {k: getattr(it, k) for k in changes})
    db.commit()
    db.refresh(it)
    return it


def delete_item(db: Session, user: User, tpl_id: int, item_id: int) -> None:
    t = get_template(db, tpl_id)
    ensure_can_edit(db, user, t)
    it = _get_item(db, tpl_id, item_id)
    audit(db, user, "template", t.id, "delete_item", before={"id": it.id, "code": it.code, "name": it.name})
    db.delete(it)
    _touch(t, user)
    db.commit()


def replace_items(db: Session, user: User, tpl_id: int, data: s.TemplateItemsReplace) -> CategoryTemplate:
    """Edición en tabla: guarda todas las filas de una vez (todo o nada).

    Filas con ``id`` se actualizan, sin ``id`` se crean y las que ya no vienen
    se borran. El orden de la lista es el orden de la plantilla.
    """
    t = get_template(db, tpl_id)
    ensure_can_edit(db, user, t)
    check_version(t, data.version, "La plantilla")
    rows = [r.model_dump() for r in data.items]
    _check_codes(rows)
    current = {i.id: i for i in t.items}
    unknown = [r["id"] for r in rows if r["id"] is not None and r["id"] not in current]
    if unknown:
        raise NotFound(f"La fila {unknown[0]} no es de esta plantilla")
    keep = {r["id"] for r in rows if r["id"] is not None}
    removed = [i for i in current.values() if i.id not in keep]
    for i in removed:
        db.delete(i)
    created = updated = 0
    for pos, r in enumerate(rows):
        fields = {f: r[f] for f in FIELDS}
        fields["sort_order"] = pos
        if r["id"] is None:
            db.add(TemplateCategory(template_id=t.id, **fields))
            created += 1
        else:
            it = current[r["id"]]
            if any(getattr(it, f) != v for f, v in fields.items()):
                for f, v in fields.items():
                    setattr(it, f, v)
                updated += 1
    _touch(t, user)
    audit(
        db,
        user,
        "template",
        t.id,
        "replace_items",
        after={"created": created, "updated": updated, "deleted": len(removed), "items": len(rows)},
    )
    db.commit()
    db.expire(t)
    db.refresh(t)
    return t


# ---------------------------------------------------------------------------
# Excel
# ---------------------------------------------------------------------------

# Columnas de la hoja: (campo, encabezado). Los grados van como texto («8 kyu»).
EXCEL_COLUMNS = [
    ("code", "Código"),
    ("name", "Nombre"),
    ("modality", "Modalidad (kumite/kata)"),
    ("is_team", "Equipos (sí/no)"),
    ("sex", "Sexo (M/F/X)"),
    ("age_min", "Edad mínima"),
    ("age_max", "Edad máxima"),
    ("grade_min", "Grado desde (p. ej. 10 kyu)"),
    ("grade_max", "Grado hasta (p. ej. 1 dan)"),
    ("weight_class", "Peso (p. ej. -45, +68)"),
    ("format", "Formato (single_elimination/round_robin/kata_rounds)"),
    ("third_place_rule", "Tercer lugar (two_bronzes/third_place_match/repechage)"),
    ("duration_seconds", "Duración (s)"),
    ("kata_method", "Kata: método (flags/scores)"),
    ("kata_structure", "Kata: estructura (bracket/rounds)"),
    ("kata_judges", "Kata: jueces"),
]
MAX_ROWS = 500
MAX_UNCOMPRESSED = 20 * 1024 * 1024


def _grade_text(ordinal: int | None) -> str:
    if ordinal is None:
        return ""
    return ordinal_to_grade(ordinal) if 1 <= ordinal <= 20 else str(ordinal)


def _safe(v: Any) -> Any:
    """Evita que un texto como «=HYPERLINK(...)» se interprete como fórmula."""
    if isinstance(v, str) and v[:1] in ("=", "+", "@", "\t", "\r") and not v[1:2].isdigit():
        return "'" + v
    return v


def export_excel(t: CategoryTemplate) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = "Categorías"
    for i, (_, label) in enumerate(EXCEL_COLUMNS, start=1):
        cell = ws.cell(row=1, column=i, value=label)
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="24477A")
        ws.column_dimensions[cell.column_letter].width = max(12, min(len(label) + 2, 30))
    for it in t.items:
        row = []
        for f, _ in EXCEL_COLUMNS:
            v = getattr(it, f)
            if f in ("grade_min", "grade_max"):
                v = _grade_text(v)
            elif f == "is_team":
                v = "sí" if v else "no"
            row.append(_safe(v) if v is not None else "")
        ws.append(row)
    dv = DataValidation(type="list", formula1='"kumite,kata"', allow_blank=False)
    ws.add_data_validation(dv)
    dv.add(f"C2:C{MAX_ROWS + 1}")
    dv2 = DataValidation(type="list", formula1='"M,F,X"', allow_blank=False)
    ws.add_data_validation(dv2)
    dv2.add(f"E2:E{MAX_ROWS + 1}")
    info = wb.create_sheet("Plantilla")
    info.append(["Nombre", t.name])
    info.append(["Descripción", t.description])
    info.append([])
    info.append(["Una fila por categoría. Código, nombre, modalidad y sexo son obligatorios."])
    info.append(["Las celdas vacías heredan la configuración del torneo (formato, duración, kata)."])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _txt(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v).strip().lstrip("'")


def _int(v: Any, label: str, errors: list[str], n: int) -> int | None:
    t = _txt(v)
    if not t:
        return None
    try:
        return int(float(t))
    except ValueError:
        errors.append(f"Fila {n}: {label} debe ser un número")
        return None


def parse_excel(content: bytes) -> tuple[dict[str, str], list[s.CategoryFields]]:
    """Lee la hoja «Categorías» (o la primera). Devuelve nombre/descripción (hoja
    «Plantilla», si existe) y las filas. Cualquier error aborta con la lista completa."""
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as zf:
            if sum(i.file_size for i in zf.infolist()) > MAX_UNCOMPRESSED:
                raise AppError("El archivo es demasiado grande al descomprimir", code="FILE_TOO_LARGE")
        wb = load_workbook(io.BytesIO(content), data_only=True, read_only=True)
    except AppError:
        raise
    except Exception as e:  # noqa: BLE001 - cualquier archivo corrupto
        raise AppError("El archivo no es un Excel válido (.xlsx)", code="INVALID_FILE") from e
    ws = wb["Categorías"] if "Categorías" in wb.sheetnames else wb.worksheets[0]
    meta: dict[str, str] = {}
    if "Plantilla" in wb.sheetnames:
        for row in wb["Plantilla"].iter_rows(min_row=1, max_row=2, values_only=True):
            if row and row[0] in ("Nombre", "Descripción") and len(row) > 1:
                meta["name" if row[0] == "Nombre" else "description"] = _txt(row[1])
    rows = list(itertools.islice(ws.iter_rows(values_only=True), MAX_ROWS + 2))
    if len(rows) > MAX_ROWS + 1:
        raise AppError(f"La plantilla admite hasta {MAX_ROWS} categorías", code="TOO_MANY_ROWS")
    errors: list[str] = []
    items: list[s.CategoryFields] = []
    for n, raw in enumerate(rows[1:], start=2):
        if raw is None or all(v in (None, "") for v in raw):
            continue
        cells = {f: (raw[i] if i < len(raw) else None) for i, (f, _) in enumerate(EXCEL_COLUMNS)}
        rec: dict[str, Any] = {}
        for f in ("code", "name", "weight_class"):
            rec[f] = _txt(cells[f]) or None
        rec["modality"] = _txt(cells["modality"]).lower()
        rec["sex"] = _txt(cells["sex"]).upper()[:1]
        rec["is_team"] = _txt(cells["is_team"]).lower() in ("sí", "si", "s", "x", "1", "true", "verdadero")
        for f in ("age_min", "age_max", "duration_seconds", "kata_judges"):
            rec[f] = _int(cells[f], f, errors, n)
        for f in ("grade_min", "grade_max"):
            g = _txt(cells[f])
            if not g:
                rec[f] = None
            elif g.isdigit():
                rec[f] = int(g)
            else:
                try:
                    rec[f] = grade_to_ordinal(g)
                except ValueError as e:
                    errors.append(f"Fila {n}: {e}")
                    rec[f] = None
        for f in ("format", "third_place_rule", "kata_method", "kata_structure"):
            rec[f] = _txt(cells[f]) or None
        rec["sort_order"] = len(items)
        try:
            items.append(s.CategoryFields(**rec))
        except ValidationError as e:
            for err in e.errors():
                field = ".".join(str(x) for x in err.get("loc", []))
                errors.append(f"Fila {n}: {field} inválido ({err.get('msg', '')})")
    if errors:
        raise AppError("La plantilla tiene errores", code="INVALID_TEMPLATE", details={"errors": errors[:100]})
    if not items:
        raise AppError("El archivo no tiene categorías", code="EMPTY_FILE")
    _check_codes([i.model_dump() for i in items])
    return meta, items


def import_excel(
    db: Session, user: User, content: bytes, filename: str, template_id: int | None = None
) -> CategoryTemplate:
    """Sin ``template_id`` crea una plantilla nueva; con él, reemplaza sus categorías."""
    meta, items = parse_excel(content)
    if template_id is None:
        ensure_can_edit(db, user, None)
        name = meta.get("name") or filename.rsplit(".", 1)[0] or "Plantilla importada"
        t = CategoryTemplate(name=name[:200], description=meta.get("description", "")[:1000], updated_by_id=user.id)
        db.add(t)
        db.flush()
        for it in items:
            db.add(TemplateCategory(template_id=t.id, **it.model_dump()))
        audit(db, user, "template", t.id, "import", after={"file": filename, "items": len(items)})
        db.commit()
        db.refresh(t)
        return t
    t = get_template(db, template_id)
    rows = [s.TemplateItemRow(**it.model_dump()) for it in items]
    return replace_items(db, user, t.id, s.TemplateItemsReplace(version=t.version, items=rows))
