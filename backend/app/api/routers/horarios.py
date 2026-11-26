"""Horarios estimados: hora planificada de cada tatami, zona horaria y margen
entre combates del torneo (ver ``app.services.schedule``)."""

from __future__ import annotations

from fastapi import APIRouter

from app.api import schemas as s
from app.api.deps import DB, CurrentUser, ensure_operator, ensure_organizer
from app.api.errors import NotFound
from app.db.models import Tatami
from app.services import schedule
from app.services.audit import audit

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


@router.put("/tatamis/{tatami_id}/clock", response_model=s.TatamiOut, tags=["tatamis"])
def set_tatami_clock(tatami_id: int, data: s.TatamiClockIn, db: DB, user: CurrentUser):
    """Tiempo efectivo o corrido en este tatami (p. ej. corrido para recuperar
    retraso). Lo decide la mesa del tatami o el organizador; rige desde el
    siguiente combate que empiece: los empezados conservan su modo."""
    tat = db.get(Tatami, tatami_id)
    if tat is None:
        raise NotFound("Tatami no encontrado")
    ensure_operator(db, user, tat.tournament_id, tat.id)
    before = tat.time_mode
    tat.time_mode = data.time_mode
    audit(
        db,
        user,
        "tatami",
        tat.id,
        "clock",
        {"time_mode": before},
        {"time_mode": tat.time_mode},
        tournament_id=tat.tournament_id,
    )
    db.commit()
    db.refresh(tat)
    return tat
