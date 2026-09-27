"""Cobros: checkout, prueba gratis, pagos, reembolsos, cupones, comprobantes y avisos de la pasarela.

Ver docs/cobros.md.

Con los cobros apagados (``HAJIME_PAYMENTS_ENABLED=false``, el valor por
defecto) las rutas que cobran, emiten o cambian algo de un cobro llevan la
dependencia ``COBROS`` y responden 404 ``PAYMENTS_DISABLED``. Siguen en el
router (el contrato de la API no cambia al activarlos) y siguen respondiendo
las lecturas: configuración, avisos (vacíos), suscripciones y el historial de
pagos que hubiera.
"""

from __future__ import annotations

import anyio.to_thread
from fastapi import APIRouter, Depends, Request
from sqlalchemy import or_, select

from app.api import schemas as s
from app.api.deps import DB, AdminUser, CurrentUser, is_org_admin, memberships_of
from app.api.errors import AppError, Forbidden, InvalidState, NotFound, PaymentsDisabled
from app.config import get_settings
from app.db.base import get_session, utcnow
from app.db.models import Coupon, Invoice, Organization, Payment, Person, Subscription, User
from app.services import checkout as svc
from app.services import entitlements, invoicing, payments
from app.services import organizations as orgs
from app.services.audit import audit, snapshot
from app.services.gateway_http import GatewayError

router = APIRouter(tags=["billing"])

PAYMENTS_DISABLED_MESSAGE = "Los cobros no están activos"


def cobros_activos() -> None:
    """Dependencia: 404 ``PAYMENTS_DISABLED`` si los cobros están apagados."""
    if not entitlements.payments_enabled():
        raise PaymentsDisabled(PAYMENTS_DISABLED_MESSAGE)


# Rutas que solo existen con los cobros activos.
COBROS = [Depends(cobros_activos)]


class PayloadTooLarge(AppError):
    status_code = 413
    code = "PAYLOAD_TOO_LARGE"


def _manager(db, user, oid: int) -> Organization:
    o = orgs.get_organization(db, oid)
    if not is_org_admin(db, user, oid):
        raise Forbidden("Solo el dueño o un administrador de la organización puede hacer esto")
    return o


def payment_out(db, pay: Payment) -> s.PaymentOut:
    out = s.PaymentOut.model_validate(pay)
    sub = db.get(Subscription, pay.subscription_id) if pay.subscription_id else None
    if sub is not None:
        plan = entitlements.get_plan(db, sub.plan_code)
        out.plan_code = sub.plan_code
        out.plan_name = plan.name if plan else sub.plan_code
        out.organization_id = sub.organization_id
        if sub.organization_id:
            org = db.get(Organization, sub.organization_id)
            out.organization_name = org.name if org else None
        out.user_id = sub.user_id
        if sub.user_id:
            u = db.get(User, sub.user_id)
            out.username = u.username if u else None
        if sub.person_id:
            p = db.get(Person, sub.person_id)
            out.person_id = sub.person_id
            out.person_name = f"{p.first_names} {p.last_names}".strip() if p else None
    inv = invoicing.sale_invoice(db, pay)
    out.invoice = s.InvoiceOut.model_validate(inv) if inv else None
    note = invoicing.credit_note(db, pay)
    out.credit_note = s.InvoiceOut.model_validate(note) if note else None
    return out


def _checkout_out(sub: Subscription, co: payments.Checkout, q: svc.Quote) -> s.CheckoutOut:
    return s.CheckoutOut(
        provider=co.provider,
        subscription_id=sub.id,
        url=co.url,
        instructions=co.instructions,
        amount_cents=q.first_cents,
        description=f"{q.plan.name} ({'anual' if q.period == 'year' else 'mensual'})",
        recurring=co.recurring,
        public_key=co.public_key,
        status=sub.status,
    )


def _finish(db) -> None:
    """Commit y, después, comprobantes y avisos de los pagos recién aprobados."""
    db.commit()
    payments.after_commit(db)


# --- Configuración y precios -----------------------------------------------------------


@router.get("/billing/config", response_model=s.BillingConfigOut)
def billing_config():
    """Si los cobros están activos, la pasarela y la llave pública de Culqi (no es secreta).

    Sin sesión: la interfaz lo consulta al arrancar para mostrar u ocultar pagos."""
    st = get_settings()
    return s.BillingConfigOut(
        payments_enabled=st.payments_enabled,
        mode=entitlements.billing_mode(),
        provider=st.payment_provider,
        culqi_public_key=st.culqi_public_key if st.payment_provider == "culqi" else None,
        invoicing=st.invoicing_provider,
        grace_days=st.billing_grace_days,
    )


@router.get("/plans/{code}/quote", response_model=s.QuoteOut, dependencies=COBROS)
def quote(code: str, db: DB, _: CurrentUser, period: str = "month", coupon_code: str | None = None):
    """Precio a pagar con el cupón (sin crear nada): para mostrarlo antes de pagar."""
    if period not in ("month", "year"):
        raise InvalidState("Periodo inválido")
    plan = entitlements.get_plan(db, code)
    if plan is None:
        raise NotFound("Plan no encontrado")
    q = svc.quote(db, plan, period, coupon_code)  # type: ignore[arg-type]
    return s.QuoteOut(
        plan_code=plan.code,
        plan_name=plan.name,
        period=q.period,
        list_cents=q.list_cents,
        discount_cents=q.discount_cents,
        first_cents=q.first_cents,
        recurring_cents=q.recurring_cents,
        coupon_code=q.coupon.code if q.coupon else None,
        trial_days=plan.trial_days or 0,
    )


# --- Checkout ----------------------------------------------------------------------------------


@router.post("/organizations/{oid}/checkout", response_model=s.CheckoutOut, dependencies=COBROS)
def organization_checkout(oid: int, data: s.CheckoutIn, request: Request, db: DB, user: CurrentUser):
    """Contrata o renueva un plan para la organización: suscripción pendiente + cobro de la pasarela."""
    _manager(db, user, oid)
    sub, co, q = svc.start_checkout(
        db,
        user,
        organization_id=oid,
        user_id=None,
        plan_code=data.plan_code,
        period=data.period,
        coupon_code=data.coupon_code,
        payer_email=data.payer_email,
        billing_doc=None,
        billing_name=None,
        request_base=str(request.base_url),
    )
    _finish(db)
    return _checkout_out(sub, co, q)


@router.post("/organizations/{oid}/trial", response_model=s.SubscriptionOut, status_code=201, dependencies=COBROS)
def organization_trial(oid: int, data: s.TrialIn, db: DB, user: CurrentUser):
    """Periodo de prueba gratis del plan (una vez por organización)."""
    org = _manager(db, user, oid)
    sub = svc.start_trial(db, user, org, data.plan_code)
    db.commit()
    return orgs.subscription_out(db, sub)


@router.post("/me/checkout", response_model=s.CheckoutOut, dependencies=COBROS)
def my_checkout(data: s.CheckoutIn, request: Request, db: DB, user: CurrentUser):
    """Competidor Plus. Titular: la cuenta del usuario o, con ``person_id``, un perfil: el
    propio o el de un menor a su cargo (tutela aprobada)."""
    if data.person_id is not None and not svc.can_pay_for_person(db, user, data.person_id):
        raise Forbidden("Solo la propia persona o su padre, madre o apoderado aprobado puede pagar su plan")
    sub, co, q = svc.start_checkout(
        db,
        user,
        organization_id=None,
        user_id=None if data.person_id is not None else user.id,
        person_id=data.person_id,
        plan_code=data.plan_code,
        period=data.period,
        coupon_code=data.coupon_code,
        payer_email=data.payer_email,
        billing_doc=data.billing_doc,
        billing_name=data.billing_name,
        request_base=str(request.base_url),
    )
    _finish(db)
    return _checkout_out(sub, co, q)


@router.get("/me/subscriptions", response_model=list[s.SubscriptionOut])
def my_subscriptions(db: DB, user: CurrentUser):
    stmt = svc.my_subscriptions_query(db, user)
    return [orgs.subscription_out(db, x) for x in db.scalars(stmt.order_by(Subscription.id.desc())).all()]


@router.get("/me/payments", response_model=list[s.PaymentOut])
def my_payments(db: DB, user: CurrentUser):
    sids = select(svc.my_subscriptions_query(db, user).subquery().c.id)
    rows = db.scalars(
        select(Payment).where(Payment.subscription_id.in_(sids)).order_by(Payment.id.desc()).limit(200)
    ).all()
    return [payment_out(db, p) for p in rows]


@router.get("/subscriptions/{sid}/status", response_model=s.SubscriptionOut)
def subscription_status(sid: int, db: DB, user: CurrentUser):
    """Estado de una suscripción para su titular (página de retorno del pago)."""
    sub = db.get(Subscription, sid)
    if sub is None or not _can_see(db, user, sub):
        raise NotFound("Suscripción no encontrada")
    return orgs.subscription_out(db, sub)


def _can_see(db, user: User, sub: Subscription) -> bool:
    if user.is_admin:
        return True
    if sub.organization_id is not None:
        return sub.organization_id in memberships_of(db, user)
    return sub.created_by_id == user.id or svc.can_manage_subscription(db, user, sub)


@router.post("/subscriptions/{sid}/cancel", response_model=s.SubscriptionOut, dependencies=COBROS)
def cancel_subscription(sid: int, db: DB, user: CurrentUser):
    """El titular cancela: no se renueva y conserva el acceso hasta el fin del periodo pagado."""
    sub = db.get(Subscription, sid)
    if sub is None:
        raise NotFound("Suscripción no encontrada")
    svc.cancel(db, user, sub)
    db.commit()
    return orgs.subscription_out(db, sub)


@router.post("/payments/culqi/charge", response_model=s.PaymentOut, dependencies=COBROS)
def culqi_charge(data: s.CulqiChargeIn, db: DB, user: CurrentUser):
    """Cobra el token de Culqi Checkout (la tarjeta nunca pasa por el servidor)."""
    from app.services.gateways.culqi import CulqiProvider

    sub = db.get(Subscription, data.subscription_id)
    if sub is None or not svc.can_manage_subscription(db, user, sub):
        raise NotFound("Suscripción no encontrada")
    prov = payments.provider("culqi")
    assert isinstance(prov, CulqiProvider)
    pay = prov.charge(db, sub, data.token, data.email, data.first_name, data.last_name, data.phone)
    _finish(db)
    db.refresh(pay)
    return payment_out(db, pay)


# --- Pagos y comprobantes -------------------------------------------------------------------------


@router.get("/organizations/{oid}/payments", response_model=list[s.PaymentOut])
def organization_payments(oid: int, db: DB, user: CurrentUser):
    """Historial de pagos y comprobantes de la organización (dueño o administrador)."""
    _manager(db, user, oid)
    rows = db.scalars(svc.payments_query(organization_id=oid).limit(200)).all()
    return [payment_out(db, p) for p in rows]


@router.get("/payments", response_model=list[s.PaymentOut])
def list_payments(
    db: DB, _: AdminUser, q: str | None = None, status: str | None = None, provider: str | None = None, limit: int = 100
):
    """Todos los pagos (Admin Global). ``q`` busca por referencia, organización o usuario."""
    stmt = (
        select(Payment)
        .join(Subscription, Subscription.id == Payment.subscription_id, isouter=True)
        .join(Organization, Organization.id == Subscription.organization_id, isouter=True)
        .join(User, User.id == Subscription.user_id, isouter=True)
    )
    if status:
        stmt = stmt.where(Payment.status == status)
    if provider:
        stmt = stmt.where(Payment.provider == provider)
    if q and q.strip():
        like = f"%{q.strip()}%"
        conds = [Payment.provider_ref.like(like), Organization.name.like(like), User.username.like(like)]
        if q.strip().isdigit():
            conds.append(Payment.id == int(q.strip()))
        stmt = stmt.where(or_(*conds))
    rows = db.scalars(stmt.order_by(Payment.id.desc()).limit(max(1, min(limit, 500)))).all()
    return [payment_out(db, p) for p in rows]


@router.post("/payments/{pid}/refund", response_model=s.PaymentOut, dependencies=COBROS)
def refund_payment(pid: int, data: s.RefundIn, db: DB, admin: AdminUser):
    """Reembolso (Admin Global): devuelve en la pasarela y, si se pide, corta el acceso."""
    pay = db.get(Payment, pid)
    if pay is None:
        raise NotFound("Pago no encontrado")
    svc.refund(db, admin, pay, data.reason, data.cancel_subscription)
    db.commit()
    invoicing.after_refund(db, pay)  # nota de crédito si había comprobante
    return payment_out(db, pay)


@router.post("/payments/{pid}/invoice", response_model=s.PaymentOut, dependencies=COBROS)
def emit_invoice(pid: int, db: DB, admin: AdminUser):
    """Emite o reintenta el comprobante de un pago (Admin Global); si se reembolsó, su nota de crédito."""
    pay = db.get(Payment, pid)
    if pay is None:
        raise NotFound("Pago no encontrado")
    if invoicing.provider() is None:
        raise InvalidState("No hay proveedor de comprobantes configurado (HAJIME_INVOICING_PROVIDER)")
    invoicing.emit_for_payment(db, pay)
    db.commit()
    if pay.status == "refunded":
        invoicing.emit_credit_note(db, pay)
        db.commit()
    return payment_out(db, pay)


@router.post("/invoices/{iid}/refresh", response_model=s.InvoiceOut, dependencies=COBROS)
def refresh_invoice(iid: int, db: DB, _: AdminUser):
    """Consulta a SUNAT (vía el proveedor) el estado de un comprobante."""
    inv = db.get(Invoice, iid)
    if inv is None:
        raise NotFound("Comprobante no encontrado")
    invoicing.refresh(db, inv)
    db.commit()
    return inv


# --- Cupones -------------------------------------------------------------------------------------------


@router.get("/coupons", response_model=list[s.CouponOut], dependencies=COBROS)
def list_coupons(db: DB, _: AdminUser):
    return db.scalars(select(Coupon).order_by(Coupon.id.desc())).all()


@router.post("/coupons", response_model=s.CouponOut, status_code=201, dependencies=COBROS)
def create_coupon(data: s.CouponIn, db: DB, admin: AdminUser):
    if not data.percent_off and not data.amount_off_pen:
        raise InvalidState("Indica un porcentaje o un monto de descuento")
    code = data.code.upper()
    if db.scalar(select(Coupon.id).where(Coupon.code == code)):
        raise InvalidState("Ya existe un cupón con ese código")
    c = Coupon(**{**data.model_dump(), "code": code})
    db.add(c)
    db.flush()
    audit(db, admin, "coupon", c.id, "create", after=snapshot(c))
    db.commit()
    db.refresh(c)
    return c


@router.patch("/coupons/{cid}", response_model=s.CouponOut, dependencies=COBROS)
def update_coupon(cid: int, data: s.CouponUpdate, db: DB, admin: AdminUser):
    c = db.get(Coupon, cid)
    if c is None:
        raise NotFound("Cupón no encontrado")
    before = snapshot(c)
    for k, v in data.model_dump(exclude_unset=True).items():
        if v is None and k not in ("percent_off", "amount_off_pen", "max_redemptions", "expires_at"):
            continue
        setattr(c, k, v)
    audit(db, admin, "coupon", c.id, "update", before, snapshot(c))
    db.commit()
    db.refresh(c)
    return c


# --- Avisos para el encabezado -----------------------------------------------------------------------------

ALERT_DAYS = 7


@router.get("/billing/alerts", response_model=list[s.BillingAlert])
def billing_alerts(db: DB, user: CurrentUser):
    """Planes que vencen en los próximos días (o en gracia) de las organizaciones que el
    usuario administra y de su propia cuenta. En marcha blanca (o con los cobros
    apagados) no hay avisos."""
    if entitlements.billing_mode() != "enforced":
        return []
    now = utcnow()
    managed = [oid for oid, role in memberships_of(db, user).items() if role in ("owner", "admin")]
    conds = [Subscription.user_id == user.id]
    pids = svc.person_ids_of(db, user)
    if pids:
        conds.append(Subscription.person_id.in_(pids))
    if managed:
        conds.append(Subscription.organization_id.in_(managed))
    subs = db.scalars(select(Subscription).where(or_(*conds), Subscription.status != "canceled")).all()
    seen: set[tuple] = set()
    out: list[s.BillingAlert] = []
    for sub in sorted(subs, key=lambda x: x.id, reverse=True):
        key = (sub.organization_id, sub.user_id, sub.person_id)
        if key in seen or not entitlements.is_current(sub, now):
            continue
        seen.add(key)
        grace = entitlements.in_grace(sub, now)
        end = sub.grace_until if sub.status == "past_due" else sub.current_period_end
        if end is None or (entitlements.auto_renews(sub) and not grace):
            continue
        days = max(0, (end - now).days)
        if days > ALERT_DAYS and not grace:
            continue
        plan = entitlements.get_plan(db, sub.plan_code)
        org = db.get(Organization, sub.organization_id) if sub.organization_id else None
        out.append(
            s.BillingAlert(
                subscription_id=sub.id,
                organization_id=sub.organization_id,
                organization_name=org.name if org else None,
                plan_name=plan.name if plan else sub.plan_code,
                status=sub.status,
                days_left=days,
                in_grace=grace,
                recurring=entitlements.auto_renews(sub),
                access_until=entitlements.access_until(sub),
            )
        )
    return out


# --- Avisos de la pasarela (webhooks) -----------------------------------------------------------------------


@router.post("/payments/webhook/{provider_name}", dependencies=COBROS)
async def payment_webhook(provider_name: str, request: Request):
    """Aviso de la pasarela. Sin sesión, pero con firma (o autenticación) y consulta a la API.

    Idempotente: el mismo pago avisado dos veces no se duplica. Responde 200 a
    lo que no corresponde procesar (para que la pasarela no reintente) y 502
    si la API de la pasarela no respondió (para que sí reintente).
    """
    limit = get_settings().webhook_max_bytes
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise PayloadTooLarge("Aviso demasiado grande")
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise PayloadTooLarge("Aviso demasiado grande")
        chunks.append(chunk)
    body = b"".join(chunks)
    headers = {k.lower(): v for k, v in request.headers.items()}
    query = dict(request.query_params)

    def _handle():
        gen = get_session()
        db = next(gen)
        try:
            prov = payments.provider(provider_name)
            try:
                result = prov.handle_webhook(db, body, headers, query)
            except (GatewayError, payments.GatewayFailed) as e:
                status = e.status if isinstance(e, GatewayError) else e.details.get("status")
                if status == 404:  # aviso de prueba o de un pago que no es de esta cuenta
                    return {"ok": True, "ignored": True}
                raise payments.GatewayFailed("La pasarela no respondió", details={"status": status}) from None
            sub = payments.apply_webhook(db, result, prov.name)
            _finish(db)
            return {"ok": True, "subscription_id": sub.id if sub else None, "ignored": result.ignored}
        finally:
            gen.close()

    return await anyio.to_thread.run_sync(_handle)
