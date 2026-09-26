"""Reglas deportivas: cambios con la llave generada, divisiones de categoría,
kata (orden de salida, notas en llave, catálogo) y valores por defecto de
las reglas configurables (docs/reglas-configurables.md)."""

from __future__ import annotations

import json
from dataclasses import asdict
from functools import lru_cache
from pathlib import Path

from fastapi import APIRouter

from app.api import schemas as s
from app.api.deps import DB, CurrentUser, ensure_operator, ensure_organizer
from app.domain.brackets import RR_CRITERIA
from app.domain.kumite import INFRACTIONS, KumiteRules
from app.services import bracket_changes
from app.services import brackets as svc
from app.services import registrations as regs
from app.services import tournaments as tsvc

router = APIRouter()

CATALOG = Path(__file__).resolve().parents[2] / "data" / "katas.json"


# --- Llave generada: entrar y salir ------------------------------------------------


@router.post("/categories/{cid}/bracket/entrants", tags=["brackets"])
def add_entrant(cid: int, data: s.BracketEntrantIn, db: DB, user: CurrentUser):
    """Inscripción tardía: ocupa un bye de primera ronda aún no disputado (el
    que mejor separa dojos); en round robin agrega sus combates."""
    ensure_organizer(db, user, tsvc.get_category(db, cid).tournament_id)
    return bracket_changes.add_entrant(db, user, cid, data)


@router.post("/categories/{cid}/bracket/entrants/remove", tags=["brackets"])
def remove_entrant(cid: int, data: s.BracketEntrantIn, db: DB, user: CurrentUser):
    """Quita a un competidor de la llave (bye si su combate no empezó; si no,
    walkover en el pendiente) y retira su inscripción."""
    ensure_organizer(db, user, tsvc.get_category(db, cid).tournament_id)
    return bracket_changes.remove_entrant(db, user, cid, data)


@router.post("/registrations/{rid}/disqualify", tags=["registrations"])
def disqualify(rid: int, data: s.DisqualifyIn, db: DB, user: CurrentUser):
    """Shikkaku con alcance de torneo: retira todas sus inscripciones (con confirmación)."""
    ensure_organizer(db, user, regs.get_registration(db, rid).tournament_id)
    return bracket_changes.disqualify(db, user, rid, data)


# --- Divisiones de categoría --------------------------------------------------------


@router.post("/categories/{cid}/split", response_model=s.CategoryOut, tags=["categories"])
def split_category(cid: int, data: s.CategorySplitIn, db: DB, user: CurrentUser):
    """Divide la categoría en dos (por peso, grado o sorteo). Devuelve la nueva."""
    ensure_organizer(db, user, tsvc.get_category(db, cid).tournament_id)
    return tsvc.category_out(db, tsvc.split_category(db, user, cid, data))


@router.post("/categories/{cid}/unsplit", response_model=s.CategoryOut, tags=["categories"])
def undo_split(cid: int, db: DB, user: CurrentUser):
    ensure_organizer(db, user, tsvc.get_category(db, cid).tournament_id)
    return tsvc.category_out(db, tsvc.undo_split(db, user, cid))


# --- Kata -----------------------------------------------------------------------------


@router.put("/categories/{cid}/kata-order", response_model=s.BracketOut, tags=["kata"])
def kata_order(cid: int, data: s.KataOrderIn, db: DB, user: CurrentUser):
    """Orden de salida de la ronda de kata (lista completa)."""
    ensure_organizer(db, user, tsvc.get_category(db, cid).tournament_id)
    return svc.set_kata_order(db, user, cid, data)


@router.post("/matches/{mid}/kata-scores", tags=["kata"])
def kata_match_scores(mid: int, data: s.KataMatchScoreIn, db: DB, user: CurrentUser):
    """Kata por puntuación en llave: nota del panel para aka y ao; gana la mayor."""
    c = tsvc.get_category(db, svc.get_match(db, mid).category_id)
    ensure_operator(db, user, c.tournament_id, c.tatami_id)
    return svc.record_kata_match_scores(db, user, mid, data)


@lru_cache(maxsize=1)
def _catalog() -> dict:
    data = json.loads(CATALOG.read_text(encoding="utf-8"))
    names = sorted({k for st in data["styles"] for k in st["katas"]})
    return {"styles": data["styles"], "katas": names}


@router.get("/kata-catalog", tags=["kata"])
def kata_catalog(_: CurrentUser):
    """Catálogo de katas de los cuatro estilos principales (para autocompletar)."""
    return _catalog()


# --- Reglas configurables: valores por defecto ------------------------------------


@router.get("/rules/defaults", tags=["tournaments"])
def rules_defaults(_: CurrentUser):
    """Valores por defecto de cada opción configurable (para los formularios)."""
    kumite = asdict(KumiteRules())
    kumite["time_mode"] = kumite["time_mode"].value
    kumite["tie_rule"] = kumite["tie_rule"].value
    kumite["sanction_preset"] = kumite["sanction_preset"].value
    return {
        "kumite": {
            **kumite,
            "team_bouts": 3,
            "team_tie_rule": "points",
            "team_extra_bout_tie": "hantei",
            "team_empty_slot_walkover": True,
            "team_lock_order": True,
            "team_min_starters": None,
        },
        "kata": tsvc.KATA_DEFAULTS,
        "competition": tsvc.COMPETITION_DEFAULTS,
        "round_robin_criteria": list(RR_CRITERIA),
        "infractions": {k: {"label": label, "ladder": ladder} for k, (label, ladder) in INFRACTIONS.items()},
        "age_modes": ["date", "birth_year"],
    }
