"""Autoinscripción por dojo: portal del sensei, invitaciones y solicitudes.

* El sensei (rol ``dojo_admin`` del dojo) ve y edita a sus competidores y los
  inscribe en torneos con la inscripción en línea abierta: ``/dojo-portal/…``.
* El organizador abre la inscripción, genera los enlaces y aprueba o rechaza
  las solicitudes: ``/tournaments/{tid}/self-registration``, ``invitations`` y
  ``registration-requests``.
* Quien abre un enlace: ``/invitations/{token}``.
"""

from __future__ import annotations

from fastapi import APIRouter, Query

from app.api import schemas as s
from app.api.deps import DB, CurrentUser, dojo_admin_ids, ensure_organizer, is_dojo_admin
from app.api.errors import AppError, Forbidden
from app.db.models import Dojo
from app.services import people
from app.services import registrations as regs
from app.services import self_registration as svc
from app.services.tournaments import get_tournament

router = APIRouter()


def _ensure_dojo_admin(db, user, dojo_id: int) -> None:
    people.get_dojo(db, dojo_id)
    if not is_dojo_admin(db, user, dojo_id):
        raise Forbidden("No administras este dojo")


# --- Organizador ------------------------------------------------------------------------


@router.put("/tournaments/{tid}/self-registration", response_model=s.TournamentOut, tags=["self-registration"])
def set_self_registration(tid: int, data: s.SelfRegistrationIn, db: DB, user: CurrentUser):
    """Abre o cierra la inscripción en línea por dojos (con fecha de cierre opcional)."""
    ensure_organizer(db, user, tid)
    return svc.set_self_registration(db, user, tid, data)


@router.get("/tournaments/{tid}/invitations", response_model=list[s.InvitationOut], tags=["self-registration"])
def list_invitations(tid: int, db: DB, user: CurrentUser):
    ensure_organizer(db, user, tid)
    return [svc.invitation_out(db, i) for i in svc.list_invitations(db, tid)]


@router.post(
    "/tournaments/{tid}/invitations", response_model=s.InvitationOut, status_code=201, tags=["self-registration"]
)
def create_invitation(tid: int, data: s.InvitationCreate, db: DB, user: CurrentUser):
    """Enlace de invitación para un dojo (``dojo_id``) o general (sin dojo)."""
    ensure_organizer(db, user, tid)
    return svc.invitation_out(db, svc.create_invitation(db, user, tid, data))


@router.delete("/invitations/{iid}", status_code=204, tags=["self-registration"])
def revoke_invitation(iid: int, db: DB, user: CurrentUser):
    inv = svc.get_invitation(db, iid)
    ensure_organizer(db, user, inv.tournament_id)
    svc.revoke_invitation(db, user, inv)


@router.get(
    "/tournaments/{tid}/registration-requests", response_model=s.RegistrationRequestsOut, tags=["self-registration"]
)
def registration_requests(tid: int, db: DB, user: CurrentUser):
    """Solicitudes pendientes: inscripciones de los dojos y pedidos de admin de dojo."""
    ensure_organizer(db, user, tid)
    return svc.requests(db, tid)


@router.get("/tournaments/{tid}/registration-requests/count", tags=["self-registration"])
def registration_requests_count(tid: int, db: DB, user: CurrentUser):
    ensure_organizer(db, user, tid)
    return {"count": svc.pending_count(db, tid)}


@router.post(
    "/tournaments/{tid}/registration-requests/decide",
    response_model=s.RegistrationDecisionOut,
    tags=["self-registration"],
)
def decide_registrations(tid: int, data: s.RegistrationDecisionIn, db: DB, user: CurrentUser):
    """Aprueba o rechaza (con motivo) inscripciones pendientes en lote."""
    ensure_organizer(db, user, tid)
    return svc.decide(db, user, tid, data)


@router.post("/dojo-admin-requests/{rid}/decide", response_model=s.DojoAdminRequestOut, tags=["self-registration"])
def decide_dojo_admin(rid: int, data: s.DecisionIn, db: DB, user: CurrentUser):
    req = svc.get_dojo_admin_request(db, rid)
    ensure_organizer(db, user, req.tournament_id)
    svc.decide_dojo_admin_request(db, user, req, data.approve)
    return next(r for r in svc.dojo_admin_requests(db, req.tournament_id, only_pending=False) if r.id == rid)


# --- Enlace de invitación -----------------------------------------------------------------


@router.get("/invitations/{token}", response_model=s.InvitationInfo, tags=["self-registration"])
def invitation_info(token: str, db: DB, user: CurrentUser):
    return svc.invitation_info(db, user, token)


@router.post("/invitations/{token}/accept", response_model=s.InvitationAcceptOut, tags=["self-registration"])
def accept_invitation(token: str, data: s.InvitationAccept, db: DB, user: CurrentUser):
    """Vincula a la cuenta como admin del dojo (o deja el pedido al organizador)."""
    return svc.accept_invitation(db, user, token, data)


# --- Portal del sensei ------------------------------------------------------------------------


@router.get("/dojo-portal/dojos", response_model=list[s.DojoOut], tags=["dojo-portal"])
def my_dojos(db: DB, user: CurrentUser):
    """Dojos que administra la cuenta (rol dojo_admin)."""
    ids = dojo_admin_ids(db, user)
    return [d for d in (db.get(Dojo, i) for i in sorted(ids)) if d is not None]


@router.get("/dojo-portal/dojos/{dojo_id}/competitors", response_model=list[s.PersonOut], tags=["dojo-portal"])
def competitors(dojo_id: int, db: DB, user: CurrentUser):
    """Personas con membresía vigente en el dojo (con documento y fecha de nacimiento)."""
    _ensure_dojo_admin(db, user, dojo_id)
    return svc.competitors(db, dojo_id)


@router.post(
    "/dojo-portal/dojos/{dojo_id}/competitors", response_model=s.PersonOut, status_code=201, tags=["dojo-portal"]
)
def create_competitor(dojo_id: int, data: s.PersonCreate, db: DB, user: CurrentUser):
    """Alta de un competidor del dojo (misma detección de duplicados que el organizador)."""
    _ensure_dojo_admin(db, user, dojo_id)
    data = data.model_copy(update={"dojo_id": dojo_id, "branch_id": None})
    try:
        p = people.create_person(db, user, data)
    except AppError as e:
        # Los posibles duplicados pueden ser de otro dojo: el sensei ve el
        # nombre para decidir, nunca su fecha de nacimiento (sección 11).
        for d in e.details.get("duplicates", []):
            d["birth_date"] = None
        raise
    return people.person_out(db, p, True)


@router.get("/dojo-portal/dojos/{dojo_id}/competitors/{pid}", response_model=s.PersonOut, tags=["dojo-portal"])
def get_competitor(dojo_id: int, pid: int, db: DB, user: CurrentUser):
    _ensure_dojo_admin(db, user, dojo_id)
    p = svc.ensure_person_in_dojo(db, dojo_id, pid)
    out = people.person_out(db, p, True)
    if out.documents or out.birth_date:
        people.log_sensitive_view(db, user, p.id)
    return out


@router.patch("/dojo-portal/dojos/{dojo_id}/competitors/{pid}", response_model=s.PersonOut, tags=["dojo-portal"])
def update_competitor(dojo_id: int, pid: int, data: s.PersonUpdate, db: DB, user: CurrentUser):
    _ensure_dojo_admin(db, user, dojo_id)
    svc.ensure_person_in_dojo(db, dojo_id, pid)
    return people.person_out(db, people.update_person(db, user, pid, data), True)


@router.post("/dojo-portal/dojos/{dojo_id}/competitors/{pid}/grades", status_code=201, tags=["dojo-portal"])
def add_competitor_grade(dojo_id: int, pid: int, data: s.GradeIn, db: DB, user: CurrentUser):
    _ensure_dojo_admin(db, user, dojo_id)
    svc.ensure_person_in_dojo(db, dojo_id, pid)
    g = people.add_grade(db, user, pid, data)
    return {"id": g.id, "grade": g.grade, "awarded_on": g.awarded_on}


@router.get("/dojo-portal/tournaments", response_model=list[s.OpenTournamentOut], tags=["dojo-portal"])
def open_tournaments(db: DB, user: CurrentUser):
    """Torneos con la inscripción en línea abierta."""
    if not dojo_admin_ids(db, user) and not user.is_admin:
        raise Forbidden("Solo los administradores de un dojo inscriben en línea")
    return svc.open_tournaments(db)


@router.get(
    "/dojo-portal/dojos/{dojo_id}/tournaments/{tid}/categories",
    response_model=list[s.CategoryOut],
    tags=["dojo-portal"],
)
def open_categories(dojo_id: int, tid: int, db: DB, user: CurrentUser):
    """Categorías individuales abiertas del torneo (para elegir dónde inscribir)."""
    from sqlalchemy import select

    from app.db.models import Category
    from app.services import tournaments as tsvc

    _ensure_dojo_admin(db, user, dojo_id)
    svc.ensure_open(get_tournament(db, tid))
    cats = db.scalars(
        select(Category)
        .where(Category.tournament_id == tid, Category.status.in_(("open", "empty")), ~Category.is_team)
        .order_by(Category.sort_order, Category.id)
    ).all()
    counts = tsvc.entrant_counts(db, tid)
    return [tsvc.category_out(db, c, counts.get(c.id, 0)) for c in cats]


@router.get(
    "/dojo-portal/dojos/{dojo_id}/tournaments/{tid}/suggestions",
    response_model=list[s.SuggestionOut],
    tags=["dojo-portal"],
)
def suggestions(dojo_id: int, tid: int, person_id: int, db: DB, user: CurrentUser, modality: str | None = None):
    """Mismas sugerencias de categoría que ve el organizador."""
    _ensure_dojo_admin(db, user, dojo_id)
    svc.ensure_open(get_tournament(db, tid))
    svc.ensure_person_in_dojo(db, dojo_id, person_id)
    return [
        s.SuggestionOut(category_id=c.id, name=c.name, modality=c.modality)
        for c in regs.suggestions(db, tid, person_id, modality)
        if not c.is_team
    ]


@router.post(
    "/dojo-portal/dojos/{dojo_id}/tournaments/{tid}/registrations",
    response_model=list[s.DojoRegistrationOut],
    status_code=201,
    tags=["dojo-portal"],
)
def submit(dojo_id: int, tid: int, data: s.DojoRegistrationBatch, db: DB, user: CurrentUser):
    """Envía las inscripciones del dojo: quedan pendientes hasta que el organizador las apruebe."""
    _ensure_dojo_admin(db, user, dojo_id)
    created = svc.submit(db, user, dojo_id, tid, data)
    return svc.with_names(db, created)


@router.get(
    "/dojo-portal/dojos/{dojo_id}/registrations", response_model=list[s.DojoRegistrationOut], tags=["dojo-portal"]
)
def dojo_registrations(dojo_id: int, db: DB, user: CurrentUser, tournament_id: int | None = Query(None)):
    """Inscripciones del dojo y su estado (pendiente, activa, rechazada con motivo, retirada)."""
    _ensure_dojo_admin(db, user, dojo_id)
    return svc.dojo_registrations(db, dojo_id, tournament_id)


@router.post(
    "/dojo-portal/dojos/{dojo_id}/registrations/{rid}/cancel",
    response_model=s.DojoRegistrationOut,
    tags=["dojo-portal"],
)
def cancel_request(dojo_id: int, rid: int, db: DB, user: CurrentUser):
    """Retira un pedido que el organizador aún no aprobó."""
    _ensure_dojo_admin(db, user, dojo_id)
    r = regs.get_registration(db, rid)
    if r.dojo_id != dojo_id:
        raise Forbidden("La inscripción no es de tu dojo")
    return svc.with_names(db, [svc.cancel_request(db, user, r)])[0]
