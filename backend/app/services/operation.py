"""Operación con varios tatamis y varios operadores a la vez (MVP-3).

Cada mesa abierta envía un latido; así el organizador ve quién está en cada
tatami. Una sola tablet «lleva la mesa» de un combate: la primera que la
abre, o la que pulsa «Tomar la mesa». Las demás quedan en solo lectura y sus
eventos se rechazan con 409 ``CONFLICT_DEVICE`` (si envían ``X-Device-Id``).
Si la dueña deja de latir más de ``ACTIVE_SECONDS``, la siguiente tablet
activa la toma sola al latir.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.api.errors import Conflict
from app.db.base import utcnow
from app.db.models import Category, Match, MatchPresence, Person, PersonRole, User
from app.services.audit import audit
from app.services.brackets import get_match

ACTIVE_SECONDS = 45
KEEP = timedelta(days=1)


def _user_name(u: User | None) -> str:
    if u is None:
        return "Alguien"
    return u.display_name or u.username


def _fresh_owner(db: Session, mid: int, now) -> MatchPresence | None:
    """La tablet que lleva la mesa, si sigue latiendo."""
    return db.scalar(
        select(MatchPresence).where(
            MatchPresence.match_id == mid,
            MatchPresence.is_primary,
            MatchPresence.last_seen >= now - timedelta(seconds=ACTIVE_SECONDS),
        )
    )


def _make_owner(db: Session, mid: int, row: MatchPresence) -> None:
    for other in db.scalars(select(MatchPresence).where(MatchPresence.match_id == mid, MatchPresence.is_primary)):
        other.is_primary = False
    row.is_primary = True


def _touch(db: Session, user: User, mid: int, device_id: str, now) -> MatchPresence:
    row = db.scalar(select(MatchPresence).where(MatchPresence.match_id == mid, MatchPresence.device_id == device_id))
    if row is None:
        row = MatchPresence(
            match_id=mid, device_id=device_id, user_id=user.id, first_seen=now, last_seen=now, is_primary=False
        )
        db.add(row)
    else:
        row.last_seen = now
        row.user_id = user.id
    return row


def _presence_out(db: Session, user: User, mid: int, device_id: str, now, owner: MatchPresence | None):
    others = db.scalars(
        select(MatchPresence).where(
            MatchPresence.match_id == mid,
            MatchPresence.device_id != device_id,
            MatchPresence.last_seen >= now - timedelta(seconds=ACTIVE_SECONDS),
        )
    ).all()
    primary = owner is not None and owner.device_id == device_id
    return {
        "others": [
            {
                "user": _user_name(db.get(User, o.user_id) if o.user_id else None),
                "same_user": o.user_id == user.id,
                "since": o.first_seen.isoformat() + "Z",
            }
            for o in others
        ],
        "primary": primary,
        "owner": None
        if primary or owner is None
        else {
            "user": _user_name(db.get(User, owner.user_id) if owner.user_id else None),
            "same_user": owner.user_id == user.id,
        },
    }


def heartbeat(db: Session, user: User, mid: int, device_id: str, *, can_own: bool = True) -> dict[str, Any]:
    """Registra que este dispositivo tiene la mesa abierta y devuelve los demás.

    Si nadie lleva la mesa (o la dueña dejó de latir), la toma este dispositivo,
    salvo que su usuario no pueda operar el combate (solo mira).
    """
    get_match(db, mid)
    now = utcnow()
    row = _touch(db, user, mid, device_id, now)
    db.flush()
    owner = _fresh_owner(db, mid, now)
    if owner is None and can_own:
        _make_owner(db, mid, row)
        owner = row
    db.execute(delete(MatchPresence).where(MatchPresence.last_seen < now - KEEP))
    db.commit()
    return _presence_out(db, user, mid, device_id, now, owner)


def take(db: Session, user: User, mid: int, device_id: str) -> dict[str, Any]:
    """«Tomar la mesa»: este dispositivo pasa a registrar; los demás quedan en solo lectura."""
    m = get_match(db, mid)
    now = utcnow()
    before = _fresh_owner(db, mid, now)
    row = _touch(db, user, mid, device_id, now)
    db.flush()
    if before is None or before.device_id != device_id:
        _make_owner(db, mid, row)
        c = db.get(Category, m.category_id)
        audit(
            db,
            user,
            "match",
            mid,
            "take_table",
            {"device": before.device_id[:8] if before else None},
            {"device": device_id[:8]},
            tournament_id=c.tournament_id if c else None,
        )
    db.commit()
    return _presence_out(db, user, mid, device_id, now, row)


def ensure_device(db: Session, mid: int, device_id: str | None) -> None:
    """Rechaza eventos de una tablet que no lleva la mesa (409 CONFLICT_DEVICE).

    Sin ``X-Device-Id`` (scripts, versiones anteriores) no se comprueba nada.
    """
    if not device_id:
        return
    owner = _fresh_owner(db, mid, utcnow())
    if owner is not None and owner.device_id != device_id:
        raise Conflict(
            "Otra tablet lleva la mesa de este combate. Pulsa «Tomar la mesa» para registrar desde aquí.",
            code="CONFLICT_DEVICE",
        )


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
