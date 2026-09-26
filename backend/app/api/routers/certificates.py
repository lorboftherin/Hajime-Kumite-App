"""Diplomas de podio y certificados de participación (PDF).

TODO(entitlements): al integrar, cada descarga exige la feature «certificates»
del plan del organizador (la crea el agente de organizaciones y planes).
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Response

from app.api.deps import DB, CurrentUser, can_view_documents
from app.api.errors import Forbidden
from app.services import certificates as svc
from app.services import people
from app.services.tournaments import get_category, get_tournament

router = APIRouter(tags=["certificates"])

Kind = Literal["podium", "participation", "all"]


def _pdf(content: bytes, filename: str) -> Response:
    return Response(
        content, media_type="application/pdf", headers={"Content-Disposition": f'inline; filename="{filename}"'}
    )


@router.get("/categories/{cid}/diplomas.pdf")
def category_diplomas(cid: int, db: DB, user: CurrentUser, kind: Kind = "all"):
    """Diplomas de una categoría finalizada: podio, participación o ambos."""
    c = get_category(db, cid)
    if not svc.can_download_dojo(db, user, c.tournament_id, None):
        raise Forbidden("Solo el organizador del torneo descarga los diplomas de una categoría")
    t, items = svc.category_diplomas(db, cid, kind)
    return _pdf(svc.diplomas_pdf(t, items, f"Diplomas — {c.name}"), f"diplomas-categoria-{cid}.pdf")


@router.get("/tournaments/{tid}/diplomas.pdf")
def tournament_diplomas(tid: int, db: DB, user: CurrentUser, dojo_id: int | None = None, kind: Kind = "all"):
    """Todos los diplomas del torneo o, con ``dojo_id``, los de los competidores de ese dojo."""
    get_tournament(db, tid)
    if not svc.can_download_dojo(db, user, tid, dojo_id):
        raise Forbidden("Solo el organizador del torneo o el sensei del dojo descargan estos diplomas")
    t, items = svc.tournament_diplomas(db, tid, kind, dojo_id=dojo_id)
    suffix = f"-dojo-{dojo_id}" if dojo_id else ""
    return _pdf(svc.diplomas_pdf(t, items, f"Diplomas — {t.name}"), f"diplomas-{tid}{suffix}.pdf")


@router.get("/tournaments/{tid}/persons/{person_id}/diplomas.pdf")
def person_diplomas(tid: int, person_id: int, db: DB, user: CurrentUser, kind: Kind = "all"):
    """Diplomas y certificados de una persona en el torneo: organizador o la propia persona."""
    get_tournament(db, tid)
    if not svc.can_download_person(db, user, tid, person_id):
        raise Forbidden("No puedes descargar los diplomas de esta persona")
    t, items = svc.tournament_diplomas(db, tid, kind, person_id=person_id)
    return _pdf(svc.diplomas_pdf(t, items, f"Diplomas — {t.name}"), f"diplomas-{tid}-persona-{person_id}.pdf")


@router.get("/persons/{person_id}/certificates")
def person_certificates(person_id: int, db: DB, user: CurrentUser):
    """Torneos donde la persona tiene diploma o certificado (para su perfil)."""
    if not can_view_documents(db, user) and user.person_id != person_id:
        raise Forbidden("Solo los organizadores ven los diplomas de otras personas")
    people.get_person(db, person_id)
    return svc.person_certificates(db, person_id)
