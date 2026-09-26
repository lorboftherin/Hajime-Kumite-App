"""Culqi: cargo con token de Culqi Checkout, suscripciones con planes de Culqi y avisos.

- El navegador carga Culqi Checkout (``https://checkout.culqi.com/js/v4``) solo
  en la página de pago, con la llave PÚBLICA; la tarjeta (o Yape) va directo a
  Culqi, que devuelve un token de un solo uso. El servidor nunca ve la tarjeta.
- ``charge``: con el token, el servidor crea el cargo (``POST /v2/charges``) o,
  si hay un plan de Culqi configurado para el plan y periodo
  (``HAJIME_CULQI_PLAN_IDS``) y los datos del cliente, el cliente, la tarjeta y
  la suscripción recurrente.
- Avisos (``POST /api/v1/payments/webhook/culqi``): si se configuró
  ``HAJIME_CULQI_WEBHOOK_SECRET`` se exige la autenticación básica del aviso; en
  todo caso el cargo se CONSULTA a la API (``GET /v2/charges/{id}``) antes de
  aplicar nada.

Credenciales solo por entorno: ``HAJIME_CULQI_SECRET_KEY`` (y la pública,
``HAJIME_CULQI_PUBLIC_KEY``, que sí llega al navegador).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.errors import InvalidState, Unauthorized
from app.config import get_settings
from app.db.models import Organization, Payment, Subscription
from app.services.gateway_http import GatewayError, request_json, sanitize
from app.services.payments import (
    Checkout,
    CheckoutContext,
    GatewayFailed,
    GatewayNotConfigured,
    PaymentUpdate,
    Period,
    WebhookResult,
    record_payment,
)

log = logging.getLogger("hajime.pagos")
CHECKOUT_JS = "https://checkout.culqi.com/js/v4"


def charge_status(ch: dict[str, Any]) -> str:
    """Estado de un cargo de Culqi → pending | approved | rejected | refunded."""
    amount = int(ch.get("amount") or 0)
    refunded = int(ch.get("amount_refunded") or 0)
    if amount and refunded >= amount:
        return "refunded"
    outcome = ch.get("outcome") or {}
    otype = str(outcome.get("type") or "")
    if otype == "venta_exitosa" or (ch.get("capture") is True and not otype):
        return "approved"
    if otype in ("venta_rechazada", "error_tarjeta", "rechazo_fraude") or ch.get("object") == "error":
        return "rejected"
    return "pending"


class CulqiProvider:
    name = "culqi"

    def _key(self) -> str:
        k = get_settings().culqi_secret_key
        if k is None or not k.get_secret_value():
            raise GatewayNotConfigured("Culqi no está configurado (HAJIME_CULQI_SECRET_KEY)")
        return k.get_secret_value()

    def _api(self, method: str, path: str, body: Any = None, key: str | None = None) -> Any:
        try:
            return request_json(
                method,
                get_settings().culqi_api_url.rstrip("/") + path,
                headers={"Authorization": f"Bearer {self._key()}"},
                body=body,
                idempotency_key=key,
            )
        except GatewayError as e:
            if e.status == 402 or (isinstance(e.body, dict) and e.body.get("object") == "error"):
                raise  # rechazo de la tarjeta: lo trata quien llamó
            raise GatewayFailed(f"Culqi respondió con error ({e.status})", details={"status": e.status}) from None

    # --- Checkout -------------------------------------------------------------------
    def create_checkout(self, db: Session, sub: Subscription, period: Period, ctx: CheckoutContext) -> Checkout:
        public_key = get_settings().culqi_public_key
        if not public_key:
            raise GatewayNotConfigured("Falta la llave pública de Culqi (HAJIME_CULQI_PUBLIC_KEY)")
        self._key()
        plan_id = get_settings().culqi_plan_ids.get(f"{sub.plan_code}:{period}")
        return Checkout(
            provider=self.name,
            subscription_id=sub.id,
            reference=ctx.external_reference,
            public_key=public_key,
            recurring=bool(ctx.recurring and plan_id),
            instructions="Paga con tarjeta, Yape u otros medios en Culqi Checkout.",
        )

    def charge(
        self,
        db: Session,
        sub: Subscription,
        token: str,
        email: str,
        first_name: str | None = None,
        last_name: str | None = None,
        phone: str | None = None,
    ) -> Payment:
        """Cobra el token de Culqi Checkout. Idempotente por token (un token se cobra una vez)."""
        if sub.amount_cents is None or sub.amount_cents <= 0 or not sub.reference:
            raise InvalidState("Esta suscripción no tiene un cobro pendiente; vuelve a elegir el plan")
        idem = hashlib.sha256(token.encode()).hexdigest()[:40]
        done = db.scalar(select(Payment).where(Payment.idempotency_key == idem))
        if done is not None:
            return done  # reintento del navegador: el mismo token ya se cobró
        plan_id = get_settings().culqi_plan_ids.get(f"{sub.plan_code}:{sub.period or 'month'}")
        from app.services import checkout

        full = checkout.plan_price_cents(db, sub.plan_code, sub.period or "month")
        recurring = bool(plan_id and sub.period == "month" and sub.amount_cents == full and first_name and last_name)
        body = {
            "amount": sub.amount_cents,
            "currency_code": "PEN",
            "email": email,
            "source_id": token,
            "description": f"Hajime {sub.plan_code} {sub.period or ''}".strip()[:80],
            "capture": True,
            "metadata": {"subscription_id": str(sub.id), "external_reference": sub.reference},
        }
        try:
            if recurring and phone:
                return self._subscribe(db, sub, token, email, first_name or "", last_name or "", phone, plan_id, idem)
            ch = self._api("POST", "/v2/charges", body, key=f"charge-{idem}")
        except GatewayError as e:
            err = e.body if isinstance(e.body, dict) else {}
            upd = PaymentUpdate(
                provider_ref=str(err.get("charge_id") or f"culqi-rechazo-{idem}"),
                status="rejected",
                amount_cents=sub.amount_cents,
                subscription_id=sub.id,
                idempotency_key=idem,
                raw=sanitize(err),
            )
            pay = record_payment(db, self.name, upd)
            pay.raw = {**(pay.raw or {}), "user_message": str(err.get("user_message") or "")[:300]}
            return pay
        if email and not sub.billing_email:
            sub.billing_email = email
        return record_payment(
            db,
            self.name,
            PaymentUpdate(
                provider_ref=str(ch["id"]),
                status=charge_status(ch),
                amount_cents=int(ch.get("amount") or 0),
                currency=str(ch.get("currency_code") or "PEN"),
                subscription_id=sub.id,
                idempotency_key=idem,
                raw=sanitize(ch),
            ),
        )

    def _subscribe(
        self,
        db: Session,
        sub: Subscription,
        token: str,
        email: str,
        first_name: str,
        last_name: str,
        phone: str,
        plan_id: str,
        idem: str,
    ) -> Payment:
        """Cliente + tarjeta + suscripción recurrente. El primer cobro llega por aviso."""
        org = db.get(Organization, sub.organization_id) if sub.organization_id else None
        customer = self._api(
            "POST",
            "/v2/customers",
            {
                "first_name": first_name,
                "last_name": last_name,
                "email": email,
                "address": (org.tax_address if org and org.tax_address else "Lima")[:100],
                "address_city": "Lima",
                "country_code": "PE",
                "phone_number": phone,
            },
            key=f"customer-{idem}",
        )
        card = self._api("POST", "/v2/cards", {"customer_id": customer["id"], "token_id": token}, key=f"card-{idem}")
        rs = self._api(
            "POST",
            "/v2/recurrent/subscriptions/create",
            {"card_id": card["id"], "plan_id": plan_id, "tyc": True, "metadata": {"subscription_id": str(sub.id)}},
            key=f"subscription-{idem}",
        )
        sub.provider_subscription_id = str(rs.get("id"))
        sub.billing_email = sub.billing_email or email
        # Registro pendiente para que el reintento del navegador no cree otra suscripción.
        return record_payment(
            db,
            self.name,
            PaymentUpdate(
                provider_ref=f"culqi-sus-{rs.get('id')}",
                status="pending",
                amount_cents=sub.amount_cents or 0,
                subscription_id=sub.id,
                idempotency_key=idem,
                provider_subscription_id=sub.provider_subscription_id,
                raw=sanitize(rs),
            ),
        )

    # --- Avisos ------------------------------------------------------------------------
    def handle_webhook(self, db: Session, body: bytes, headers: dict[str, str], query: dict[str, str]) -> WebhookResult:
        self._key()
        secret = get_settings().culqi_webhook_secret
        if secret is not None and secret.get_secret_value():
            auth = headers.get("authorization", "")
            ok = False
            if auth.lower().startswith("basic "):
                try:
                    _, _, password = base64.b64decode(auth[6:]).decode().partition(":")
                    ok = hmac.compare_digest(password, secret.get_secret_value())
                except (ValueError, UnicodeDecodeError):
                    ok = False
            if not ok:
                raise Unauthorized("Autenticación del aviso de Culqi inválida", code="INVALID_SIGNATURE")
        try:
            event = json.loads(body or b"{}")
        except ValueError:
            return WebhookResult(ignored=True)
        data = event.get("data") if isinstance(event, dict) else None
        if isinstance(data, str):
            try:
                data = json.loads(data)
            except ValueError:
                data = None
        if not isinstance(data, dict):
            return WebhookResult(ignored=True)
        cid = str(data.get("id") or "")
        if not cid.startswith("chr_"):
            cid = str((data.get("charge") or {}).get("id") or data.get("charge_id") or "")
        if not cid.startswith("chr_") or not cid.replace("_", "").isalnum():
            return WebhookResult(ignored=True)
        # Nunca se confía en el cuerpo: el cargo se consulta a la API.
        ch = self._api("GET", f"/v2/charges/{cid}")
        meta = ch.get("metadata") or {}
        sid = str(meta.get("subscription_id") or "")
        return WebhookResult(
            payment=PaymentUpdate(
                provider_ref=str(ch["id"]),
                status=charge_status(ch),
                amount_cents=int(ch.get("amount") or 0),
                currency=str(ch.get("currency_code") or "PEN"),
                subscription_id=int(sid) if sid.isdigit() else None,
                external_reference=meta.get("external_reference"),
                provider_subscription_id=ch.get("subscription_id") or meta.get("culqi_subscription_id"),
                raw=sanitize(ch),
            )
        )

    # --- Administración ------------------------------------------------------------------
    def refund(self, db: Session, payment: Payment) -> None:
        if not payment.provider_ref.startswith("chr_"):
            raise InvalidState("Este cobro no tiene un cargo de Culqi que reembolsar")
        try:
            self._api(
                "POST",
                "/v2/refunds",
                {"amount": payment.amount_pen, "charge_id": payment.provider_ref, "reason": "solicitud_comprador"},
                key=f"refund-{payment.provider_ref}",
            )
        except GatewayError as e:
            raise GatewayFailed("Culqi rechazó el reembolso", details={"status": e.status}) from None

    def cancel_recurring(self, db: Session, sub: Subscription) -> None:
        if not sub.provider_subscription_id:
            return
        try:
            self._api("DELETE", f"/v2/recurrent/subscriptions/{sub.provider_subscription_id}")
        except GatewayError as e:
            raise GatewayFailed("Culqi no canceló la suscripción", details={"status": e.status}) from None
