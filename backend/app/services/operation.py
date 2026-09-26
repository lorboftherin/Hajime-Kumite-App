"""Operación con varios tatamis y varios operadores a la vez (MVP-3).

Cada mesa abierta envía un latido; así la app avisa si dos tablets operan
el mismo combate y el organizador ve quién está en cada tatami. No bloquea:
los eventos ya son idempotentes y los cierres usan control de versión.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.db.base import utcnow
from app.db.models import Category, Match, MatchPresence, Person, PersonRole, User
from app.services.brackets import get_match

ACTIVE_SECONDS = 45
KEEP = timedelta(days=1)


def _user_name(u: User | None) -> str:
    if u is None:
        return "Alguien"
    return u.display_name or u.username


def heartbeat(db: Session, user: User, mid: int, device_id: str) -> dict[str, Any]:
    """Registra que este dispositivo tiene la mesa abierta y devuelve los demás."""
    get_match(db, mid)
    now = utcnow()
    row = db.scalar(select(MatchPresence).where(MatchPresence.match_id == mid, MatchPresence.device_id == device_id))
    if row is None:
        db.add(MatchPresence(match_id=mid, device_id=device_id, user_id=user.id, first_seen=now, last_seen=now))
    else:
        row.last_seen = now
        row.user_id = user.id
    db.execute(delete(MatchPresence).where(MatchPresence.last_seen < now - KEEP))
    db.commit()
    others = db.scalars(
        select(MatchPresence).where(
            MatchPresence.match_id == mid,
            MatchPresence.device_id != device_id,
            MatchPresence.last_seen >= now - timedelta(seconds=ACTIVE_SECONDS),
        )
    ).all()
    return {
        "others": [
            {
                "user": _user_name(db.get(User, o.user_id) if o.user_id else None),
                "same_user": o.user_id == user.id,
                "since": o.first_seen.isoformat() + "Z",
            }
            for o in others
        ]
    }


def leave(db: Session, mid: int, device_id: str) -> None:
    db.execute(delete(MatchPresence).where(MatchPresence.match_id == mid, MatchPresence.device_id == device_id))
    db.commit()


def tatami_operators(db: Session, tatami_id: int) -> list[dict[str, Any]]:
    """Quién tiene abierta una mesa de este tatami ahora (incluye combates por equipos).

    Una sola consulta, con el usuario: la mesa pide la cola del tatami seguido."""
    since = utcnow() - timedelta(seconds=ACTIVE_SECONDS)
    rows = db.execute(
        select(MatchPresence.user_id, Match.code, User)
        .join(Match, Match.id == MatchPresence.match_id)
        .join(Category, Category.id == Match.category_id)
        .outerjoin(User, User.id == MatchPresence.user_id)
        .where(Category.tatami_id == tatami_id, MatchPresence.last_seen >= since)
    ).all()
    out: dict[int | None, dict[str, Any]] = {}
    for user_id, code, u in rows:
        entry = out.setdefault(user_id, {"user": _user_name(u), "matches": set()})
        entry["matches"].add(code)
    return [{"user": e["user"], "matches": sorted(e["matches"])} for e in out.values()]


def assigned_operators(db: Session, tatami_id: int) -> list[str]:
    """Personas con rol de operador de mesa limitado a este tatami."""
    # Solo columnas: cargar la persona completa arrastraría sus documentos y roles.
    rows = db.execute(
        select(Person.first_names, Person.last_names)
        .join(PersonRole, PersonRole.person_id == Person.id)
        .where(PersonRole.role == "table_operator", PersonRole.scope_type == "tatami", PersonRole.scope_id == tatami_id)
        .order_by(PersonRole.id)
    ).all()
    return [f"{first} {last}" for first, last in rows]
