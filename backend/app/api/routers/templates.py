"""Plantillas de categorías: lista, edición, duplicado, archivo e intercambio con Excel."""

from __future__ import annotations

from fastapi import APIRouter, File, Query, Response, UploadFile
from sqlalchemy import or_, select

from app.api import schemas as s
from app.api.deps import DB, CurrentUser, memberships_of
from app.api.errors import AppError
from app.db.models import CategoryTemplate
from app.services import templates as svc
from app.services.tournaments import create_template

router = APIRouter(tags=["templates"])

XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
MAX_UPLOAD = 2 * 1024 * 1024


@router.get("/templates", response_model=list[s.TemplateOut])
def list_templates(db: DB, user: CurrentUser, include_archived: bool = False):
    """Plantillas globales y las de las organizaciones del usuario (todas para el Admin)."""
    stmt = select(CategoryTemplate).order_by(CategoryTemplate.name)
    if not user.is_admin:
        orgs = list(memberships_of(db, user))
        stmt = stmt.where(
            or_(CategoryTemplate.organization_id.is_(None), CategoryTemplate.organization_id.in_(orgs or [0]))
        )
    if not include_archived:
        stmt = stmt.where(~CategoryTemplate.is_archived)
    used = svc.used_template_ids(db)
    return [svc.template_out(db, t, user, used) for t in db.scalars(stmt).all()]


@router.post("/templates", response_model=s.TemplateOut, status_code=201)
def new_template(data: s.TemplateCreate, db: DB, user: CurrentUser):
    if data.organization_id is None and not user.is_admin:
        data.organization_id = svc.default_org(db, user)
    svc.ensure_can_create(db, user, data.organization_id)
    return svc.template_out(db, create_template(db, user, data), user)


@router.post("/templates/import", response_model=s.TemplateOut, status_code=201)
def import_template(
    db: DB,
    user: CurrentUser,
    file: UploadFile = File(...),
    template_id: int | None = Query(default=None),
    organization_id: int | None = Query(default=None),
):
    """Crea una plantilla desde Excel (en ``organization_id``) o, con ``template_id``,
    reemplaza sus categorías."""
    content = file.file.read()
    if len(content) > MAX_UPLOAD:
        raise AppError("El archivo supera 2 MB", code="FILE_TOO_LARGE")
    t = svc.import_excel(db, user, content, file.filename or "plantilla.xlsx", template_id, organization_id)
    return svc.template_out(db, t, user)


@router.get("/templates/{template_id}", response_model=s.TemplateOut)
def get_template(template_id: int, db: DB, user: CurrentUser):
    return svc.template_out(db, svc.get_template(db, template_id, user), user)


@router.patch("/templates/{template_id}", response_model=s.TemplateOut)
def update_template(template_id: int, data: s.TemplateUpdate, db: DB, user: CurrentUser):
    """Nombre, descripción o archivar/restaurar."""
    return svc.template_out(db, svc.update_template(db, user, template_id, data), user)


@router.post("/templates/{template_id}/duplicate", response_model=s.TemplateOut, status_code=201)
def duplicate_template(template_id: int, data: s.TemplateDuplicateIn, db: DB, user: CurrentUser):
    return svc.template_out(db, svc.duplicate_template(db, user, template_id, data.name, data.organization_id), user)


@router.delete("/templates/{template_id}")
def delete_template(template_id: int, db: DB, user: CurrentUser):
    """Borra la plantilla; si un torneo la usó para generar categorías, solo la archiva."""
    return svc.delete_template(db, user, template_id)


@router.put("/templates/{template_id}/items", response_model=s.TemplateOut)
def replace_items(template_id: int, data: s.TemplateItemsReplace, db: DB, user: CurrentUser):
    """Guarda la edición en tabla: todas las filas de una vez (con control de versión)."""
    return svc.template_out(db, svc.replace_items(db, user, template_id, data), user)


@router.post("/templates/{template_id}/items", response_model=s.TemplateItemOut, status_code=201)
def add_item(template_id: int, data: s.CategoryFields, db: DB, user: CurrentUser):
    return svc.add_item(db, user, template_id, data)


@router.patch("/templates/{template_id}/items/{item_id}", response_model=s.TemplateItemOut)
def update_item(template_id: int, item_id: int, data: s.TemplateItemUpdate, db: DB, user: CurrentUser):
    return svc.update_item(db, user, template_id, item_id, data)


@router.delete("/templates/{template_id}/items/{item_id}", status_code=204)
def delete_item(template_id: int, item_id: int, db: DB, user: CurrentUser):
    svc.delete_item(db, user, template_id, item_id)


@router.get("/templates/{template_id}/export.xlsx")
def export_template(template_id: int, db: DB, user: CurrentUser):
    t = svc.get_template(db, template_id, user)
    return Response(
        svc.export_excel(t),
        media_type=XLSX,
        headers={"Content-Disposition": f'attachment; filename="plantilla-{t.id}.xlsx"'},
    )
