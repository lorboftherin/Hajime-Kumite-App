"""Seguimiento en vivo público y overlay de transmisión (sin inicio de sesión).

Solo responde con un enlace activo; ver ``app.services.public``.
"""

from __future__ import annotations

from fastapi import APIRouter, Response

from app.api.deps import DB
from app.services import public

router = APIRouter(prefix="/public", tags=["public"])


@router.get("/{token}")
def live(token: str, db: DB, response: Response):
    """Tatamis en vivo, resultados, medallero y premios del torneo."""
    response.headers["Cache-Control"] = "no-store"
    return public.live(db, token)


@router.get("/{token}/tatamis/{tatami_id}")
def overlay(token: str, tatami_id: int, db: DB, response: Response):
    """Marcador del tatami para el overlay de la transmisión."""
    response.headers["Cache-Control"] = "no-store"
    return public.overlay(db, token, tatami_id)
