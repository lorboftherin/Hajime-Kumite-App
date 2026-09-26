"""Historial deportivo de competidores y dojos."""

from __future__ import annotations

from fastapi import APIRouter
from sqlalchemy.orm import Session

from app.api.deps import DB, CurrentUser, MatchReader, StaffUser, TournamentReader, is_staff, roles_of
from app.api.errors import Forbidden
from app.db.models import User
from app.services import history, people, stats

router = APIRouter(tags=["history"])


def ensure_person_access(db: Session, user: User, person_id: int) -> None:
    """Historial y estadísticas de una persona: Admin, organizadores o la propia persona."""
    if user.person_id != person_id and not is_staff(db, user):
        raise Forbidden("Solo los organizadores o la propia persona ven este historial")


def ensure_dojo_access(db: Session, user: User, dojo_id: int) -> None:
    """Historial de un dojo: Admin, organizadores, su sensei o administrador, o sus miembros."""
    if is_staff(db, user):
        return
    if any(r.scope_type == "dojo" and r.scope_id == dojo_id for r in roles_of(db, user)):
        return
    if user.person_id is not None:
        m = people.current_membership(db, user.person_id)
        if m is not None and m.dojo_id == dojo_id:
            return
    raise Forbidden("Solo los organizadores o los miembros del dojo ven su historial")


@router.get("/persons/{person_id}/history")
def person_history(person_id: int, db: DB, user: CurrentUser):
    ensure_person_access(db, user, person_id)
    return history.person_history(db, person_id)


@router.get("/dojos/{dojo_id}/history")
def dojo_history(dojo_id: int, db: DB, user: CurrentUser):
    ensure_dojo_access(db, user, dojo_id)
    return history.dojo_history(db, dojo_id)


# --- Estadísticas, líderes y premios (inspirado en CricHeroes) -------------------


@router.get("/persons/{person_id}/stats", tags=["stats"])
def person_stats(person_id: int, db: DB, user: CurrentUser):
    """Perfil deportivo: números de kumite, medallas, índice Hajime e insignias."""
    ensure_person_access(db, user, person_id)
    return stats.person_stats(db, person_id)


@router.get("/tournaments/{tid}/leaders", tags=["stats"])
def tournament_leaders(tid: int, db: DB, _: TournamentReader):
    """Premios automáticos y tablas de líderes del torneo."""
    return stats.tournament_leaders(db, tid)


@router.get("/leaders", tags=["stats"])
def global_leaders(db: DB, _: StaffUser, year: int | None = None):
    """Líderes de todos los torneos oficiales (opcionalmente de un año)."""
    return stats.global_leaders(db, year)


@router.get("/matches/{mid}/summary", tags=["stats"])
def match_summary(mid: int, db: DB, _: MatchReader):
    """Hoja del combate con técnicas por lado y línea de tiempo del marcador."""
    return stats.match_summary(db, mid)
