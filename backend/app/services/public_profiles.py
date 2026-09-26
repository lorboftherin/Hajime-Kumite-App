"""Perfil público básico del competidor, sin inicio de sesión (``/competidor/<public_id>``).

Solo lo que ya es público en el vivo y los resultados: nombre (abreviado si es
menor o si no se conoce su edad), dojo, medallas y torneos ya disputados. Nunca
documento, fecha de nacimiento, datos de contacto, rivales ni el id interno.
Se excluyen los torneos de prueba y los que aún no empiezan (no se anuncia
dónde estará un menor).
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Tournament
from app.services import claims, history


def public_profile(db: Session, public_id: str) -> dict[str, Any]:
    p = claims.by_public_id(db, public_id)
    full = history.person_history(db, p.id)
    ids = {e["tournament_id"] for e in full["tournaments"]}
    visible = set(
        db.scalars(
            select(Tournament.id).where(
                Tournament.id.in_(ids or {0}),
                ~Tournament.is_test,
                Tournament.status.in_(claims.PUBLIC_TOURNAMENT_STATUSES),
            )
        ).all()
    )
    entries = [
        {
            "tournament_name": e["tournament_name"],
            "date": e["date"],
            "category_name": e["category_name"],
            "team_name": e["team_name"],
            "dojo_name": e["dojo_name"],
            "place": e["place"],
        }
        for e in full["tournaments"]
        if e["tournament_id"] in visible and e["status"] != "withdrawn"
    ]
    _, dojo = claims.dojo_name(db, p.id)
    return {
        "public_id": p.public_id,
        "name": claims.public_name(p),
        "dojo": dojo,
        "medals": {
            "gold": sum(1 for e in entries if e["place"] == 1),
            "silver": sum(1 for e in entries if e["place"] == 2),
            "bronze": sum(1 for e in entries if e["place"] == 3),
        },
        "tournament_count": len({(e["tournament_name"], e["date"]) for e in entries}),
        "tournaments": entries,
    }
