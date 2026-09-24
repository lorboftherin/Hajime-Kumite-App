from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import inspect
from sqlalchemy.orm import Session

from app.api.errors import VersionConflict, WarningsRequireOverride
from app.db.models import AuditEntry, RuleOverride, User


def snapshot(obj: Any, fields: list[str] | None = None) -> dict[str, Any]:
    """Foto serializable de una entidad (columnas) para la auditoría."""
    mapper = inspect(obj).mapper
    out: dict[str, Any] = {}
    for col in mapper.column_attrs:
        k = col.key
        if fields and k not in fields:
            continue
        if k in ("created_at", "updated_at", "password_hash"):
            continue
        v = getattr(obj, k)
        if isinstance(v, date | datetime):
            v = v.isoformat()
        elif isinstance(v, Decimal):
            v = float(v)
        out[k] = v
    return out


def audit(
    db: Session,
    user: User | None,
    entity: str,
    entity_id: Any,
    action: str,
    before: dict[str, Any] | None = None,
    after: dict[str, Any] | None = None,
    reason: str | None = None,
    tournament_id: int | None = None,
) -> None:
    if before is not None and after is not None:
        changed = {k for k in set(before) | set(after) if before.get(k) != after.get(k)}
        before = {k: before.get(k) for k in changed}
        after = {k: after.get(k) for k in changed}
    db.add(
        AuditEntry(
            user_id=user.id if user else None,
            tournament_id=tournament_id,
            entity=entity,
            entity_id=str(entity_id),
            action=action,
            before=before,
            after=after,
            reason=reason,
        )
    )


def check_version(obj: Any, expected: int | None, label: str) -> None:
    if expected is not None and obj.version != expected:
        raise VersionConflict(label, obj.version)


def bump(obj: Any, user: User | None) -> None:
    obj.version = (obj.version or 0) + 1
    if user is not None and hasattr(obj, "updated_by_id"):
        obj.updated_by_id = user.id


def apply_warnings(
    db: Session,
    user: User | None,
    warnings: list[dict[str, str]],
    override_reason: str | None,
    entity: str,
    entity_id_getter,
) -> None:
    """Principio "advertir, no bloquear": si hay advertencias sin override se
    rechaza con 409 WARNINGS; con override se registra cada una.

    ``entity_id_getter`` se llama después del flush para obtener el id.
    """
    if not warnings:
        return
    if not override_reason or not override_reason.strip():
        raise WarningsRequireOverride(warnings)
    db.flush()
    eid = entity_id_getter()
    for w in warnings:
        db.add(
            RuleOverride(
                entity=entity,
                entity_id=eid,
                code=w["code"],
                message=w["message"],
                reason=override_reason.strip(),
                user_id=user.id if user else None,
            )
        )
