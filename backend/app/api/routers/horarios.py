"""Horarios estimados: hora planificada de cada tatami, zona horaria y margen
entre combates del torneo (ver ``app.services.schedule``)."""

from __future__ import annotations

from fastapi import APIRouter

from app.api import schemas as s
from app.api.deps import DB, CurrentUser, ensure_organizer
from app.api.errors import NotFound
from app.db.models import Tatami
from app.services import schedule

router = APIRouter()


@router.patch("/tournaments/{tid}/schedule", response_model=s.TournamentOut, tags=["tatamis"])
def update_schedule(tid: int, data: s.ScheduleSettingsIn, db: DB, user: CurrentUser):
    """Zona horaria del torneo y margen entre combates (segundos) para los horarios estimados."""
    ensure_organizer(db, user, tid)
    return schedule.update_settings(db, user, tid, data)


@router.patch("/tatamis/{tatami_id}", response_model=s.TatamiOut, tags=["tatamis"])
def update_tatami(tatami_id: int, data: s.TatamiUpdate, db: DB, user: CurrentUser):
    """Nombre y hora planificada de inicio (hora local del torneo) de un tatami."""
    tat = db.get(Tatami, tatami_id)
    if tat is None:
        raise NotFound("Tatami no encontrado")
    ensure_organizer(db, user, tat.tournament_id)
    return schedule.update_tatami(db, user, tatami_id, data)
