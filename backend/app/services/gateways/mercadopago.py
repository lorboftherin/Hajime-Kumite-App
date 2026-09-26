"""Mercado Pago Perú: Checkout Pro, suscripciones (preapproval) y avisos firmados.

- Pago único (anual, o mensual con cupón del primer mes): preferencia de
  Checkout Pro (``POST /checkout/preferences``); el navegador va a
  ``init_point`` y vuelve a ``/pago/exito|pendiente|error``.
- Mensual automático: ``POST /preapproval`` con ``auto_recurring`` mensual.
- Avisos (``POST /api/v1/payments/webhook/mercadopago``): se verifica la
  cabecera ``x-signature`` (HMAC-SHA256 del manifiesto
  ``id:<data.id>;request-id:<x-request-id>;ts:<ts>;`` con la clave secreta) y
  luego se CONSULTA el pago a la API: el cuerpo del aviso nunca decide el estado.

Credenciales solo por entorno: ``HAJIME_MP_ACCESS_TOKEN`` y ``HAJIME_MP_WEBHOOK_SECRET``.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
from typing import Any

from sqlalchemy.orm import Session

from app.api.errors import InvalidState, Unauthorized
from app.config import get_settings
from app.db.models import Payment, Subscription
from app.services.gateway_http import GatewayError, request_json, sanitize
from app.services.payments import (
    Checkout,
    CheckoutContext,
    GatewayFailed,
    GatewayNotConfigured,
    PaymentUpdate,
    Period,
    WebhookResult,
)

log = logging.getLogger("hajime.pagos")

# Estado del pago en Mercado Pago → estado en Hajime.
STATUS = {
    "approved": "approved",
    "authorized": "pending",
    "pending": "pending",
    "in_process": "pending",
    "in_mediation": "pending",
    "rejected": "rejected",
    "cancelled": "rejected",
    "refunded": "refunded",
    "charged_back": "refunded",
}


def to_cents(amount: Any) -> int:
    try:
        return round(float(amount or 0) * 100)
    except (TypeError, ValueError):
        return 0


def signature_ok(secret: str, x_signature: str, request_id: str, data_id: str) -> bool:
    """Verifica ``x-signature`` (``ts=…,v1=…``) según la documentación de Mercado Pago."""
    parts: dict[str, str] = {}
    for chunk in (x_signature or "").split(","):
        k, _, v = chunk.strip().partition("=")
        if k and v:
            parts[k.strip()] = v.strip()
    ts, v1 = parts.get("ts"), parts.get("v1")
    if not ts or not v1:
        return False
    manifest = ""
    if data_id:
        # Los ids alfanuméricos se firman en minúsculas.
        manifest += f"id:{data_id.lower() if data_id.isalnum() else data_id};"
    if request_id:
        manifest += f"request-id:{request_id};"
    manifest += f"ts:{ts};"
    expected = hmac.new(secret.encode(), manifest.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, v1)


class MercadoPagoProvider:
    name = "mercadopago"

    # --- API ------------------------------------------------------------------
    def _token(self) -> str:
        tok = get_settings().mp_access_token
        if tok is None or not tok.get_secret_value():
            raise GatewayNotConfigured("Mercado Pago no está configurado (HAJIME_MP_ACCESS_TOKEN)")
        return tok.get_secret_value()

    def _api(self, method: str, path: str, body: Any = None, key: str | None = None) -> Any:
        s = get_settings()
        try:
            return request_json(
                method,
                s.mp_api_url.rstrip("/") + path,
                headers={"Authorization": f"Bearer {self._token()}"},
                body=body,
                idempotency_key=key,
            )
        except GatewayError as e:
            raise GatewayFailed(
                f"Mercado Pago respondió con error ({e.status})", details={"status": e.status}
            ) from None

    # --- Checkout -----------------------------------------------------------------
    def create_checkout(self, db: Session, sub: Subscription, period: Period, ctx: CheckoutContext) -> Checkout:
        base = ctx.base_url
        amount = round(ctx.amount_cents / 100, 2)
        if ctx.recurring:
            if not ctx.payer_email:
                raise InvalidState(
                    "Para el pago mensual automático indica el correo de tu cuenta de Mercado Pago",
                    code="PAYER_EMAIL_REQUIRED",
                )
            body = {
                "reason": ctx.description,
                "external_reference": ctx.external_reference,
                "payer_email": ctx.payer_email,
                "auto_recurring": {
                    "frequency": 1,
                    "frequency_type": "months",
                    "transaction_amount": amount,
                    "currency_id": "PEN",
                },
                "back_url": f"{base}/pago/exito?subscription_id={sub.id}",
                "status": "pending",
            }
            r = self._api("POST", "/preapproval", body, key=f"preapproval-{ctx.external_reference}")
            return Checkout(
                provider=self.name,
                subscription_id=sub.id,
                url=r.get("init_point"),
                reference=ctx.external_reference,
                provider_subscription_id=str(r.get("id")) if r.get("id") else None,
                instructions="Autoriza el cobro mensual en Mercado Pago.",
                recurring=True,
            )
        back = f"{base}/pago/%s?subscription_id={sub.id}"
        body = {
            "items": [
                {
                    "id": sub.plan_code,
                    "title": ctx.description,
                    "quantity": 1,
                    "unit_price": amount,
                    "currency_id": "PEN",
                }
            ],
            "external_reference": ctx.external_reference,
            "metadata": {"subscription_id": sub.id, "period": period},
            "back_urls": {"success": back % "exito", "pending": back % "pendiente", "failure": back % "error"},
            "auto_return": "approved",
            "notification_url": f"{base}/api/v1/payments/webhook/mercadopago",
            "statement_descriptor": "HAJIME",
        }
        if ctx.payer_email:
            body["payer"] = {"email": ctx.payer_email}
        r = self._api("POST", "/checkout/preferences", body, key=f"pref-{ctx.external_reference}")
        return Checkout(
            provider=self.name,
            subscription_id=sub.id,
            url=r.get("init_point"),
            reference=ctx.external_reference,
            instructions="Serás redirigido a Mercado Pago para pagar.",
        )

    # --- Avisos -------------------------------------------------------------------------
    def handle_webhook(self, db: Session, body: bytes, headers: dict[str, str], query: dict[str, str]) -> WebhookResult:
        secret = get_settings().mp_webhook_secret
        if secret is None or not secret.get_secret_value():
            raise GatewayNotConfigured("Falta la clave secreta de avisos de Mercado Pago (HAJIME_MP_WEBHOOK_SECRET)")
        try:
            payload = json.loads(body or b"{}")
        except ValueError:
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
        data_id = str(query.get("data.id") or query.get("id") or data.get("id") or "")
        if not signature_ok(
            secret.get_secret_value(), headers.get("x-signature", ""), headers.get("x-request-id", ""), data_id
        ):
            raise Unauthorized("Firma del aviso de Mercado Pago inválida", code="INVALID_SIGNATURE")
        kind = str(query.get("type") or query.get("topic") or payload.get("type") or "")
        if not data_id or not data_id.replace("-", "").isalnum():
            return WebhookResult(ignored=True)
        if kind == "payment":
            return WebhookResult(payment=self._payment(data_id))
        if kind == "subscription_authorized_payment":
            return self._authorized_payment(data_id)
        if kind in ("subscription_preapproval", "preapproval"):
            return self._preapproval(data_id)
        return WebhookResult(ignored=True)

    def _payment(self, pid: str) -> PaymentUpdate:
        p = self._api("GET", f"/v1/payments/{pid}")
        meta = p.get("metadata") or {}
        sid = meta.get("subscription_id")
        pos = ((p.get("point_of_interaction") or {}).get("transaction_data") or {}).get("subscription_id")
        return PaymentUpdate(
            provider_ref=str(p["id"]),
            status=STATUS.get(str(p.get("status")), "pending"),
            amount_cents=to_cents(p.get("transaction_amount")),
            currency=str(p.get("currency_id") or "PEN"),
            subscription_id=int(sid) if str(sid or "").isdigit() else None,
            external_reference=p.get("external_reference"),
            provider_subscription_id=meta.get("preapproval_id") or pos,
            raw=sanitize(p),
        )

    def _authorized_payment(self, apid: str) -> WebhookResult:
        """Cobro mensual de un preapproval."""
        ap = self._api("GET", f"/authorized_payments/{apid}")
        pay = ap.get("payment") or {}
        if pay.get("id"):
            # Mismo id que el aviso «payment» del mismo cobro: no se duplica.
            upd = self._payment(str(pay["id"]))
            upd.provider_subscription_id = upd.provider_subscription_id or ap.get("preapproval_id")
            upd.external_reference = upd.external_reference or ap.get("external_reference")
            return WebhookResult(payment=upd)
        st = str(ap.get("status") or "")
        if st in ("scheduled", "pending", "processed", "recycling"):
            return WebhookResult(ignored=True)  # todavía sin pago
        return WebhookResult(
            payment=PaymentUpdate(
                provider_ref=f"ap-{ap.get('id')}",
                status="rejected",
                amount_cents=to_cents(ap.get("transaction_amount")),
                currency=str(ap.get("currency_id") or "PEN"),
                external_reference=ap.get("external_reference"),
                provider_subscription_id=ap.get("preapproval_id"),
                raw=sanitize(ap),
            )
        )

    def _preapproval(self, paid: str) -> WebhookResult:
        pa = self._api("GET", f"/preapproval/{paid}")
        st = str(pa.get("status") or "")
        recurring = {"authorized": "authorized", "cancelled": "cancelled", "paused": "cancelled"}.get(st)
        if recurring is None:
            return WebhookResult(ignored=True)
        return WebhookResult(
            reference=pa.get("external_reference"),
            provider_subscription_id=str(pa.get("id")),
            recurring_status=recurring,
            raw=sanitize(pa),
        )

    # --- Administración -------------------------------------------------------------------
    def refund(self, db: Session, payment: Payment) -> None:
        if not payment.provider_ref.isdigit():
            raise InvalidState("Este cobro no tiene un pago de Mercado Pago que reembolsar")
        self._api("POST", f"/v1/payments/{payment.provider_ref}/refunds", {}, key=f"refund-{payment.provider_ref}")

    def cancel_recurring(self, db: Session, sub: Subscription) -> None:
        if not sub.provider_subscription_id:
            return
        self._api(
            "PUT",
            f"/preapproval/{sub.provider_subscription_id}",
            {"status": "cancelled"},
            key=f"cancel-{sub.provider_subscription_id}",
        )
