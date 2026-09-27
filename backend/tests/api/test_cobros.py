"""Cobros con pasarela (Mercado Pago y Culqi), comprobantes, cupones y prueba gratis.

Las pasarelas se simulan con un servidor HTTP falso: se reemplaza
``gateway_http.send``, el único punto que habla con la red.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from datetime import UTC, datetime, timedelta
from urllib.parse import urlsplit

import pytest
from pydantic import SecretStr

from app.config import get_settings
from app.db import base
from app.db.models import Invoice, Payment, Subscription
from app.services import gateway_http
from tests.api.test_organizaciones import as_user, org_with_owner
from tests.api.test_permissions import login_as

# Los cobros vienen apagados (HAJIME_PAYMENTS_ENABLED=false): aquí se prueba su código.
pytestmark = pytest.mark.usefixtures("cobros_activos")

MP_SECRET = "secreto-de-prueba"
CULQI_WEBHOOK = "clave-aviso"


class FakeGateway:
    """Servidor falso: rutas (método, ruta) → (status, cuerpo) o función(cuerpo) → (status, cuerpo)."""

    def __init__(self):
        self.routes: dict[tuple[str, str], object] = {}
        self.calls: list[dict] = []

    def on(self, method: str, path: str, reply) -> None:
        self.routes[(method, path)] = reply

    def __call__(self, method, url, headers, data, timeout):
        parts = urlsplit(url)
        body = json.loads(data) if data else None
        self.calls.append(
            {"method": method, "host": parts.netloc, "path": parts.path, "headers": headers, "body": body}
        )
        reply = self.routes.get((method, parts.path))
        if reply is None:
            return gateway_http.RawResponse(404, b'{"message": "not_found"}')
        status, out = reply(body) if callable(reply) else reply
        return gateway_http.RawResponse(status, json.dumps(out).encode())

    def called(self, method: str, path: str) -> list[dict]:
        return [c for c in self.calls if c["method"] == method and c["path"] == path]


@pytest.fixture()
def gw(monkeypatch):
    fake = FakeGateway()
    monkeypatch.setattr(gateway_http, "send", fake)
    monkeypatch.setattr(gateway_http.time, "sleep", lambda s: None)
    st = get_settings()
    monkeypatch.setattr(st, "public_url", "https://hajime.test")
    monkeypatch.setattr(st, "billing_mode", "enforced")
    return fake


@pytest.fixture()
def mp(gw, monkeypatch):
    st = get_settings()
    monkeypatch.setattr(st, "payment_provider", "mercadopago")
    monkeypatch.setattr(st, "mp_access_token", SecretStr("TEST-token-mp"))
    monkeypatch.setattr(st, "mp_webhook_secret", SecretStr(MP_SECRET))
    return gw


@pytest.fixture()
def culqi(gw, monkeypatch):
    st = get_settings()
    monkeypatch.setattr(st, "payment_provider", "culqi")
    monkeypatch.setattr(st, "culqi_secret_key", SecretStr("sk_test_falsa"))
    monkeypatch.setattr(st, "culqi_public_key", "pk_test_publica")
    monkeypatch.setattr(st, "culqi_webhook_secret", SecretStr(CULQI_WEBHOOK))
    return gw


@pytest.fixture()
def nubefact(monkeypatch):
    st = get_settings()
    monkeypatch.setattr(st, "invoicing_provider", "nubefact")
    monkeypatch.setattr(st, "nubefact_url", SecretStr("https://api.nubefact.com/api/v1/ruta-falsa"))
    monkeypatch.setattr(st, "nubefact_token", SecretStr("token-falso"))


def db_session():
    return next(base.get_session())


def mp_signature(data_id: str, request_id: str = "req-1", ts: str = "1727380000", secret: str = MP_SECRET) -> dict:
    manifest = f"id:{data_id};request-id:{request_id};ts:{ts};"
    v1 = hmac.new(secret.encode(), manifest.encode(), hashlib.sha256).hexdigest()
    return {"x-signature": f"ts={ts},v1={v1}", "x-request-id": request_id}


def mp_notify(api, kind: str, data_id: str, headers: dict | None = None, expect: int = 200):
    body = {"action": f"{kind}.updated", "type": kind, "data": {"id": data_id}}
    r = api.c.post(
        f"/api/v1/payments/webhook/mercadopago?data.id={data_id}&type={kind}",
        content=json.dumps(body),
        headers=headers if headers is not None else mp_signature(data_id),
    )
    assert r.status_code == expect, r.text
    return r.json()


def mp_payment(pid: int, ref: str, amount: float, status: str = "approved", **extra) -> dict:
    return {
        "id": pid,
        "status": status,
        "status_detail": "accredited" if status == "approved" else "cc_rejected_other_reason",
        "transaction_amount": amount,
        "currency_id": "PEN",
        "external_reference": ref,
        # Datos de la tarjeta que NUNCA deben llegar a la base.
        "card": {"first_six_digits": "450995", "last_four_digits": "3704", "cardholder": {"name": "APRO"}},
        "payer": {"email": "pagador@example.com", "identification": {"type": "DNI", "number": "12345678"}},
        **extra,
    }


def sub_row(sid: int) -> Subscription:
    db = db_session()
    return db.get(Subscription, sid)


def days_left(sub: Subscription) -> float:
    return (sub.current_period_end - datetime.now(UTC).replace(tzinfo=None)).total_seconds() / 86400


# --- Mercado Pago -------------------------------------------------------------------------------------


def test_mercadopago_checkout_webhook_idempotente_y_firma(client, mp):
    api = client
    org, owner, _ = org_with_owner(api, "Liga MP", "duena_mp")
    mp.on("POST", "/checkout/preferences", (201, {"id": "pref-1", "init_point": "https://mp.test/checkout/pref-1"}))
    co = owner.post(f"/organizations/{org['id']}/checkout", {"plan_code": "organizador", "period": "year"})
    assert co["provider"] == "mercadopago" and co["url"] == "https://mp.test/checkout/pref-1"
    assert co["amount_cents"] == 149000 and not co["recurring"] and co["status"] == "past_due"
    call = mp.called("POST", "/checkout/preferences")[0]
    assert call["headers"]["Authorization"] == "Bearer TEST-token-mp"
    assert call["headers"]["X-Idempotency-Key"].startswith("pref-hjm-")
    pref = call["body"]
    assert pref["items"][0]["unit_price"] == 1490.0 and pref["items"][0]["currency_id"] == "PEN"
    assert pref["notification_url"] == "https://hajime.test/api/v1/payments/webhook/mercadopago"
    assert pref["back_urls"]["success"].startswith("https://hajime.test/pago/exito")
    ref = pref["external_reference"]
    assert owner.raw("POST", "/tournaments", json={"name": "Copa", "start_date": "2026-11-20"}).status_code == 402

    # Firma inválida → 401, sin consultar la API ni tocar nada.
    mp.on("GET", "/v1/payments/5001", (200, mp_payment(5001, ref, 1490.0)))
    bad = mp_signature("5001", secret="otra-clave")
    mp_notify(api, "payment", "5001", headers=bad, expect=401)
    mp_notify(api, "payment", "5001", headers={}, expect=401)
    assert not mp.called("GET", "/v1/payments/5001")

    # Aviso válido: se consulta el pago a la API y la suscripción queda activa un año.
    out = mp_notify(api, "payment", "5001")
    assert out["subscription_id"] == co["subscription_id"]
    sub = sub_row(co["subscription_id"])
    assert sub.status == "active" and 364 < days_left(sub) <= 365
    owner.post("/tournaments", {"name": "Copa", "start_date": "2026-11-20", "organization_id": org["id"]}, expect=201)

    # El mismo aviso otra vez: no duplica el pago ni extiende otra vez el periodo.
    end = sub.current_period_end
    mp_notify(api, "payment", "5001")
    db = db_session()
    pays = db.query(Payment).all()
    assert len(pays) == 1 and pays[0].status == "approved" and pays[0].amount_pen == 149000
    assert db.get(Subscription, co["subscription_id"]).current_period_end == end
    # Nada de la tarjeta ni del documento del pagador en la base.
    raw = json.dumps(pays[0].raw)
    assert "450995" not in raw and "3704" not in raw and "12345678" not in raw and "card" not in raw

    # Historial de pagos de la organización.
    hist = owner.get(f"/organizations/{org['id']}/payments")
    assert hist[0]["provider_ref"] == "5001" and hist[0]["plan_name"] == "Organizador"


def test_mercadopago_mensual_rechazo_y_gracia(client, mp):
    api = client
    org, owner, _ = org_with_owner(api, "Dojo Mensual", "duena_mm")
    mp.on("POST", "/preapproval", (201, {"id": "pre-77", "init_point": "https://mp.test/sub/pre-77"}))
    body = {"plan_code": "dojo", "period": "month"}
    r = owner.raw("POST", f"/organizations/{org['id']}/checkout", json=body)
    assert r.status_code == 409 and r.json()["error"]["code"] == "PAYER_EMAIL_REQUIRED"
    co = owner.post(f"/organizations/{org['id']}/checkout", {**body, "payer_email": "sensei@example.com"})
    assert co["recurring"] and co["url"] == "https://mp.test/sub/pre-77"
    pre = mp.called("POST", "/preapproval")[-1]["body"]
    assert pre["auto_recurring"] == {
        "frequency": 1,
        "frequency_type": "months",
        "transaction_amount": 69.0,
        "currency_id": "PEN",
    }
    ref = pre["external_reference"]

    # El titular autoriza el preapproval y llega el primer cobro mensual.
    mp.on("GET", "/preapproval/pre-77", (200, {"id": "pre-77", "status": "authorized", "external_reference": ref}))
    mp_notify(api, "subscription_preapproval", "pre-77")
    mp.on(
        "GET",
        "/authorized_payments/9001",
        (200, {"id": 9001, "preapproval_id": "pre-77", "status": "processed", "payment": {"id": 6001}}),
    )
    mp.on("GET", "/v1/payments/6001", (200, mp_payment(6001, ref, 69.0)))
    mp_notify(api, "subscription_authorized_payment", "9001")
    mp_notify(api, "payment", "6001")  # el mismo cobro avisado como «payment»: no se duplica
    sub = sub_row(co["subscription_id"])
    assert sub.status == "active" and 29 < days_left(sub) <= 30 and sub.provider_subscription_id == "pre-77"
    assert len(db_session().query(Payment).all()) == 1
    info = owner.get(f"/subscriptions/{sub.id}/status")
    assert info["recurring"] and info["is_current"] and not info["in_grace"]

    # Ya se renueva sola: no se puede volver a pagar a mano.
    r = owner.raw("POST", f"/organizations/{org['id']}/checkout", json={**body, "payer_email": "sensei@example.com"})
    assert r.status_code == 409

    # Renovación rechazada: past_due con gracia (sigue con acceso).
    mp.on(
        "GET",
        "/authorized_payments/9002",
        (200, {"id": 9002, "preapproval_id": "pre-77", "status": "processed", "payment": {"id": 6002}}),
    )
    mp.on("GET", "/v1/payments/6002", (200, mp_payment(6002, ref, 69.0, status="rejected")))
    mp_notify(api, "subscription_authorized_payment", "9002")
    db = db_session()
    sub = db.get(Subscription, co["subscription_id"])
    assert sub.status == "past_due" and sub.grace_until is not None
    assert (sub.grace_until - sub.current_period_end) == timedelta(days=7)
    info = owner.get(f"/subscriptions/{sub.id}/status")
    assert info["is_current"] and info["in_grace"]
    owner.post("/tournaments", {"name": "Copa G", "start_date": "2026-11-20"}, expect=201)
    alerts = owner.get("/billing/alerts")
    assert alerts and alerts[0]["in_grace"] and alerts[0]["organization_id"] == org["id"]

    # Vencida la gracia: se pierde el acceso.
    sub.grace_until = datetime.now(UTC).replace(tzinfo=None) - timedelta(minutes=1)
    db.commit()
    assert owner.raw("POST", "/tournaments", json={"name": "Copa H", "start_date": "2026-11-20"}).status_code == 402

    # Pago recuperado: vuelve a activa y sin gracia.
    mp.on("GET", "/v1/payments/6003", (200, mp_payment(6003, ref, 69.0)))
    mp_notify(api, "payment", "6003")
    sub = sub_row(co["subscription_id"])
    assert sub.status == "active" and sub.grace_until is None

    # Cancelación por la dueña: se cancela el preapproval y conserva el acceso hasta el fin del periodo.
    mp.on("PUT", "/preapproval/pre-77", (200, {"id": "pre-77", "status": "cancelled"}))
    out = owner.post(f"/subscriptions/{sub.id}/cancel")
    assert out["cancel_at_period_end"] and out["status"] == "active" and out["is_current"] and not out["recurring"]
    assert mp.called("PUT", "/preapproval/pre-77")[0]["body"] == {"status": "cancelled"}


def test_mercadopago_vencida_sin_aviso_tiene_gracia(client, mp):
    """Suscripción recurrente cuyo cobro no llegó a tiempo: conserva el acceso durante la gracia."""
    api = client
    org, owner, _ = org_with_owner(api, "Dojo Tarde", "duena_t")
    db = db_session()
    now = datetime.now(UTC).replace(tzinfo=None)
    sub = Subscription(
        organization_id=org["id"],
        plan_code="dojo",
        status="active",
        source="payment",
        provider="mercadopago",
        provider_subscription_id="pre-tarde",
        current_period_end=now - timedelta(days=2),
    )
    db.add(sub)
    db.commit()
    info = owner.get(f"/subscriptions/{sub.id}/status")
    assert info["is_current"] and info["in_grace"]
    sub.current_period_end = now - timedelta(days=8)
    db.commit()
    assert not owner.get(f"/subscriptions/{sub.id}/status")["is_current"]


def test_mercadopago_reembolso_y_limite_del_cuerpo(client, mp):
    api = client
    org, owner, _ = org_with_owner(api, "Liga Reembolso", "duena_r")
    mp.on("POST", "/checkout/preferences", (201, {"id": "pref-2", "init_point": "https://mp.test/p2"}))
    co = owner.post(f"/organizations/{org['id']}/checkout", {"plan_code": "dojo", "period": "year"})
    ref = mp.called("POST", "/checkout/preferences")[0]["body"]["external_reference"]
    mp.on("GET", "/v1/payments/7001", (200, mp_payment(7001, ref, 690.0)))
    mp_notify(api, "payment", "7001")
    pay = api.get("/payments", params={"q": "Liga Reembolso"})[0]
    assert pay["status"] == "approved" and pay["organization_name"] == "Liga Reembolso"

    # Solo el Admin reembolsa; se llama a la API con clave de idempotencia.
    assert owner.raw("POST", f"/payments/{pay['id']}/refund", json={"reason": "Pedido del cliente"}).status_code == 403
    mp.on("POST", "/v1/payments/7001/refunds", (201, {"id": 1, "status": "approved"}))
    out = api.post(f"/payments/{pay['id']}/refund", {"reason": "Pedido del cliente"})
    assert out["status"] == "refunded"
    assert mp.called("POST", "/v1/payments/7001/refunds")[0]["headers"]["X-Idempotency-Key"] == "refund-7001"
    assert sub_row(co["subscription_id"]).status == "canceled"
    # El aviso posterior de «refunded» no cambia nada (no retrocede ni duplica).
    mp.on("GET", "/v1/payments/7001", (200, mp_payment(7001, ref, 690.0, status="refunded")))
    mp_notify(api, "payment", "7001")
    assert len(db_session().query(Payment).all()) == 1

    # Aviso de un pago que la API no conoce (p. ej. la prueba del panel): 200 e ignorado.
    assert mp_notify(api, "payment", "123456")["ignored"]
    # Cuerpo demasiado grande: 413.
    r = api.c.post("/api/v1/payments/webhook/mercadopago", content=b"x" * 70_000, headers=mp_signature("1"))
    assert r.status_code == 413
    # Proveedor manual: no recibe avisos.
    assert api.raw("POST", "/payments/webhook/manual", content=b"{}").status_code == 400


def test_mercadopago_reintenta_con_la_misma_clave(client, mp):
    api = client
    org, owner, _ = org_with_owner(api, "Liga Reintento", "duena_ri")
    answers = iter([(503, {"message": "ocupado"}), (201, {"id": "pref-3", "init_point": "https://mp.test/p3"})])
    mp.on("POST", "/checkout/preferences", lambda body: next(answers))
    co = owner.post(f"/organizations/{org['id']}/checkout", {"plan_code": "dojo", "period": "year"})
    assert co["url"] == "https://mp.test/p3"
    calls = mp.called("POST", "/checkout/preferences")
    assert len(calls) == 2 and calls[0]["headers"]["X-Idempotency-Key"] == calls[1]["headers"]["X-Idempotency-Key"]


# --- Culqi ------------------------------------------------------------------------------------------------


def culqi_charge(cid: str, amount: int, sid: int, ok: bool = True) -> dict:
    return {
        "object": "charge",
        "id": cid,
        "amount": amount,
        "currency_code": "PEN",
        "email": "sensei@example.com",
        "outcome": {"type": "venta_exitosa" if ok else "venta_rechazada", "code": "AUT0000"},
        "source": {"id": "tkn_test", "card_number": "411111******1111", "iin": {"bin": "411111"}},
        "metadata": {"subscription_id": str(sid)},
    }


def basic(password: str) -> dict:
    return {"Authorization": "Basic " + base64.b64encode(f"culqi:{password}".encode()).decode()}


def test_culqi_cargo_webhook_y_rechazo(client, culqi):
    api = client
    org, owner, _ = org_with_owner(api, "Dojo Culqi", "duena_c")
    assert api.get("/billing/config")["culqi_public_key"] == "pk_test_publica"
    co = owner.post(f"/organizations/{org['id']}/checkout", {"plan_code": "dojo", "period": "year"})
    assert co["provider"] == "culqi" and co["public_key"] == "pk_test_publica" and co["url"] is None
    sid = co["subscription_id"]

    # Tarjeta rechazada: pago rechazado, sin acceso.
    culqi.on(
        "POST",
        "/v2/charges",
        (402, {"object": "error", "type": "card_error", "charge_id": "chr_rechazo_1", "user_message": "Fondos"}),
    )
    pay = owner.post("/payments/culqi/charge", {"subscription_id": sid, "token": "tkn_malo", "email": "s@example.com"})
    assert pay["status"] == "rejected" and pay["provider_ref"] == "chr_rechazo_1"
    assert sub_row(sid).status == "past_due" and not owner.get(f"/subscriptions/{sid}/status")["is_current"]

    # Otro token: cargo aprobado → activa un año.
    culqi.on("POST", "/v2/charges", lambda body: (201, culqi_charge("chr_ok_1", body["amount"], sid)))
    body = {"subscription_id": sid, "token": "tkn_bueno", "email": "s@example.com"}
    pay = owner.post("/payments/culqi/charge", body)
    assert pay["status"] == "approved" and pay["amount_pen"] == 69000
    sent = culqi.called("POST", "/v2/charges")[-1]
    assert sent["headers"]["Authorization"] == "Bearer sk_test_falsa"
    assert sent["body"]["source_id"] == "tkn_bueno" and sent["body"]["currency_code"] == "PEN"
    assert 364 < days_left(sub_row(sid)) <= 365
    # El navegador reintenta con el mismo token: no se cobra dos veces.
    again = owner.post("/payments/culqi/charge", body)
    assert again["id"] == pay["id"] and len(culqi.called("POST", "/v2/charges")) == 2
    raw = json.dumps(db_session().get(Payment, pay["id"]).raw)
    assert "411111" not in raw and "card_number" not in raw

    # Aviso: sin autenticación correcta → 401.
    event = {"object": "event", "type": "charge.creation.succeeded", "data": json.dumps({"id": "chr_ok_1"})}
    url = "/api/v1/payments/webhook/culqi"
    assert api.c.post(url, content=json.dumps(event), headers=basic("otra")).status_code == 401
    assert api.c.post(url, content=json.dumps(event)).status_code == 401
    # Con autenticación: se consulta el cargo a la API; el mismo cargo no se duplica.
    culqi.on("GET", "/v2/charges/chr_ok_1", (200, culqi_charge("chr_ok_1", 69000, sid)))
    end = sub_row(sid).current_period_end
    r = api.c.post(url, content=json.dumps(event), headers=basic(CULQI_WEBHOOK))
    assert r.status_code == 200 and r.json()["subscription_id"] == sid
    assert sub_row(sid).current_period_end == end
    assert db_session().query(Payment).filter(Payment.status == "approved").count() == 1

    # Un cargo nuevo avisado por Culqi (p. ej. de la suscripción recurrente) sí extiende.
    culqi.on("GET", "/v2/charges/chr_ok_2", (200, culqi_charge("chr_ok_2", 69000, sid)))
    event2 = {**event, "data": {"id": "chr_ok_2"}}
    api.c.post(url, content=json.dumps(event2), headers=basic(CULQI_WEBHOOK))
    assert 729 < days_left(sub_row(sid)) <= 730

    # Reembolso por el Admin en Culqi.
    culqi.on("POST", "/v2/refunds", (201, {"object": "refund", "id": "ref_1"}))
    api.post(f"/payments/{pay['id']}/refund", {"reason": "Cobro duplicado", "cancel_subscription": False})
    assert culqi.called("POST", "/v2/refunds")[0]["body"] == {
        "amount": 69000,
        "charge_id": "chr_ok_1",
        "reason": "solicitud_comprador",
    }
    assert sub_row(sid).status == "active"


def test_culqi_suscripcion_recurrente(client, culqi, monkeypatch):
    api = client
    monkeypatch.setattr(get_settings(), "culqi_plan_ids", {"dojo:month": "pln_test_dojo"})
    org, owner, _ = org_with_owner(api, "Dojo Recurrente", "duena_cr")
    co = owner.post(f"/organizations/{org['id']}/checkout", {"plan_code": "dojo", "period": "month"})
    assert co["recurring"]
    culqi.on("POST", "/v2/customers", (201, {"id": "cus_1"}))
    culqi.on("POST", "/v2/cards", (201, {"id": "crd_1"}))
    culqi.on("POST", "/v2/recurrent/subscriptions/create", (201, {"id": "sxn_1", "status": 1}))
    body = {
        "subscription_id": co["subscription_id"],
        "token": "tkn_rec",
        "email": "s@example.com",
        "first_name": "Ana",
        "last_name": "Pérez",
        "phone": "987654321",
    }
    pay = owner.post("/payments/culqi/charge", body)
    assert pay["status"] == "pending"
    sent = culqi.called("POST", "/v2/recurrent/subscriptions/create")[0]["body"]
    assert sent["plan_id"] == "pln_test_dojo" and sent["card_id"] == "crd_1"
    sub = sub_row(co["subscription_id"])
    assert sub.provider_subscription_id == "sxn_1" and sub.status == "past_due"
    # El primer cobro llega por aviso.
    culqi.on("GET", "/v2/charges/chr_rec_1", (200, culqi_charge("chr_rec_1", 6900, sub.id)))
    event = {"object": "event", "type": "charge.creation.succeeded", "data": {"id": "chr_rec_1"}}
    api.c.post("/api/v1/payments/webhook/culqi", content=json.dumps(event), headers=basic(CULQI_WEBHOOK))
    sub = sub_row(sub.id)
    assert sub.status == "active" and 29 < days_left(sub) <= 30
    # Cancelar: se borra la suscripción en Culqi.
    culqi.on("DELETE", "/v2/recurrent/subscriptions/sxn_1", (200, {"deleted": True}))
    owner.post(f"/subscriptions/{sub.id}/cancel")
    assert culqi.called("DELETE", "/v2/recurrent/subscriptions/sxn_1")


# --- Cupones y prueba gratis ---------------------------------------------------------------------------------


def test_prueba_gratis_y_cupones(client, mp):
    api = client
    org, owner, _ = org_with_owner(api, "Dojo Prueba", "duena_pr")
    plans = {p["code"]: p for p in api.get("/plans")["plans"]}
    assert plans["dojo"]["trial_days"] == 30 and plans["competidor_plus"]["trial_days"] == 0

    # Prueba de 30 días, una sola vez.
    trial = owner.post(f"/organizations/{org['id']}/trial", {"plan_code": "dojo"}, expect=201)
    assert trial["status"] == "trial" and trial["is_current"]
    owner.post("/tournaments", {"name": "Copa T", "start_date": "2026-11-20"}, expect=201)
    r = owner.raw("POST", f"/organizations/{org['id']}/trial", json={"plan_code": "dojo"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "TRIAL_USED"
    alerts = owner.get("/billing/alerts")
    assert alerts == []  # faltan 30 días: todavía no avisa

    # Cupones (solo el Admin los crea).
    c50 = {"code": "mitad", "percent_off": 50, "plan_codes": ["dojo"], "first_period_only": True}
    assert owner.raw("POST", "/coupons", json=c50).status_code == 403
    api.post("/coupons", c50, expect=201)
    q = owner.get("/plans/dojo/quote?period=month&coupon_code=MITAD")
    assert (q["list_cents"], q["discount_cents"], q["first_cents"], q["recurring_cents"]) == (6900, 3450, 3450, 6900)
    r = owner.raw("GET", "/plans/organizador/quote?period=month&coupon_code=MITAD")
    assert r.status_code == 409 and r.json()["error"]["code"] == "COUPON_INVALID"
    past = (datetime.now(UTC) - timedelta(days=1)).isoformat()
    api.post("/coupons", {"code": "VENCIDO", "amount_off_pen": 1000, "expires_at": past}, expect=201)
    assert owner.raw("GET", "/plans/dojo/quote?coupon_code=VENCIDO").status_code == 409

    # Pagar durante la prueba con cupón del primer mes: pago único (no recurrente) con descuento;
    # se reutiliza la suscripción de prueba y el periodo se suma al final de la prueba.
    mp.on("POST", "/checkout/preferences", (201, {"id": "pref-c", "init_point": "https://mp.test/pc"}))
    co = owner.post(
        f"/organizations/{org['id']}/checkout", {"plan_code": "dojo", "period": "month", "coupon_code": "mitad"}
    )
    assert co["subscription_id"] == trial["id"] and not co["recurring"] and co["amount_cents"] == 3450
    pref = mp.called("POST", "/checkout/preferences")[0]["body"]
    assert pref["items"][0]["unit_price"] == 34.5
    mp.on("GET", "/v1/payments/8001", (200, mp_payment(8001, pref["external_reference"], 34.5)))
    mp_notify(api, "payment", "8001")
    sub = sub_row(trial["id"])
    assert sub.status == "active" and 59 < days_left(sub) <= 60
    assert sub.amount_cents == 6900  # las renovaciones van a precio completo
    coupon = next(c for c in api.get("/coupons") if c["code"] == "MITAD")
    assert coupon["times_redeemed"] == 1
    assert owner.get(f"/organizations/{org['id']}/payments")[0]["coupon_code"] == "MITAD"

    # Un pago menor al esperado no activa nada (defensa).
    api.post("/coupons", {"code": "GRATIS", "percent_off": 100, "max_redemptions": 1}, expect=201)
    org2, owner2, _ = org_with_owner(api, "Dojo Gratis", "duena_g")
    co2 = owner2.post(
        f"/organizations/{org2['id']}/checkout",
        {"plan_code": "organizador", "period": "month", "coupon_code": "gratis"},
    )
    assert co2["provider"] == "coupon" and co2["status"] == "active" and co2["url"] is None
    assert 29 < days_left(sub_row(co2["subscription_id"])) <= 30
    # Se agotó el cupón.
    r = owner2.raw("GET", "/plans/organizador/quote?coupon_code=GRATIS")
    assert r.status_code == 409


def test_monto_menor_no_activa(client, mp):
    api = client
    org, owner, _ = org_with_owner(api, "Dojo Monto", "duena_mo")
    mp.on("POST", "/checkout/preferences", (201, {"id": "pref-m", "init_point": "https://mp.test/pm"}))
    co = owner.post(f"/organizations/{org['id']}/checkout", {"plan_code": "dojo", "period": "year"})
    ref = mp.called("POST", "/checkout/preferences")[0]["body"]["external_reference"]
    mp.on("GET", "/v1/payments/8101", (200, mp_payment(8101, ref, 1.0)))
    mp_notify(api, "payment", "8101")
    assert sub_row(co["subscription_id"]).status == "past_due"


# --- Competidor Plus y comprobantes ------------------------------------------------------------------------------


def test_competidor_plus_boleta_y_factura(client, mp, nubefact):
    api = client
    hdr = login_as(api, "competidora")
    me = as_user(api, hdr)
    mp.on("POST", "/checkout/preferences", (201, {"id": "pref-plus", "init_point": "https://mp.test/plus"}))
    r = me.raw("POST", "/me/checkout", json={"plan_code": "dojo", "period": "year"})
    assert r.status_code == 409  # plan de organización
    co = me.post(
        "/me/checkout",
        {"plan_code": "competidor_plus", "period": "year", "billing_doc": "44556677", "billing_name": "Ana Pérez"},
    )
    assert co["amount_cents"] == 4900
    ref = mp.called("POST", "/checkout/preferences")[0]["body"]["external_reference"]

    # Nubefact falso: primero falla, luego acepta.
    answers = iter(
        [
            (400, {"errors": "El documento del cliente es inválido"}),
            (200, {"errors": "No existe"}),  # la consulta del reintento
            (
                200,
                {
                    "aceptada_por_sunat": True,
                    "sunat_description": "La Boleta numero BBB1-1, ha sido aceptada",
                    "enlace_del_pdf": "https://nubefact.test/b1.pdf",
                    "enlace_del_xml": "https://nubefact.test/b1.xml",
                },
            ),
        ]
    )
    mp.on("POST", "/api/v1/ruta-falsa", lambda body: next(answers))
    mp.on("GET", "/v1/payments/9901", (200, mp_payment(9901, ref, 49.0)))
    mp_notify(api, "payment", "9901")
    subs = me.get("/me/subscriptions")
    assert subs[0]["status"] == "active" and subs[0]["plan_code"] == "competidor_plus"
    pays = me.get("/me/payments")
    assert pays[0]["invoice"]["status"] == "error" and pays[0]["invoice"]["serie"] == "BBB1"
    sent = [c for c in mp.calls if c["path"] == "/api/v1/ruta-falsa"][0]
    assert sent["headers"]["Authorization"] == 'Token token="token-falso"'
    b = sent["body"]
    assert b["tipo_de_comprobante"] == 2 and b["cliente_tipo_de_documento"] == "1"
    assert b["cliente_numero_de_documento"] == "44556677" and b["total"] == 49.0
    assert b["total_gravada"] == 41.53 and b["total_igv"] == 7.47
    # El Admin reintenta con el mismo número.
    out = api.post(f"/payments/{pays[0]['id']}/invoice")
    inv = out["invoice"]
    assert inv["status"] == "accepted" and inv["numero"] == 1 and inv["pdf_url"].endswith("b1.pdf")

    # Factura a una organización con RUC.
    org, owner, _ = org_with_owner(api, "Liga Factura", "duena_f")
    ver = owner.get(f"/organizations/{org['id']}")["version"]
    owner.patch(
        f"/organizations/{org['id']}",
        {"version": ver, "tax_id": "20123456789", "legal_name": "LIGA FACTURA S.A.C.", "tax_address": "Av. Lima 1"},
    )
    mp.on("POST", "/checkout/preferences", (201, {"id": "pref-f", "init_point": "https://mp.test/f"}))
    owner.post(f"/organizations/{org['id']}/checkout", {"plan_code": "dojo", "period": "year"})
    ref = mp.called("POST", "/checkout/preferences")[-1]["body"]["external_reference"]
    mp.on(
        "POST",
        "/api/v1/ruta-falsa",
        (200, {"aceptada_por_sunat": True, "enlace_del_pdf": "https://nubefact.test/f1.pdf"}),
    )
    mp.on("GET", "/v1/payments/9902", (200, mp_payment(9902, ref, 690.0)))
    mp_notify(api, "payment", "9902")
    inv = owner.get(f"/organizations/{org['id']}/payments")[0]["invoice"]
    assert inv["doc_type"] == "factura" and inv["serie"] == "FFF1" and inv["numero"] == 1
    b = [c for c in mp.calls if c["path"] == "/api/v1/ruta-falsa"][-1]["body"]
    assert b["tipo_de_comprobante"] == 1 and b["cliente_tipo_de_documento"] == "6"
    assert b["cliente_denominacion"] == "LIGA FACTURA S.A.C." and b["cliente_direccion"] == "Av. Lima 1"
    assert db_session().query(Invoice).count() == 2
    # Un RUC mal formado se rechaza.
    ver = owner.get(f"/organizations/{org['id']}")["version"]
    r = owner.raw("PATCH", f"/organizations/{org['id']}", json={"version": ver, "tax_id": "123"})
    assert r.status_code == 422


def test_aviso_de_vencimiento_y_config(client, gw):
    api = client
    assert api.get("/billing/config")["provider"] == "manual"
    org, owner, _ = org_with_owner(api, "Dojo Vence", "duena_v")
    end = (datetime.now(UTC) + timedelta(days=3, hours=1)).isoformat()
    api.post(
        "/subscriptions", {"organization_id": org["id"], "plan_code": "dojo", "current_period_end": end}, expect=201
    )
    alerts = owner.get("/billing/alerts")
    assert len(alerts) == 1 and alerts[0]["days_left"] == 3 and not alerts[0]["in_grace"]
    # Un miembro que no administra no recibe el aviso.
    hdr = login_as(api, "miembro_v")
    uid = api.raw("GET", "/auth/me", headers=hdr).json()["id"]
    api.post(f"/organizations/{org['id']}/members", {"user_id": uid, "role": "member"}, expect=201)
    assert as_user(api, hdr).get("/billing/alerts") == []
