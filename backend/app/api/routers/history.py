"""Historial deportivo de competidores y dojos."""

from __future__ import annotations

from fastapi import APIRouter

from app.api.deps import DB, CurrentUser
from app.services import history

router = APIRouter(tags=["history"])


@router.get("/persons/{person_id}/history")
def person_history(person_id: int, db: DB, _: CurrentUser):
    return history.person_history(db, person_id)


@router.get("/dojos/{dojo_id}/history")
def dojo_history(dojo_id: int, db: DB, _: CurrentUser):
    return history.dojo_history(db, dojo_id)
