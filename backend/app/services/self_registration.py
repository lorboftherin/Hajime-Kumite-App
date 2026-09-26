"""Autoinscripción por dojo (Fase 4).

El organizador abre la inscripción en línea del torneo (con fecha de cierre
opcional) y reparte enlaces de invitación: uno por dojo o uno general. El
sensei con rol ``dojo_admin`` de su dojo inscribe a sus alumnos con las mismas
sugerencias y advertencias que el organizador; esas inscripciones quedan
``pending`` (no entran a las llaves ni a los conteos) hasta que el organizador
las aprueba o las rechaza con motivo.
"""

from __future__ import annotations

import logging
import secrets
from datetime import UTC, date

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api import schemas as s
from app.api.deps import dojo_admin_ids, forget_roles
from app.api.errors import Conflict, Forbidden, InvalidState, NotFound, WarningsRequireOverride
from app.config import get_settings
from app.db.base import utcnow
from app.db.models import (
    Category,
    Dojo,
    DojoAdminRequest,
    DojoMembership,
    Person,
    PersonRole,
    Registration,
    Tournament,
    TournamentInvitation,
    User,
)
from app.domain.categories import age_at, grade_to_ordinal
from app.services import entitlements, mail, people
from app.services.audit import apply_warnings, audit, bump, snapshot
from app.services.registrations import _warnings, registration_out
from app.services.tournaments import get_category, get_tournament, refresh_category_status

log = logging.getLogger("hajime.autoinscripcion")

# Estados del torneo en los que se aceptan pedidos de inscripción.
SELF_REGISTRATION_STATUSES = ("draft", "registration_open")


# --- Estado de la autoinscripción --------------------------------------------------


def is_open(t: Tournament) -> bool:
    if not t.self_registration_open or t.status not in SELF_REGISTRATION_STATUSES:
        return False
    return t.self_registration_closes_at is None or t.self_registration_closes_at > utcnow()


def ensure_open(t: Tournament) -> None:
    if not is_open(t):
        raise InvalidState("La inscripción en línea de este torneo está cerrada", code="SELF_REGISTRATION_CLOSED")


def set_self_registration(db: Session, user: User, tid: int, data: s.SelfRegistrationIn) -> Tournament:
    t = get_tournament(db, tid)
    if data.open:
        entitlements.require_for_tournament(db, user, t, "dojo_self_registration")
        if t.status not in SELF_REGISTRATION_STATUSES:
            raise InvalidState("Solo se abre la inscripción en línea antes de cerrar las inscripciones")
    before = {"open": t.self_registration_open, "closes_at": str(t.self_registration_closes_at)}
    closes = data.closes_at
    if closes is not None and closes.tzinfo is not None:
        closes = closes.astimezone(UTC).replace(tzinfo=None)  # en la base, UTC sin zona
    t.self_registration_open = data.open
    t.self_registration_closes_at = closes
    bump(t, user)
    audit(
        db,
        user,
        "tournament",
        t.id,
        "self_registration",
        before,
        {"open": t.self_registration_open, "closes_at": str(t.self_registration_closes_at)},
        tournament_id=t.id,
    )
    db.commit()
    db.refresh(t)
    return t


def open_tournaments(db: Session) -> list[s.OpenTournamentOut]:
    """Torneos con la inscripción en línea abierta (cualquier organización)."""
    rows = db.scalars(
        select(Tournament)
        .where(
            Tournament.self_registration_open,
            Tournament.status.in_(SELF_REGISTRATION_STATUSES),
        )
        .order_by(Tournament.start_date)
    ).all()
    return [
        s.OpenTournamentOut(
            id=t.id,
            name=t.name,
            start_date=t.start_date,
            end_date=t.end_date,
            venue=t.venue,
            city=t.city,
            organization_name=t.organization_name,
            self_registration_closes_at=t.self_registration_closes_at,
        )
        for t in rows
        if is_open(t)
    ]


# --- Invitaciones -------------------------------------------------------------------


def invitation_out(db: Session, inv: TournamentInvitation) -> s.InvitationOut:
    out = s.InvitationOut.model_validate(inv)
    if inv.dojo_id is not None:
        d = db.get(Dojo, inv.dojo_id)
        out.dojo_name = d.name if d else None
    return out


def create_invitation(db: Session, user: User, tid: int, data: s.InvitationCreate) -> TournamentInvitation:
    t = get_tournament(db, tid)
    entitlements.require_for_tournament(db, user, t, "dojo_self_registration")
    if data.dojo_id is not None:
        people.get_dojo(db, data.dojo_id)
    inv = TournamentInvitation(
        tournament_id=t.id, dojo_id=data.dojo_id, token=secrets.token_urlsafe(24), created_by_id=user.id
    )
    db.add(inv)
    db.flush()
    audit(db, user, "invitation", inv.id, "create", after={"dojo_id": data.dojo_id}, tournament_id=t.id)
    db.commit()
    db.refresh(inv)
    return inv


def list_invitations(db: Session, tid: int) -> list[TournamentInvitation]:
    return list(
        db.scalars(
            select(TournamentInvitation)
            .where(TournamentInvitation.tournament_id == tid)
            .order_by(TournamentInvitation.id.desc())
        ).all()
    )


def get_invitation(db: Session, iid: int) -> TournamentInvitation:
    inv = db.get(TournamentInvitation, iid)
    if inv is None:
        raise NotFound("Invitación no encontrada")
    return inv


def revoke_invitation(db: Session, user: User, inv: TournamentInvitation) -> None:
    if inv.revoked_at is None:
        inv.revoked_at = utcnow()
        audit(db, user, "invitation", inv.id, "revoke", tournament_id=inv.tournament_id)
        db.commit()


def _by_token(db: Session, token: str) -> TournamentInvitation:
    inv = db.scalar(select(TournamentInvitation).where(TournamentInvitation.token == token))
    if inv is None or inv.revoked_at is not None:
        raise NotFound("La invitación no existe o fue revocada")
    return inv


def invitation_info(db: Session, user: User, token: str) -> s.InvitationInfo:
    inv = _by_token(db, token)
    t = get_tournament(db, inv.tournament_id)
    dojo = db.get(Dojo, inv.dojo_id) if inv.dojo_id else None
    mine = dojo_admin_ids(db, user)
    return s.InvitationInfo(
        tournament_id=t.id,
        tournament_name=t.name,
        organization_name=t.organization_name,
        start_date=t.start_date,
        dojo_id=dojo.id if dojo else None,
        dojo_name=dojo.name if dojo else None,
        self_registration_open=is_open(t),
        already_admin=bool(dojo and dojo.id in mine),
        my_dojo_ids=sorted(mine),
    )


def _dojo_admin_people(db: Session, dojo_id: int) -> list[int]:
    return list(
        db.scalars(
            select(PersonRole.person_id).where(
                PersonRole.role == "dojo_admin", PersonRole.scope_type == "dojo", PersonRole.scope_id == dojo_id
            )
        ).all()
    )


def _grant_dojo_admin(db: Session, actor: User | None, target: User, dojo_id: int, tid: int) -> None:
    if target.person_id is None:
        raise InvalidState(
            "Tu cuenta no está ligada a una persona: pide al organizador que la vincule",
            code="PERSON_REQUIRED",
        )
    db.add(PersonRole(person_id=target.person_id, role="dojo_admin", scope_type="dojo", scope_id=dojo_id))
    audit(
        db,
        actor,
        "person",
        target.person_id,
        "add_role",
        after={"role": "dojo_admin", "scope_type": "dojo", "scope_id": dojo_id},
        tournament_id=tid,
    )
    forget_roles(db)


def accept_invitation(db: Session, user: User, token: str, data: s.InvitationAccept) -> s.InvitationAcceptOut:
    """Vincula el rol ``dojo_admin`` del dojo del enlace. Si el dojo ya tiene
    otro admin (o el enlace es general), queda un pedido que aprueba el organizador."""
    inv = _by_token(db, token)
    dojo_id = inv.dojo_id if inv.dojo_id is not None else data.dojo_id
    if dojo_id is None:
        raise InvalidState("Elige tu dojo", code="DOJO_REQUIRED")
    people.get_dojo(db, dojo_id)
    if user.person_id is None:
        raise InvalidState(
            "Tu cuenta no está ligada a una persona: pide al organizador que la vincule",
            code="PERSON_REQUIRED",
        )
    out = {"dojo_id": dojo_id, "tournament_id": inv.tournament_id}
    if dojo_id in dojo_admin_ids(db, user):
        return s.InvitationAcceptOut(status="already_admin", **out)
    inv.uses = (inv.uses or 0) + 1
    others = [pid for pid in _dojo_admin_people(db, dojo_id) if pid != user.person_id]
    if inv.dojo_id is not None and not others:
        _grant_dojo_admin(db, user, user, dojo_id, inv.tournament_id)
        db.commit()
        return s.InvitationAcceptOut(status="granted", **out)
    pending = db.scalar(
        select(DojoAdminRequest).where(
            DojoAdminRequest.user_id == user.id,
            DojoAdminRequest.dojo_id == dojo_id,
            DojoAdminRequest.status == "pending",
        )
    )
    if pending is None:
        req = DojoAdminRequest(
            tournament_id=inv.tournament_id, invitation_id=inv.id, dojo_id=dojo_id, user_id=user.id, status="pending"
        )
        db.add(req)
        db.flush()
        audit(
            db,
            user,
            "dojo_admin_request",
            req.id,
            "create",
            after={"dojo_id": dojo_id},
            tournament_id=inv.tournament_id,
        )
    db.commit()
    return s.InvitationAcceptOut(status="pending_approval", **out)


def dojo_admin_requests(db: Session, tid: int, only_pending: bool = True) -> list[s.DojoAdminRequestOut]:
    stmt = select(DojoAdminRequest).where(DojoAdminRequest.tournament_id == tid)
    if only_pending:
        stmt = stmt.where(DojoAdminRequest.status == "pending")
    out = []
    for r in db.scalars(stmt.order_by(DojoAdminRequest.id)).all():
        u = db.get(User, r.user_id)
        d = db.get(Dojo, r.dojo_id)
        admins = _dojo_admin_people(db, r.dojo_id)
        names = [
            f"{p.first_names} {p.last_names}" for p in db.scalars(select(Person).where(Person.id.in_(admins or [0])))
        ]
        out.append(
            s.DojoAdminRequestOut(
                id=r.id,
                tournament_id=r.tournament_id,
                dojo_id=r.dojo_id,
                dojo_name=d.name if d else "",
                user_id=r.user_id,
                username=u.username if u else "",
                display_name=u.display_name if u else "",
                status=r.status,
                created_at=r.created_at,
                current_admins=names,
            )
        )
    return out


def get_dojo_admin_request(db: Session, rid: int) -> DojoAdminRequest:
    r = db.get(DojoAdminRequest, rid)
    if r is None:
        raise NotFound("Pedido no encontrado")
    return r


def decide_dojo_admin_request(db: Session, user: User, req: DojoAdminRequest, approve: bool) -> DojoAdminRequest:
    if req.status != "pending":
        raise InvalidState("El pedido ya fue resuelto")
    target = db.get(User, req.user_id)
    if target is None:
        raise NotFound("Usuario no encontrado")
    if approve:
        target_roles = {
            r.scope_id
            for r in db.scalars(
                select(PersonRole).where(
                    PersonRole.person_id == target.person_id,
                    PersonRole.role == "dojo_admin",
                    PersonRole.scope_type == "dojo",
                )
            )
        }
        if req.dojo_id not in target_roles:
            _grant_dojo_admin(db, user, target, req.dojo_id, req.tournament_id)
    req.status = "approved" if approve else "rejected"
    req.decided_at = utcnow()
    req.decided_by_id = user.id
    audit(
        db,
        user,
        "dojo_admin_request",
        req.id,
        "approve" if approve else "reject",
        tournament_id=req.tournament_id,
    )
    db.commit()
    return req


# --- Competidores del dojo ------------------------------------------------------------


def dojo_person_ids(db: Session, dojo_id: int, at: date | None = None) -> list[int]:
    """Personas con membresía vigente en el dojo (a la fecha indicada o hoy)."""
    at = at or date.today()
    rows = db.scalars(
        select(DojoMembership)
        .where(DojoMembership.dojo_id == dojo_id, DojoMembership.start_date <= at)
        .order_by(DojoMembership.person_id)
    ).all()
    ids = []
    for m in rows:
        if m.end_date is not None and m.end_date < at:
            continue
        cur = people.current_membership(db, m.person_id, at)
        if cur is not None and cur.dojo_id == dojo_id and m.person_id not in ids:
            ids.append(m.person_id)
    return ids


def ensure_person_in_dojo(db: Session, dojo_id: int, person_id: int) -> Person:
    p = people.get_person(db, person_id)
    m = people.current_membership(db, p.id)
    if m is None or m.dojo_id != dojo_id or p.merged_into_id is not None:
        raise Forbidden("La persona no tiene membresía vigente en tu dojo")
    return p


def competitors(db: Session, dojo_id: int) -> list[s.PersonOut]:
    ids = dojo_person_ids(db, dojo_id)
    rows = list(
        db.scalars(
            select(Person)
            .where(Person.id.in_(ids or [0]), Person.merged_into_id.is_(None))
            .order_by(Person.last_names, Person.first_names)
        ).all()
    )
    # El dojo ve documento y fecha de nacimiento de sus propios competidores.
    return people.persons_out(db, rows, privileged=True)


# --- Pedidos de inscripción -----------------------------------------------------------


def _active_or_pending(db: Session, category_id: int, person_id: int) -> Registration | None:
    return db.scalar(
        select(Registration).where(
            Registration.category_id == category_id,
            Registration.person_id == person_id,
            Registration.status.in_(("active", "pending")),
        )
    )


def submit(db: Session, user: User, dojo_id: int, tid: int, data: s.DojoRegistrationBatch) -> list[Registration]:
    """Crea las inscripciones pendientes del dojo en una sola transacción.

    Mismas advertencias que la inscripción del organizador (edad, grado, sexo,
    peso): si hay alguna y no viene ``override``, 409 WARNINGS con todas.
    """
    t = get_tournament(db, tid)
    ensure_open(t)
    entitlements.require_for_tournament(db, user, t, "dojo_self_registration")
    created: list[tuple[Registration, list[dict[str, str]]]] = []
    all_warnings: list[dict[str, str]] = []
    seen: set[tuple[int, int]] = set()
    for item in data.items:
        p = ensure_person_in_dojo(db, dojo_id, item.person_id)
        c = get_category(db, item.category_id)
        name = f"{p.first_names} {p.last_names}"
        if c.tournament_id != tid:
            raise InvalidState(f"{name}: la categoría no pertenece al torneo")
        if c.is_team or c.status in ("merged", "cancelled"):
            raise InvalidState(f"{name}: la categoría {c.name} no admite inscripciones en línea")
        if (p.id, c.id) in seen or _active_or_pending(db, c.id, p.id):
            raise Conflict(f"{name} ya está inscrito o pendiente en {c.name}", code="ALREADY_REGISTERED")
        seen.add((p.id, c.id))
        g = people.current_grade(db, p.id, t.start_date)
        grade = g.grade if g else None
        grade_ord = grade_to_ordinal(grade) if grade else None
        m = people.current_membership(db, p.id, t.start_date) or people.current_membership(db, p.id)
        r = Registration(
            tournament_id=tid,
            category_id=c.id,
            original_category_id=c.id,
            person_id=p.id,
            dojo_id=dojo_id,
            branch_id=m.branch_id if m and m.dojo_id == dojo_id else None,
            grade=grade,
            grade_ordinal=grade_ord,
            weight_class=item.weight_class,
            age_at_reference=age_at(p.birth_date, t.age_reference_date) if p.birth_date else None,
            status="pending",
            requested_by_id=user.id,
            updated_by_id=user.id,
        )
        ws = [w for w in _warnings(p, grade_ord, item.weight_class, c, t) if w["code"] != "REGISTRATION_CLOSED"]
        all_warnings += [{"code": w["code"], "message": f"{name} en {c.name}: {w['message']}"} for w in ws]
        created.append((r, ws))
    reason = data.override.reason if data.override else None
    if all_warnings and not (reason and reason.strip()):
        raise WarningsRequireOverride(all_warnings)
    for r, ws in created:
        db.add(r)
        db.flush()
        apply_warnings(db, user, ws, reason, "registration", lambda r=r: r.id)
        audit(db, user, "registration", r.id, "request", after=snapshot(r), tournament_id=tid)
    db.commit()
    return [r for r, _ in created]


def dojo_registrations(db: Session, dojo_id: int, tid: int | None = None) -> list[s.DojoRegistrationOut]:
    stmt = select(Registration).where(Registration.dojo_id == dojo_id, Registration.person_id.is_not(None))
    if tid is not None:
        stmt = stmt.where(Registration.tournament_id == tid)
    rows = db.scalars(stmt.order_by(Registration.id.desc()).limit(500)).all()
    return with_names(db, rows)


def with_names(db: Session, rows) -> list[s.DojoRegistrationOut]:
    tids = {r.tournament_id for r in rows}
    cids = {r.category_id for r in rows}
    tnames = dict(db.execute(select(Tournament.id, Tournament.name).where(Tournament.id.in_(tids or {0}))).all())
    cnames = dict(db.execute(select(Category.id, Category.name).where(Category.id.in_(cids or {0}))).all())
    out = []
    for r in rows:
        o = s.DojoRegistrationOut.model_validate(registration_out(r).model_dump())
        o.tournament_name = tnames.get(r.tournament_id, "")
        o.category_name = cnames.get(r.category_id, "")
        out.append(o)
    return out


def cancel_request(db: Session, user: User, r: Registration) -> Registration:
    """El sensei retira un pedido que aún no se aprobó."""
    if r.status != "pending":
        raise InvalidState("Solo se retiran pedidos pendientes; si ya se aprobó, pide el retiro al organizador")
    r.status, r.withdrawn_reason = "withdrawn", "Retirado por el dojo antes de la aprobación"
    bump(r, user)
    audit(db, user, "registration", r.id, "cancel_request", tournament_id=r.tournament_id)
    db.commit()
    return r


def pending_count(db: Session, tid: int) -> int:
    regs = (
        db.scalar(
            select(func.count())
            .select_from(Registration)
            .where(Registration.tournament_id == tid, Registration.status == "pending")
        )
        or 0
    )
    reqs = (
        db.scalar(
            select(func.count())
            .select_from(DojoAdminRequest)
            .where(DojoAdminRequest.tournament_id == tid, DojoAdminRequest.status == "pending")
        )
        or 0
    )
    return regs + reqs


def requests(db: Session, tid: int) -> s.RegistrationRequestsOut:
    rows = db.scalars(
        select(Registration)
        .where(Registration.tournament_id == tid, Registration.status == "pending")
        .order_by(Registration.dojo_id, Registration.id)
    ).all()
    regs = with_names(db, rows)
    reqs = dojo_admin_requests(db, tid)
    return s.RegistrationRequestsOut(registrations=regs, dojo_admin_requests=reqs, count=len(regs) + len(reqs))


def decide(db: Session, user: User, tid: int, data: s.RegistrationDecisionIn) -> s.RegistrationDecisionOut:
    """Aprueba o rechaza pedidos en lote. Las que no se pueden aprobar (categoría
    con llave, fusionada o cancelada, o persona ya inscrita) se informan en ``skipped``."""
    if data.action == "reject" and not (data.reason and len(data.reason.strip()) >= 3):
        raise InvalidState("Rechazar requiere un motivo", code="REASON_REQUIRED")
    out = s.RegistrationDecisionOut()
    decided: list[Registration] = []
    touched: dict[int, Category] = {}
    for rid in dict.fromkeys(data.ids):
        r = db.get(Registration, rid)
        if r is None or r.tournament_id != tid:
            out.skipped.append({"id": rid, "reason": "No es un pedido de este torneo"})
            continue
        if r.status != "pending":
            out.skipped.append({"id": rid, "reason": f"Ya no está pendiente (estado {r.status})"})
            continue
        if data.action == "reject":
            r.status, r.rejection_reason = "rejected", data.reason.strip()
            bump(r, user)
            audit(db, user, "registration", r.id, "reject", reason=r.rejection_reason, tournament_id=tid)
            out.rejected.append(r.id)
            decided.append(r)
            continue
        c = touched.get(r.category_id) or get_category(db, r.category_id)
        if c.status in ("merged", "cancelled"):
            out.skipped.append({"id": rid, "reason": f"La categoría {c.name} está fusionada o cancelada"})
            continue
        if c.status in ("ready", "in_progress", "finished"):
            out.skipped.append({"id": rid, "reason": f"La categoría {c.name} ya tiene llave"})
            continue
        if db.scalar(
            select(Registration.id).where(
                Registration.category_id == c.id,
                Registration.person_id == r.person_id,
                Registration.status == "active",
            )
        ):
            out.skipped.append({"id": rid, "reason": "La persona ya está inscrita en esa categoría"})
            continue
        r.status = "active"
        bump(r, user)
        audit(db, user, "registration", r.id, "approve", tournament_id=tid)
        touched[c.id] = c
        out.approved.append(r.id)
        decided.append(r)
    db.flush()
    for c in touched.values():
        refresh_category_status(db, c)
    # Los avisos van en la misma transacción (bandeja de salida): si algo falla, no sale ninguno.
    notify_registration_decisions(db, decided)
    db.commit()
    return out


def notify_registration_decision(db: Session, r: Registration, decision: str, reason: str | None = None) -> None:
    """Aviso al sensei que pidió una inscripción (correo en la bandeja de salida, sin confirmar)."""
    notify_registration_decisions(db, [r])


def notify_registration_decisions(db: Session, regs: list[Registration]) -> None:
    """Un correo por sensei que pidió inscripciones, con las aprobadas y las rechazadas (y su motivo).

    Se encola en ``outbox_emails`` (ver ``app.services.mail``) sin confirmar la
    transacción. Sin correo en la cuenta, solo queda la constancia en el log.
    """
    by_user: dict[int, list[Registration]] = {}
    for r in regs:
        log.info(
            "Inscripción %s %s (torneo %s, pedida por el usuario %s)%s",
            r.id,
            "aprobada" if r.status == "active" else "rechazada",
            r.tournament_id,
            r.requested_by_id,
            f": {r.rejection_reason}" if r.rejection_reason else "",
        )
        if r.requested_by_id is not None:
            by_user.setdefault(r.requested_by_id, []).append(r)
    for user_id, mine in by_user.items():
        u = db.get(User, user_id)
        if u is None or not u.is_active or not u.email:
            continue
        t = get_tournament(db, mine[0].tournament_id)
        names = {r.id: _decision_line(db, r) for r in mine}
        approved = [names[r.id] for r in mine if r.status == "active"]
        rejected = [
            f"{names[r.id]} — motivo: {r.rejection_reason or 'sin motivo'}" for r in mine if r.status != "active"
        ]
        paragraphs = [
            f"Hola, {u.display_name or u.username}.",
            f"La organización de {t.name} revisó tus inscripciones.",
        ]
        if approved:
            paragraphs.append("Aprobadas: " + "; ".join(approved) + ".")
        if rejected:
            paragraphs.append("No aprobadas: " + "; ".join(rejected) + ".")
        paragraphs.append("Puedes ver el detalle en «Mis competidores».")
        mail.enqueue(
            db,
            u.email,
            mail.render(
                f"Inscripciones revisadas · {t.name}",
                "Inscripciones revisadas",
                paragraphs,
                ("Ver mis competidores", f"{get_settings().frontend_url()}/mis-competidores"),
            ),
            kind="registration_decision",
        )


def _decision_line(db: Session, r: Registration) -> str:
    """«Diego Ramírez (Kumite 12-13 M -45)»."""
    who = r.display_name
    c = db.get(Category, r.category_id)
    return f"{who} ({c.name})" if c is not None else who
