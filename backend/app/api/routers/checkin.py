"""Acreditación, pesaje y credenciales (día del torneo). Ver docs/acreditacion-y-pesaje.md."""

from __future__ import annotations

from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Response
from pydantic import BaseModel, Field

from app.api import schemas as s
from app.api.deps import DB, CurrentUser, ensure_organizer
from app.services import checkin
from app.services import registrations as regs
from app.services.credentials import credentials, credentials_pdf

router = APIRouter(tags=["checkin"])


class CheckinIn(BaseModel):
    status: Literal["present", "absent", "pending"] = "present"
    # Marcar a la persona en todas sus inscripciones del torneo (lo normal en la mesa).
    whole_person: bool = True


class CheckinBatchIn(CheckinIn):
    registration_ids: list[int] = Field(min_length=1, max_length=500)


class ScanIn(BaseModel):
    code: str = Field(min_length=3, max_length=60)


class WeighInIn(BaseModel):
    weight_kg: Decimal = Field(gt=0, lt=300, decimal_places=2)
    whole_person: bool = True


class WeighInAcceptIn(BaseModel):
    reason: str = Field(min_length=3, max_length=500)


class WeighInMoveIn(BaseModel):
    category_id: int
    reason: str = Field(min_length=3, max_length=500)
    version: int | None = None


@router.get("/tournaments/{tid}/checkin")
def checkin_list(
    tid: int,
    db: DB,
    user: CurrentUser,
    dojo_id: int | None = None,
    category_id: int | None = None,
    status: Literal["pending", "present", "absent"] | None = None,
    q: str | None = None,
    out_of_weight: bool = False,
):
    """Lista de la mesa de acreditación, con contadores por categoría."""
    ensure_organizer(db, user, tid)
    return checkin.checkin_list(
        db, tid, dojo_id=dojo_id, category_id=category_id, status=status, q=q, out_of_weight=out_of_weight
    )


@router.post("/tournaments/{tid}/checkin")
def checkin_batch(tid: int, data: CheckinBatchIn, db: DB, user: CurrentUser):
    """Marca presente, ausente o pendiente a varias inscripciones (idempotente)."""
    ensure_organizer(db, user, tid)
    return checkin.set_checkin(db, user, tid, data.registration_ids, data.status, whole_person=data.whole_person)


@router.post("/registrations/{rid}/checkin")
def checkin_one(rid: int, data: CheckinIn, db: DB, user: CurrentUser):
    r = regs.get_registration(db, rid)
    ensure_organizer(db, user, r.tournament_id)
    return checkin.set_checkin(db, user, r.tournament_id, [rid], data.status, whole_person=data.whole_person)


@router.post("/tournaments/{tid}/checkin/scan")
def checkin_scan(tid: int, data: ScanIn, db: DB, user: CurrentUser):
    """Código de la credencial (tipeado o leído del QR): marca presente a la persona."""
    ensure_organizer(db, user, tid)
    return checkin.scan(db, user, tid, data.code)


@router.post("/registrations/{rid}/no-show")
def no_show(rid: int, db: DB, user: CurrentUser):
    """No se presentó y la llave ya existe: retira con ese motivo y da walkover al rival."""
    r = regs.get_registration(db, rid)
    ensure_organizer(db, user, r.tournament_id)
    return checkin.no_show(db, user, rid)


@router.post("/registrations/{rid}/weigh-in")
def weigh_in(rid: int, data: WeighInIn, db: DB, user: CurrentUser):
    """Registra el peso. Fuera de rango se guarda igual y vuelve con advertencias y sugerencias."""
    r = regs.get_registration(db, rid)
    ensure_organizer(db, user, r.tournament_id)
    return checkin.weigh_in(db, user, rid, data.weight_kg, whole_person=data.whole_person)


@router.post("/registrations/{rid}/weigh-in/accept", response_model=s.RegistrationOut)
def weigh_in_accept(rid: int, data: WeighInAcceptIn, db: DB, user: CurrentUser):
    """Deja a la persona en su categoría pese al peso (override con motivo, auditado)."""
    r = regs.get_registration(db, rid)
    ensure_organizer(db, user, r.tournament_id)
    return regs.registration_out(checkin.accept_weight(db, user, rid, data.reason))


@router.post("/registrations/{rid}/weigh-in/move", response_model=s.RegistrationOut)
def weigh_in_move(rid: int, data: WeighInMoveIn, db: DB, user: CurrentUser):
    """Mueve a la categoría que corresponde al peso (con motivo, auditado)."""
    r = regs.get_registration(db, rid)
    ensure_organizer(db, user, r.tournament_id)
    return regs.registration_out(
        checkin.move_after_weigh_in(db, user, rid, data.category_id, data.reason, data.version)
    )


@router.get("/tournaments/{tid}/credentials")
def credential_list(tid: int, db: DB, user: CurrentUser, dojo_id: int | None = None):
    ensure_organizer(db, user, tid)
    return credentials(db, tid, dojo_id)


@router.get("/tournaments/{tid}/credentials.pdf")
def credential_pdf(tid: int, db: DB, user: CurrentUser, dojo_id: int | None = None):
    """Credenciales imprimibles (8 por hoja A4) con QR del código de cada persona."""
    ensure_organizer(db, user, tid)
    suffix = f"-dojo-{dojo_id}" if dojo_id else ""
    return Response(
        credentials_pdf(db, tid, dojo_id),
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="credenciales-{tid}{suffix}.pdf"'},
    )
