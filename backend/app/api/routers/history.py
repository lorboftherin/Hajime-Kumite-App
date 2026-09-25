"""Historial deportivo de competidores y dojos."""

from __future__ import annotations

from fastapi import APIRouter

from app.api.deps import DB, CurrentUser
from app.services import history, stats

router = APIRouter(tags=["history"])


@router.get("/persons/{person_id}/history")
def person_history(person_id: int, db: DB, _: CurrentUser):
    return history.person_history(db, person_id)


@router.get("/dojos/{dojo_id}/history")
def dojo_history(dojo_id: int, db: DB, _: CurrentUser):
    return history.dojo_history(db, dojo_id)


# --- Estadísticas, líderes y premios (inspirado en CricHeroes) -------------------


@router.get("/persons/{person_id}/stats", tags=["stats"])
def person_stats(person_id: int, db: DB, _: CurrentUser):
    """Perfil deportivo: números de kumite, medallas, índice Hajime e insignias."""
    return stats.person_stats(db, person_id)


@router.get("/tournaments/{tid}/leaders", tags=["stats"])
def tournament_leaders(tid: int, db: DB, _: CurrentUser):
    """Premios automáticos y tablas de líderes del torneo."""
    return stats.tournament_leaders(db, tid)


@router.get("/leaders", tags=["stats"])
def global_leaders(db: DB, _: CurrentUser, year: int | None = None):
    """Líderes de todos los torneos oficiales (opcionalmente de un año)."""
    return stats.global_leaders(db, year)


@router.get("/matches/{mid}/summary", tags=["stats"])
def match_summary(mid: int, db: DB, _: CurrentUser):
    """Hoja del combate con técnicas por lado y línea de tiempo del marcador."""
    return stats.match_summary(db, mid)
