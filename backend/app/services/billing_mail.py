"""Correos de cobro: pago aprobado, pago rechazado, gracia y plan por vencer.

Todos van por la bandeja de salida (``mail.enqueue``), en la transacción de
quien llama: si la operación falla, el correo no sale.

Destinatarios (:func:`recipients`):

* suscripción de una organización → los dueños (``owner``) con correo; si
  ninguno tiene, el correo para comprobantes de la organización;
* Competidor Plus → la cuenta titular; si el titular es una persona, la cuenta
  ligada a esa persona y quien pagó (p. ej. su padre o apoderado).

Los avisos de vencimiento (7 días y 1 día antes, y el de gracia de una
suscripción automática cuyo cobro no llegó) los envía :func:`send_reminders`
una vez al día: lo llama el despachador de correo y
``python -m app.billing_reminders``. Cada aviso se reserva con un UPDATE
condicional sobre ``subscriptions.reminder_key``, así que no se repite aunque
corran varios procesos a la vez.
"""

from __future__ import annotations

import logging
import threading
import time
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select, true, update
from sqlalchemy.orm import Session, sessionmaker

from app.config import get_settings
from app.db.base import utcnow
from app.db.models import Invoice, Organization, OrganizationMember, Payment, Subscription, User
from app.services import entitlements, mail

log = logging.getLogger("hajime.pagos")

FOOTER = "Recibes este correo porque administras un plan de Hajime."


def recipients(db: Session, sub: Subscription) -> list[str]:
    emails: list[str] = []
    if sub.organization_id is not None:
        rows = db.scalars(
            select(User.email)
            .join(OrganizationMember, OrganizationMember.user_id == User.id)
            .where(
                OrganizationMember.organization_id == sub.organization_id,
                OrganizationMember.role == "owner",
                User.email.is_not(None),
                User.is_active == true(),
            )
        ).all()
        emails = [e for e in rows if e]
        if not emails:
            org = db.get(Organization, sub.organization_id)
            if org is not None and org.billing_email:
                emails = [org.billing_email]
    else:
        ids = {x for x in (sub.user_id, sub.created_by_id) if x is not None}
        users = [db.get(User, i) for i in ids]
        if sub.person_id is not None:
            users += list(db.scalars(select(User).where(User.person_id == sub.person_id)).all())
        emails = [u.email for u in users if u is not None and u.email and u.is_active]
        if not emails and sub.billing_email:
            emails = [sub.billing_email]
    seen: set[str] = set()
    return [e for e in emails if not (e.lower() in seen or seen.add(e.lower()))]


def _plan_name(db: Session, sub: Subscription) -> str:
    plan = entitlements.get_plan(db, sub.plan_code)
    return plan.name if plan else sub.plan_code


def _who(db: Session, sub: Subscription) -> str:
    if sub.organization_id is not None:
        org = db.get(Organization, sub.organization_id)
        return f" de {org.name}" if org else ""
    return ""


def _link(sub: Subscription) -> str:
    base = get_settings().frontend_url()
    return f"{base}/organizacion/{sub.organization_id}" if sub.organization_id else f"{base}/planes"


def _date(d: datetime | None) -> str:
    if d is None:
        return "—"
    return d.replace(tzinfo=UTC).astimezone(ZoneInfo(get_settings().timezone)).strftime("%d/%m/%Y")


def _soles(cents: int) -> str:
    return f"S/ {cents / 100:,.2f}".replace(",", " ")


def _send(db: Session, sub: Subscription, rendered: mail.Rendered, kind: str) -> int:
    to = recipients(db, sub)
    for addr in to:
        mail.enqueue(db, addr, rendered, kind=kind)
    if not to:
        log.info("Aviso de cobro %s de la suscripción %s sin destinatarios con correo", kind, sub.id)
    return len(to)


def payment_approved(db: Session, pay: Payment) -> int:
    sub = db.get(Subscription, pay.subscription_id) if pay.subscription_id else None
    if sub is None:
        return 0
    plan = _plan_name(db, sub)
    period = "1 año" if (pay.period or sub.period) == "year" else "1 mes"
    paras = [
        f"Recibimos tu pago de {_soles(pay.amount_pen)} por el plan {plan}{_who(db, sub)} ({period}).",
        f"Tu plan está activo hasta el {_date(sub.current_period_end)}.",
    ]
    if pay.coupon_code:
        paras.append(f"Se aplicó el cupón {pay.coupon_code}.")
    inv = db.scalar(select(Invoice).where(Invoice.payment_id == pay.id, Invoice.doc_type != "nota_credito"))
    action = ("Ver mi plan", _link(sub))
    if inv is not None and inv.pdf_url:
        paras.append(f"Tu comprobante electrónico es {inv.serie}-{inv.numero:08d}.")
        action = ("Descargar comprobante", inv.pdf_url)
    elif pay.amount_pen > 0:
        paras.append("Encontrarás el comprobante en «Pagos y comprobantes» cuando esté emitido.")
    paras.append("Gracias por apoyar a Hajime.")
    return _send(
        db,
        sub,
        mail.render(f"Pago recibido: {plan} · Hajime", "Pago recibido", paras, action, FOOTER),
        "payment_approved",
    )


def payment_rejected(db: Session, pay: Payment, sub: Subscription) -> int:
    plan = _plan_name(db, sub)
    paras = [f"El pago de {_soles(pay.amount_pen)} por el plan {plan}{_who(db, sub)} no se completó."]
    if sub.status == "past_due" and sub.grace_until is not None:
        paras.append(
            f"Mantienes el acceso hasta el {_date(sub.grace_until)}. Renueva antes para no perder "
            "las funciones de tu plan."
        )
    else:
        paras.append("No se hizo ningún cobro. Puedes intentarlo otra vez con otra tarjeta o medio de pago.")
    return _send(
        db,
        sub,
        mail.render(
            f"Pago no completado: {plan} · Hajime", "El pago no se completó", paras, ("Renovar", _link(sub)), FOOTER
        ),
        "payment_rejected",
    )


def grace_started(db: Session, sub: Subscription) -> int:
    plan = _plan_name(db, sub)
    until = sub.grace_until if sub.status == "past_due" else entitlements.access_until(sub)
    paras = [
        f"No recibimos la renovación del plan {plan}{_who(db, sub)}.",
        f"Mantienes el acceso hasta el {_date(until)}. Después, las funciones del plan se desactivan "
        "(los resultados y el historial no se pierden).",
    ]
    return _send(
        db,
        sub,
        mail.render(
            f"Tu plan {plan} está en periodo de gracia · Hajime",
            "Periodo de gracia",
            paras,
            ("Renovar", _link(sub)),
            FOOTER,
        ),
        "billing_grace",
    )


def expiring(db: Session, sub: Subscription, days: int) -> int:
    plan = _plan_name(db, sub)
    cuando = "mañana" if days <= 1 else f"en {days} días"
    verb = "termina" if sub.cancel_at_period_end else "vence"
    paras = [
        f"Tu plan {plan}{_who(db, sub)} {verb} {cuando}, el {_date(sub.current_period_end)}.",
        "Renuévalo para seguir usando sus funciones sin interrupciones."
        if not sub.cancel_at_period_end
        else "Lo cancelaste: no se renovará. Si cambias de opinión, puedes contratarlo de nuevo.",
    ]
    subject = f"Tu plan {plan} {verb} {cuando} · Hajime"
    return _send(
        db,
        sub,
        mail.render(subject, f"Tu plan {verb} {cuando}", paras, ("Renovar", _link(sub)), FOOTER),
        f"billing_d{days}",
    )


# --- Recordatorios diarios ---------------------------------------------------------------


def _claim(db: Session, sub: Subscription, key: str) -> bool:
    """Reserva el aviso (UPDATE condicional): True si este proceso lo envía."""
    old = sub.reminder_key
    cond = Subscription.reminder_key.is_(None) if old is None else Subscription.reminder_key == old
    res = db.execute(
        update(Subscription)
        .where(Subscription.id == sub.id, cond)
        .values(reminder_key=key)
        .execution_options(synchronize_session=False)
    )
    if (res.rowcount or 0) != 1:
        return False
    sub.reminder_key = key
    return True


def reminder_for(sub: Subscription, now: datetime) -> tuple[str, int] | None:
    """Qué aviso toca hoy: («d7» | «d1» | «grace», días) o None."""
    end = sub.current_period_end
    if end is None or sub.status not in ("active", "trial"):
        return None
    if entitlements.auto_renews(sub):
        # Se renueva sola: solo se avisa si el cobro no llegó (en gracia).
        return ("grace", 0) if end <= now < entitlements.access_until(sub) else None  # type: ignore[operator]
    if end <= now:
        return None
    days = (end - now).days + (1 if (end - now).seconds else 0)
    if days <= 1:
        return ("d1", 1)
    if days <= 7:
        return ("d7", days)
    return None


def send_reminders(db: Session, now: datetime | None = None) -> int:
    """Encola los avisos de vencimiento que tocan hoy. Devuelve cuántos avisos se encolaron."""
    now = now or utcnow()
    horizon = now + timedelta(days=8)
    grace_from = now - timedelta(days=get_settings().billing_grace_days + 1)
    subs = db.scalars(
        select(Subscription).where(
            Subscription.status.in_(("active", "trial")),
            Subscription.current_period_end.is_not(None),
            Subscription.current_period_end > grace_from,
            Subscription.current_period_end < horizon,
        )
    ).all()
    sent = 0
    for sub in subs:
        which = reminder_for(sub, now)
        if which is None:
            continue
        kind, days = which
        key = f"{kind}:{sub.current_period_end.date().isoformat()}"
        if sub.reminder_key == key or (kind == "d7" and sub.reminder_key == f"d1:{key.split(':', 1)[1]}"):
            continue
        if not _claim(db, sub, key):
            continue
        if kind == "grace":
            grace_started(db, sub)
        else:
            expiring(db, sub, days)
        db.commit()
        sent += 1
    return sent


_last_run = 0.0
_lock = threading.Lock()
REMINDER_INTERVAL_SECONDS = 3600


def run_if_due(session_factory: sessionmaker[Session]) -> int:
    """Desde el despachador de correo: revisa los avisos a lo sumo una vez por hora por proceso.

    Revisar cada hora (y no una vez al día) no repite avisos: cada uno se
    reserva en la base; solo hace que el aviso llegue el mismo día aunque el
    proceso se reinicie.
    """
    global _last_run
    with _lock:
        if time.monotonic() - _last_run < REMINDER_INTERVAL_SECONDS and _last_run:
            return 0
        _last_run = time.monotonic()
    if entitlements.billing_mode() != "enforced":
        return 0
    with session_factory() as db:
        return send_reminders(db)
