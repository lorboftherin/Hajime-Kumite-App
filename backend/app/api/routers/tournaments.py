"""Torneos, categorías, tatamis, inscripciones e importación."""

from __future__ import annotations

from fastapi import APIRouter, File, Query, Response, UploadFile
from sqlalchemy import select

from app.api import schemas as s
from app.api.deps import (
    DB,
    AdminUser,
    CategoryReader,
    CurrentUser,
    TatamiReader,
    TournamentReader,
    ensure_organizer,
    readable_tournament_ids,
)
from app.api.errors import AppError, NotFound
from app.db.models import Category, RefereeAssignment, Registration, Tournament
from app.services import public, referees, teams
from app.services import registrations as regs
from app.services import tournaments as svc
from app.services.brackets import tatami_queue

router = APIRouter()

XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


# --- Torneos --------------------------------------------------------------------


@router.get("/tournaments", response_model=list[s.TournamentOut], tags=["tournaments"])
def list_tournaments(db: DB, user: CurrentUser, include_test: bool = True):
    """Solo los torneos que el usuario puede ver (todos para el Admin o un rol global)."""
    stmt = select(Tournament).order_by(Tournament.start_date.desc())
    ids = readable_tournament_ids(db, user)
    if ids is not None:
        if not ids:
            return []
        stmt = stmt.where(Tournament.id.in_(ids))
    if not include_test:
        stmt = stmt.where(~Tournament.is_test)
    return db.scalars(stmt).all()


@router.post("/tournaments", response_model=s.TournamentOut, status_code=201, tags=["tournaments"])
def create_tournament(data: s.TournamentCreate, db: DB, user: CurrentUser):
    ensure_organizer(db, user, None)
    return svc.create_tournament(db, user, data)


@router.get("/tournaments/{tid}", response_model=s.TournamentOut, tags=["tournaments"])
def get_tournament(tid: int, db: DB, _: TournamentReader):
    return svc.get_tournament(db, tid)


@router.patch("/tournaments/{tid}", response_model=s.TournamentOut, tags=["tournaments"])
def update_tournament(tid: int, data: s.TournamentUpdate, db: DB, user: CurrentUser):
    ensure_organizer(db, user, tid)
    return svc.update_tournament(db, user, tid, data)


@router.patch("/tournaments/{tid}/status", response_model=s.TournamentOut, tags=["tournaments"])
def change_status(tid: int, data: s.StatusChange, db: DB, user: CurrentUser):
    ensure_organizer(db, user, tid)
    return svc.change_status(db, user, tid, data)


@router.post("/tournaments/{tid}/generate-categories", tags=["tournaments"])
def generate_categories(tid: int, data: s.GenerateCategoriesIn, db: DB, user: CurrentUser):
    ensure_organizer(db, user, tid)
    return {"created": svc.generate_categories(db, user, tid, data.template_id)}


@router.post("/tournaments/{tid}/tatamis", response_model=s.TatamiOut, status_code=201, tags=["tatamis"])
def add_tatami(tid: int, data: s.TatamiIn, db: DB, user: CurrentUser):
    ensure_organizer(db, user, tid)
    return svc.add_tatami(db, user, tid, data)


@router.get("/tatamis/{tatami_id}/queue", tags=["tatamis"])
def get_queue(tatami_id: int, db: DB, _: TatamiReader):
    return tatami_queue(db, tatami_id)


@router.get("/tatamis/{tatami_id}/scoresheet.pdf", tags=["tatamis"])
def scoresheet(tatami_id: int, db: DB, _: TatamiReader, with_results: bool = False):
    """Planilla de mesa imprimible para el registro oficial en papel (Shadow Mode)."""
    from app.services.reports import scoresheet_pdf

    return Response(
        scoresheet_pdf(db, tatami_id, with_results),
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="planilla-tatami-{tatami_id}.pdf"'},
    )


# --- Categorías -----------------------------------------------------------------


@router.get("/tournaments/{tid}/categories", response_model=list[s.CategoryOut], tags=["categories"])
def list_categories(
    tid: int,
    db: DB,
    _: TournamentReader,
    status: str | None = None,
    modality: str | None = None,
    hide_empty: bool = False,
):
    stmt = select(Category).where(Category.tournament_id == tid)
    if status:
        stmt = stmt.where(Category.status.in_(status.split(",")))
    if modality:
        stmt = stmt.where(Category.modality == modality)
    rows = db.scalars(stmt.order_by(Category.sort_order, Category.id)).all()
    counts = svc.entrant_counts(db, tid)
    out = [svc.category_out(db, c, counts.get(c.id, 0)) for c in rows]
    if hide_empty:
        out = [c for c in out if c.status != "empty"]
    return out


@router.post("/tournaments/{tid}/categories", response_model=s.CategoryOut, status_code=201, tags=["categories"])
def create_category(tid: int, data: s.CategoryCreate, db: DB, user: CurrentUser):
    ensure_organizer(db, user, tid)
    return svc.category_out(db, svc.create_category(db, user, tid, data))


@router.get("/categories/{cid}", response_model=s.CategoryOut, tags=["categories"])
def get_category(cid: int, db: DB, _: CategoryReader):
    return svc.category_out(db, svc.get_category(db, cid))


@router.patch("/categories/{cid}", response_model=s.CategoryOut, tags=["categories"])
def update_category(cid: int, data: s.CategoryUpdate, db: DB, user: CurrentUser):
    c = svc.get_category(db, cid)
    ensure_organizer(db, user, c.tournament_id)
    return svc.category_out(db, svc.update_category(db, user, cid, data))


@router.post("/categories/{cid}/cancel", response_model=s.CategoryOut, tags=["categories"])
def cancel_category(cid: int, data: s.CategoryCancelIn, db: DB, user: CurrentUser):
    c = svc.get_category(db, cid)
    ensure_organizer(db, user, c.tournament_id)
    return svc.category_out(db, svc.cancel_category(db, user, cid, data.reason, data.version))


@router.post("/tournaments/{tid}/categories/merge", response_model=s.CategoryOut, tags=["categories"])
def merge_categories(tid: int, data: s.CategoryMergeIn, db: DB, user: CurrentUser):
    ensure_organizer(db, user, tid)
    return svc.category_out(db, svc.merge_categories(db, user, tid, data))


@router.post("/categories/{cid}/unmerge", response_model=s.CategoryOut, tags=["categories"])
def unmerge(cid: int, db: DB, user: CurrentUser):
    c = svc.get_category(db, cid)
    ensure_organizer(db, user, c.tournament_id)
    return svc.category_out(db, svc.undo_merge(db, user, cid))


# --- Inscripciones --------------------------------------------------------------


@router.get("/tournaments/{tid}/registrations", response_model=list[s.RegistrationOut], tags=["registrations"])
def list_registrations(
    tid: int,
    db: DB,
    _: TournamentReader,
    category_id: int | None = None,
    person_id: int | None = None,
    include_withdrawn: bool = True,
):
    stmt = select(Registration).where(Registration.tournament_id == tid)
    if category_id:
        stmt = stmt.where(Registration.category_id == category_id)
    if person_id:
        stmt = stmt.where(Registration.person_id == person_id)
    if not include_withdrawn:
        stmt = stmt.where(Registration.status == "active")
    return [regs.registration_out(r) for r in db.scalars(stmt.order_by(Registration.id)).all()]


@router.post(
    "/tournaments/{tid}/registrations", response_model=s.RegistrationOut, status_code=201, tags=["registrations"]
)
def register(tid: int, data: s.RegistrationCreate, db: DB, user: CurrentUser):
    ensure_organizer(db, user, tid)
    return regs.registration_out(regs.create_registration(db, user, tid, data))


@router.patch("/registrations/{rid}", response_model=s.RegistrationOut, tags=["registrations"])
def update_registration(rid: int, data: s.RegistrationUpdate, db: DB, user: CurrentUser):
    r = regs.get_registration(db, rid)
    ensure_organizer(db, user, r.tournament_id)
    return regs.registration_out(regs.update_registration(db, user, rid, data))


@router.post("/tournaments/{tid}/teams", response_model=s.RegistrationOut, status_code=201, tags=["teams"])
def create_team(tid: int, data: s.TeamCreate, db: DB, user: CurrentUser):
    """Inscribe un equipo temporal (nombre, dojo, titulares y suplentes) en una categoría por equipos."""
    ensure_organizer(db, user, tid)
    return regs.registration_out(teams.create_team(db, user, tid, data))


@router.patch("/teams/{team_id}", response_model=s.RegistrationOut, tags=["teams"])
def update_team(team_id: int, data: s.TeamUpdate, db: DB, user: CurrentUser):
    ensure_organizer(db, user, teams.get_team(db, team_id).tournament_id)
    return regs.registration_out(teams.update_team(db, user, team_id, data))


@router.post("/registrations/{rid}/withdraw", tags=["registrations"])
def withdraw(rid: int, data: s.WithdrawIn, db: DB, user: CurrentUser):
    r = regs.get_registration(db, rid)
    ensure_organizer(db, user, r.tournament_id)
    return regs.withdraw(db, user, rid, data.reason, data.version)


@router.get("/tournaments/{tid}/suggestions", response_model=list[s.SuggestionOut], tags=["registrations"])
def suggest(
    tid: int,
    person_id: int,
    db: DB,
    _: TournamentReader,
    modality: str | None = Query(None),
    weight_class: str | None = Query(None),
):
    return [
        s.SuggestionOut(category_id=c.id, name=c.name, modality=c.modality)
        for c in regs.suggestions(db, tid, person_id, modality, weight_class)
    ]


# --- Árbitros (registro y asignación opcionales, sección 20) ------------------


@router.get("/tournaments/{tid}/referees", tags=["referees"])
def list_referees(tid: int, db: DB, _: TournamentReader):
    return referees.overview(db, tid)


@router.post("/tournaments/{tid}/referees", tags=["referees"])
def register_referee(tid: int, data: s.RefereeIn, db: DB, user: CurrentUser):
    """Registra a una persona como árbitro del torneo (no necesita dojo)."""
    ensure_organizer(db, user, tid)
    return referees.register(db, user, tid, data.person_id)


@router.post("/tournaments/{tid}/referee-assignments", tags=["referees"])
def assign_referee(tid: int, data: s.RefereeAssignIn, db: DB, user: CurrentUser):
    """Asigna un árbitro a un tatami, una categoría o un combate."""
    ensure_organizer(db, user, tid)
    return referees.assign(db, user, tid, data)


@router.delete("/referee-assignments/{aid}", tags=["referees"])
def unassign_referee(aid: int, db: DB, user: CurrentUser):
    a = db.get(RefereeAssignment, aid)
    if a is None:
        raise NotFound("Asignación no encontrada")
    ensure_organizer(db, user, a.tournament_id)
    return referees.overview(db, referees.unassign(db, user, aid))


@router.put("/tournaments/{tid}/public", response_model=s.TournamentOut, tags=["public"])
def set_public(tid: int, data: s.PublicLiveIn, db: DB, user: CurrentUser):
    """Activa el seguimiento en vivo público (enlace secreto) y el estilo de nombres."""
    ensure_organizer(db, user, tid)
    return public.set_public(db, user, tid, data)


# --- Importación Excel ----------------------------------------------------------


@router.get("/imports/template.xlsx", tags=["imports"])
def import_template(_: CurrentUser):
    return Response(
        regs.excel_template(),
        media_type=XLSX,
        headers={"Content-Disposition": 'attachment; filename="plantilla-inscripciones.xlsx"'},
    )


@router.post("/tournaments/{tid}/imports", response_model=s.ImportBatchOut, status_code=201, tags=["imports"])
def upload_import(tid: int, db: DB, user: CurrentUser, file: UploadFile = File(...)):
    # Endpoint síncrono a propósito (sección 22): corre en el pool de hilos y
    # no bloquea a las mesas mientras se procesa el Excel.
    ensure_organizer(db, user, tid)
    content = file.file.read()
    if len(content) > 5 * 1024 * 1024:
        raise AppError("El archivo supera 5 MB", code="FILE_TOO_LARGE")
    return regs.create_import_preview(db, user, tid, file.filename or "import.xlsx", content)


@router.post("/imports/purge", tags=["imports"])
def purge_imports(db: DB, _: AdminUser, days: int = Query(regs.IMPORT_RETENTION_DAYS, ge=1)):
    """Borra las filas (con DNI y fechas de nacimiento) de importaciones antiguas."""
    return regs.purge_old_imports(db, days)


@router.get("/imports/{bid}", response_model=s.ImportBatchOut, tags=["imports"])
def get_import(bid: int, db: DB, user: CurrentUser):
    b = regs.get_batch(db, bid)
    ensure_organizer(db, user, b.tournament_id)
    return b


@router.post("/imports/{bid}/confirm", tags=["imports"])
def confirm_import(bid: int, data: s.ImportConfirm, db: DB, user: CurrentUser):
    b = regs.get_batch(db, bid)
    ensure_organizer(db, user, b.tournament_id)
    return regs.confirm_import(db, user, bid, data)


@router.post("/imports/{bid}/cancel", status_code=204, tags=["imports"])
def cancel_import(bid: int, db: DB, user: CurrentUser):
    b = regs.get_batch(db, bid)
    ensure_organizer(db, user, b.tournament_id)
    regs.cancel_import(db, user, bid)
