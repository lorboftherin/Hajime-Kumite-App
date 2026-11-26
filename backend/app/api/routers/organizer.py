"""Herramientas del organizador: walkover por retiro, cola de tatami, verificación
previa al inicio y corrección de filas de importación."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.api import schemas as s
from app.api.deps import DB, CurrentUser, ensure_organizer, ensure_tournament_operator
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


class TatamiAssignment(BaseModel):
    category_id: int
    tatami_id: int | None = None  # None = sin tatami


class TatamiPlanIn(BaseModel):
    """Reparto de categorías entre tatamis. ``order="code"`` ordena cada tatami
    tocado por código (A1, B1, A2…); ``"keep"`` deja las nuevas al final."""

    assignments: list[TatamiAssignment] = Field(max_length=500)
    order: Literal["code", "keep"] = "code"
    override: s.Override | None = None


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
    ensure_tournament_operator(db, user, tat.tournament_id)
    cats = organizer.set_tatami_queue(db, user, tatami_id, data.category_ids)
    counts = tsvc.entrant_counts(db, tat.tournament_id)
    return [tsvc.category_out(db, c, counts.get(c.id, 0)) for c in cats]


@router.post("/tatamis/{tatami_id}/queue/sort-by-code", response_model=list[s.CategoryOut], tags=["tatamis"])
def sort_queue(tatami_id: int, db: DB, user: CurrentUser):
    """Ordena la cola del tatami por código de categoría (A1, B1, A2, B2…)."""
    tat = db.get(Tatami, tatami_id)
    if tat is None:
        raise NotFound("Tatami no encontrado")
    ensure_tournament_operator(db, user, tat.tournament_id)
    cats = organizer.sort_tatami_by_code(db, user, tatami_id)
    counts = tsvc.entrant_counts(db, tat.tournament_id)
    return [tsvc.category_out(db, c, counts.get(c.id, 0)) for c in cats]


@router.post("/tatamis/{tatami_id}/late-entry", tags=["tatamis"])
def late_entry(tatami_id: int, data: s.LateEntryIn, db: DB, user: CurrentUser):
    """Inscribe a quien llega tarde y lo mete en la llave sin salir de la mesa
    (organizador u operador de mesa del torneo; auditado)."""
    tat = db.get(Tatami, tatami_id)
    if tat is None:
        raise NotFound("Tatami no encontrado")
    ensure_tournament_operator(db, user, tat.tournament_id)
    return organizer.late_entry(db, user, tatami_id, data)


@router.put("/tournaments/{tid}/tatami-plan", tags=["tatamis"])
def tatami_plan(tid: int, data: TatamiPlanIn, db: DB, user: CurrentUser):
    """Reparte categorías entre los tatamis en una sola operación (organizador u
    operador de mesa del torneo). Devuelve la cola resultante de cada tatami tocado."""
    ensure_tournament_operator(db, user, tid)
    queues = organizer.plan_tatamis(
        db,
        user,
        tid,
        [(a.category_id, a.tatami_id) for a in data.assignments],
        data.order,
        data.override.reason if data.override else None,
    )
    return {"queues": queues}


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
