"""Ranking por temporada y liga (docs/ranking.md), y su vista pública."""

from __future__ import annotations

from datetime import date
from typing import Any, Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import DB, CurrentUser, ensure_staff, is_staff
from app.api.errors import Forbidden, NotFound
from app.db.models import RankingSeason
from app.services import people
from app.services import ranking as svc

router = APIRouter(tags=["ranking"])

Modality = Literal["kumite", "kata"]


class Points(BaseModel):
    gold: float = Field(default=10, ge=0, le=1000)
    silver: float = Field(default=7, ge=0, le=1000)
    bronze: float = Field(default=5, ge=0, le=1000)
    participation: float = Field(default=1, ge=0, le=1000)


class SeasonIn(BaseModel):
    name: str = Field(min_length=3, max_length=200)
    year: int = Field(ge=2000, le=2100)
    slug: str | None = Field(default=None, max_length=60)
    date_from: date | None = None
    date_to: date | None = None
    # Vacío = todos los torneos que no son de prueba del rango de fechas (o del año).
    tournament_ids: list[int] = Field(default=[], max_length=200)
    points: Points = Points()
    # {"<tournament_id>": 2.0}: p. ej. el nacional vale doble.
    multipliers: dict[str, float] = {}
    min_entrants_walkover_gold: int = Field(default=2, ge=0, le=64)
    is_public: bool = False


class SeasonUpdate(BaseModel):
    version: int
    name: str | None = Field(default=None, min_length=3, max_length=200)
    year: int | None = Field(default=None, ge=2000, le=2100)
    slug: str | None = Field(default=None, min_length=3, max_length=60)
    date_from: date | None = None
    date_to: date | None = None
    tournament_ids: list[int] | None = Field(default=None, max_length=200)
    points: Points | None = None
    multipliers: dict[str, float] | None = None
    min_entrants_walkover_gold: int | None = Field(default=None, ge=0, le=64)
    is_public: bool | None = None


def _detail(db, s, *, full_names: bool, modality: str | None, group: str | None) -> dict[str, Any]:
    svc.ensure_fresh(db, s)
    return {
        "season": svc.season_out(s, svc.season_tournaments(db, s)),
        "groups": svc.groups(db, s, modality),
        "persons": svc.person_table(db, s, group, modality, full_names=full_names)["groups"],
        "dojos": svc.dojo_table(db, s),
    }


@router.get("/ranking/seasons")
def list_seasons(db: DB, user: CurrentUser):
    rows = db.scalars(select(RankingSeason).order_by(RankingSeason.year.desc(), RankingSeason.name)).all()
    return [svc.season_out(s) for s in rows]


@router.post("/ranking/seasons", status_code=201)
def create_season(data: SeasonIn, db: DB, user: CurrentUser):
    ensure_staff(db, user)
    body = data.model_dump()
    return svc.season_out(svc.create_season(db, user, body))


@router.get("/ranking/seasons/{sid}")
def season_detail(
    sid: int,
    db: DB,
    user: CurrentUser,
    modality: Modality | None = None,
    group: str | None = Query(default=None, max_length=200),
):
    """Temporada con sus categorías equivalentes, tabla de personas y de dojos.
    El staff ve nombres completos; los demás, abreviados en menores (como el público)."""
    return _detail(db, svc.get_season(db, sid), full_names=is_staff(db, user), modality=modality, group=group)


@router.patch("/ranking/seasons/{sid}")
def update_season(sid: int, data: SeasonUpdate, db: DB, user: CurrentUser):
    ensure_staff(db, user)
    return svc.season_out(svc.update_season(db, user, sid, data.model_dump(exclude_unset=True)))


@router.delete("/ranking/seasons/{sid}", status_code=204)
def delete_season(sid: int, db: DB, user: CurrentUser):
    ensure_staff(db, user)
    svc.delete_season(db, user, sid)


@router.post("/ranking/seasons/{sid}/recompute")
def recompute(sid: int, db: DB, user: CurrentUser):
    """Recalcula ya (normalmente no hace falta: se recalcula solo al cambiar los resultados)."""
    ensure_staff(db, user)
    s = svc.get_season(db, sid)
    n = svc.compute(db, s)
    return {"season_id": s.id, "entries": n, "computed_at": s.computed_at}


@router.get("/persons/{person_id}/ranking")
def person_ranking(person_id: int, db: DB, user: CurrentUser):
    """Puesto de la persona en cada temporada (perfil)."""
    if not is_staff(db, user) and user.person_id != person_id:
        raise Forbidden("Solo los organizadores ven el ranking de otras personas")
    people.get_person(db, person_id)
    return svc.person_positions(db, person_id)


# --- Público (sin inicio de sesión) --------------------------------------------


@router.get("/public/ranking/{slug}", tags=["public"])
def public_ranking(
    slug: str,
    db: DB,
    modality: Modality | None = None,
    group: str | None = Query(default=None, max_length=200),
):
    """Ranking de una temporada marcada pública. Menores con nombre abreviado («Diego R.»)."""
    s = svc.by_slug(db, slug)
    if not s.is_public:
        raise NotFound("Temporada no encontrada")
    out = _detail(db, s, full_names=False, modality=modality, group=group)
    # Lo público no expone la configuración interna ni ids de torneos de prueba.
    season = out["season"]
    out["season"] = {
        k: season[k] for k in ("name", "slug", "year", "date_from", "date_to", "points", "computed_at", "tournaments")
    }
    return out
