"""Perfil público básico del competidor (sin inicio de sesión). Ver ``app.services.public_profiles``."""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse

from app.api.deps import DB
from app.services import public_profiles

router = APIRouter(prefix="/public/persons", tags=["public"])


@router.get("/{public_id}")
def public_person(public_id: str, db: DB):
    """Nombre (abreviado si es menor), dojo, medallas y torneos disputados. Nunca documento,
    fecha de nacimiento ni datos de contacto."""
    data = public_profiles.public_profile(db, public_id)
    return JSONResponse(jsonable_encoder(data), headers={"Cache-Control": "public, max-age=60"})
