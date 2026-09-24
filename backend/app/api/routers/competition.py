"""Llaves, combates (mesa de kumite), kata, resultados y reportes."""

from __future__ import annotations

from fastapi import APIRouter, Response
from fastapi.responses import JSONResponse

from app.api import schemas as s
from app.api.deps import DB, CurrentUser, ensure_operator, ensure_organizer
from app.api.errors import NotFound
from app.db.models import Bracket
from app.services import brackets as svc
from app.services import reports
from app.services.tournaments import get_category

router = APIRouter()


def _tid_of_match(db, mid: int) -> int:
    return get_category(db, svc.get_match(db, mid).category_id).tournament_id


XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


# --- Llaves ---------------------------------------------------------------------


@router.post("/categories/{cid}/bracket", response_model=s.BracketOut, tags=["brackets"])
def generate_bracket(cid: int, data: s.BracketGenerateIn, db: DB, user: CurrentUser):
    ensure_organizer(db, user, get_category(db, cid).tournament_id)
    svc.generate(db, user, cid, data)
    return svc.bracket_out(db, cid)


@router.get("/categories/{cid}/bracket", response_model=s.BracketOut, tags=["brackets"])
def get_bracket(cid: int, db: DB, _: CurrentUser):
    return svc.bracket_out(db, cid)


@router.get("/categories/{cid}/bracket/versions", tags=["brackets"])
def bracket_versions(cid: int, db: DB, _: CurrentUser):
    return svc.bracket_versions(db, cid)


@router.patch("/brackets/{bid}/slots", response_model=s.BracketOut, tags=["brackets"])
def swap_slots(bid: int, data: s.SlotSwapIn, db: DB, user: CurrentUser):
    b = db.get(Bracket, bid)
    if b is None:
        raise NotFound("Llave no encontrada")
    ensure_organizer(db, user, get_category(db, b.category_id).tournament_id)
    svc.swap_slots(db, user, bid, data)
    return svc.bracket_out(db, b.category_id)


@router.get("/categories/{cid}/bracket.pdf", tags=["brackets"])
def bracket_pdf(cid: int, db: DB, _: CurrentUser, blank: bool = False):
    pdf = reports.bracket_pdf(db, cid, with_results=not blank)
    return Response(
        pdf, media_type="application/pdf", headers={"Content-Disposition": f'inline; filename="llave-{cid}.pdf"'}
    )


@router.post("/categories/{cid}/reopen", tags=["brackets"])
def reopen_category(cid: int, data: s.CategoryCancelIn, db: DB, user: CurrentUser):
    """Reabre una categoría finalizada con motivo (sección 12), sin reabrir el torneo."""
    ensure_organizer(db, user, get_category(db, cid).tournament_id)
    c = svc.reopen_category(db, user, cid, data.reason)
    return {"id": c.id, "status": c.status, "version": c.version}


# --- Mesa de kumite ---------------------------------------------------------------


@router.get("/matches/{mid}", response_model=s.ScoreboardOut, tags=["matches"])
def get_match(mid: int, db: DB, _: CurrentUser):
    return svc.scoreboard(db, svc.get_match(db, mid))


@router.post("/matches/{mid}/events", response_model=s.ScoreboardOut, tags=["matches"])
def add_event(mid: int, data: s.EventIn, db: DB, user: CurrentUser):
    """Idempotente: reenviar el mismo ``id`` devuelve 200 sin duplicar."""
    ensure_operator(db, user, _tid_of_match(db, mid))
    sb, created = svc.add_event(db, user, mid, data)
    return JSONResponse(sb.model_dump(mode="json"), status_code=201 if created else 200)


@router.post("/matches/{mid}/finish", tags=["matches"])
def finish(mid: int, data: s.FinishIn, db: DB, user: CurrentUser):
    ensure_operator(db, user, _tid_of_match(db, mid))
    sb, affected = svc.finish(db, user, mid, data)
    return {"scoreboard": sb.model_dump(mode="json"), "affected_matches": affected}


@router.post("/matches/{mid}/official-result", tags=["shadow"])
def official_result(mid: int, data: s.OfficialResultIn, db: DB, user: CurrentUser):
    ensure_operator(db, user, _tid_of_match(db, mid))
    sc = reports.set_official_result(db, user, mid, data)
    return {"match_id": sc.match_id, "official_winner_registration_id": sc.official_winner_registration_id}


# --- Kata -------------------------------------------------------------------------


@router.post("/matches/{mid}/flags", tags=["kata"])
def flags(mid: int, data: s.FlagsIn, db: DB, user: CurrentUser):
    ensure_operator(db, user, _tid_of_match(db, mid))
    return svc.record_flags(db, user, mid, data)


@router.post("/categories/{cid}/kata-scores", response_model=s.BracketOut, tags=["kata"])
def kata_score(cid: int, data: s.KataScoreIn, db: DB, user: CurrentUser):
    ensure_operator(db, user, get_category(db, cid).tournament_id)
    return svc.record_kata_score(db, user, cid, data)


@router.post("/categories/{cid}/kata-tie-break", response_model=s.BracketOut, tags=["kata"])
def kata_tie_break(cid: int, data: s.TieBreakIn, db: DB, user: CurrentUser):
    ensure_organizer(db, user, get_category(db, cid).tournament_id)
    return svc.resolve_kata_tie(db, user, cid, data)


# --- Resultados y reportes ------------------------------------------------------------


@router.get("/tournaments/{tid}/results", tags=["results"])
def results(tid: int, db: DB, _: CurrentUser):
    return reports.category_results(db, tid)


@router.get("/tournaments/{tid}/medal-table", tags=["results"])
def medal_table(tid: int, db: DB, _: CurrentUser):
    return reports.medal_table(db, tid)


@router.get("/tournaments/{tid}/comparison-report", tags=["shadow"])
def comparison_report(tid: int, db: DB, _: CurrentUser):
    return reports.comparison_report(db, tid)


@router.get("/tournaments/{tid}/results.xlsx", tags=["results"])
def results_xlsx(tid: int, db: DB, _: CurrentUser):
    return Response(
        reports.results_excel(db, tid),
        media_type=XLSX,
        headers={"Content-Disposition": f'attachment; filename="resultados-{tid}.xlsx"'},
    )


@router.get("/tournaments/{tid}/results.pdf", tags=["results"])
def results_pdf(tid: int, db: DB, _: CurrentUser):
    return Response(
        reports.results_pdf(db, tid),
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="resultados-{tid}.pdf"'},
    )
