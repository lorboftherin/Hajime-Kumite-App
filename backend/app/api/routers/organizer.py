"""Herramientas del organizador: walkover por retiro, cola de tatami, verificación
previa al inicio y corrección de filas de importación."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.api import schemas as s
from app.api.deps import DB, CurrentUser, ensure_organizer
from app.api.errors import NotFound
from app.db.models import Tatami
from app.services import organizer
from app.services import registrations as regs
from app.services import tournaments as tsvc

router = APIRouter()


class WalkoverIn(BaseModel):
    reason: str | None = Field(default=None, max_length=250)


class TatamiQueueIn(BaseModel):
    """Orden completo de la cola: categorías del tatami, de la primera a la última."""

    category_ids: list[int] = Field(max_length=500)


class ImportRowUpdate(BaseModel):
    """Celdas corregidas (mismas claves que la plantilla: nombres, apellidos, sexo…)."""

    data: dict[str, Any]


@router.post("/registrations/{rid}/walkover", tags=["registrations"])
def walkover(rid: int, data: WalkoverIn, db: DB, user: CurrentUser):
    """Da walkover al rival en todos los combates pendientes de una inscripción retirada."""
    r = regs.get_registration(db, rid)
    ensure_organizer(db, user, r.tournament_id)
    return organizer.walkover_pending(db, user, rid, data.reason)


@router.put("/tatamis/{tatami_id}/queue", response_model=list[s.CategoryOut], tags=["tatamis"])
def set_queue(tatami_id: int, data: TatamiQueueIn, db: DB, user: CurrentUser):
    """Reemplaza la cola de categorías del tatami en una sola transacción (auditada)."""
    tat = db.get(Tatami, tatami_id)
    if tat is None:
        raise NotFound("Tatami no encontrado")
    ensure_organizer(db, user, tat.tournament_id)
    cats = organizer.set_tatami_queue(db, user, tatami_id, data.category_ids)
    counts = tsvc.entrant_counts(db, tat.tournament_id)
    return [tsvc.category_out(db, c, counts.get(c.id, 0)) for c in cats]


@router.get("/tournaments/{tid}/readiness", tags=["tournaments"])
def readiness(tid: int, db: DB, user: CurrentUser):
    """Verificación previa a «Iniciar torneo»: problemas con severidad (error, warning, info)."""
    ensure_organizer(db, user, tid)
    return organizer.readiness(db, tid)


@router.patch("/imports/{bid}/rows/{row_id}", response_model=s.ImportBatchOut, tags=["imports"])
def update_import_row(bid: int, row_id: int, data: ImportRowUpdate, db: DB, user: CurrentUser):
    """Corrige una fila de la vista previa y la vuelve a validar."""
    b = regs.get_batch(db, bid)
    ensure_organizer(db, user, b.tournament_id)
    return organizer.update_import_row(db, user, bid, row_id, data.data)
