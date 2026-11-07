"""Cobros apagados (HAJIME_PAYMENTS_ENABLED=false, el valor por defecto).

Decisión del dueño: por ahora no se cobra. Sin pasarela, las rutas de cobro
responden 404 PAYMENTS_DISABLED, nunca hay 402 (aunque el modo sea enforced),
no salen avisos de vencimiento ni correos de pago y la asignación manual de
planes por el Admin sigue funcionando. Ver docs/cobros.md.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app import billing_reminders
from app.config import get_settings
from app.db import base
from app.db.models import OutboxEmail, Subscription, User
from app.main import create_app
from app.services import billing_mail, entitlements
from tests.api.test_organizaciones import org_with_owner

# (método, ruta, cuerpo) de cada ruta que solo existe con los cobros activos.
RUTAS_DE_COBRO = [
    ("GET", "/plans/dojo/quote?period=month", None),
    ("POST", "/organizations/{oid}/checkout", {"plan_code": "dojo", "period": "month"}),
    ("POST", "/organizations/{oid}/trial", {"plan_code": "dojo"}),
    ("POST", "/me/checkout", {"plan_code": "competidor_plus", "period": "month"}),
    ("POST", "/subscriptions/{sid}/cancel", {}),
    ("POST", "/payments/culqi/charge", {"subscription_id": 1, "token": "tkn_test", "email": "a@example.com"}),
    ("POST", "/payments/1/refund", {"reason": "prueba"}),
    ("POST", "/payments/1/invoice", None),
    ("POST", "/invoices/1/refresh", None),
    ("GET", "/coupons", None),
    ("POST", "/coupons", {"code": "X", "percent_off": 10}),
    ("PATCH", "/coupons/1", {"active": True}),
]


@pytest.fixture()
def enforced_sin_cobros(monkeypatch):
    """Configuración contradictoria: enforced con los cobros apagados."""
    monkeypatch.setattr(get_settings(), "billing_mode", "enforced")


def _db():
    return next(base.get_session())


def _sub_por_vencer(org_id: int) -> int:
    db = _db()
    sub = Subscription(
        organization_id=org_id,
        plan_code="dojo",
        status="active",
        source="manual",
        current_period_end=datetime.now(UTC).replace(tzinfo=None) + timedelta(days=6, hours=2),
    )
    db.add(sub)
    db.commit()
    return sub.id


def test_apagados_por_defecto_y_config_publica(client):
    assert get_settings().payments_enabled is False
    anon = TestClient(client.c.app)
    cfg = anon.get("/api/v1/billing/config").json()  # sin sesión: la interfaz lo lee al arrancar
    assert cfg["payments_enabled"] is False and cfg["mode"] == "marcha_blanca"
    assert client.get("/plans")["mode"] == "marcha_blanca"


def test_rutas_de_cobro_responden_404_payments_disabled(client, enforced_sin_cobros):
    api = client
    org, owner, _ = org_with_owner(api, "Liga Apagada", "duena_apagada")
    sid = api.post("/subscriptions", {"organization_id": org["id"], "plan_code": "dojo"}, expect=201)["id"]
    for method, path, body in RUTAS_DE_COBRO:
        url = path.format(oid=org["id"], sid=sid)
        for quien in (api, owner):  # ni el Admin Global ni el dueño
            r = quien.raw(method, url, json=body) if body is not None else quien.raw(method, url)
            assert r.status_code == 404, f"{method} {url} -> {r.status_code}: {r.text}"
            err = r.json()["error"]
            assert err["code"] == "PAYMENTS_DISABLED" and err["message"] == "Los cobros no están activos"
    # Los avisos de las pasarelas (sin sesión) tampoco se procesan.
    anon = TestClient(api.c.app)
    for prov in ("mercadopago", "culqi", "manual"):
        r = anon.post(f"/api/v1/payments/webhook/{prov}", json={"type": "payment", "data": {"id": "1"}})
        assert r.status_code == 404 and r.json()["error"]["code"] == "PAYMENTS_DISABLED"
    # La suscripción no se tocó.
    assert _db().get(Subscription, sid).status == "active"


def test_enforced_con_cobros_apagados_no_da_402(client, enforced_sin_cobros):
    api = client
    org, owner, _ = org_with_owner(api, "Liga Libre", "duena_libre")
    body = {"name": "Copa Libre", "start_date": "2026-11-20", "organization_id": org["id"], "tatami_count": 2}
    t = owner.post("/tournaments", body, expect=201)  # sin suscripción: marcha blanca
    owner.post(f"/tournaments/{t['id']}/tatamis", {"name": "Tatami 3"}, expect=201)
    r = owner.raw("PUT", f"/tournaments/{t['id']}/self-registration", json={"open": True})
    assert r.status_code != 402, r.text
    info = owner.get(f"/organizations/{org['id']}")
    assert set(info["features"]) == set(entitlements.FEATURES)
    assert entitlements.billing_mode() == "marcha_blanca"
    # Sin avisos de «tu plan vence» en el encabezado.
    _sub_por_vencer(org["id"])
    assert owner.get("/billing/alerts") == []


def test_aviso_en_el_log_al_arrancar_con_enforced_y_cobros_apagados(client, enforced_sin_cobros, caplog):
    with caplog.at_level(logging.WARNING, logger="hajime.pagos"), TestClient(create_app()):
        pass
    avisos = [r.getMessage() for r in caplog.records if r.name == "hajime.pagos"]
    assert any("HAJIME_PAYMENTS_ENABLED" in m and "enforced" in m for m in avisos), avisos


def test_recordatorios_y_correos_de_cobro_no_salen(client, enforced_sin_cobros, monkeypatch):
    api = client
    org, _, owner_id = org_with_owner(api, "Dojo Silencio", "duena_silencio")
    db = _db()
    db.get(User, owner_id).email = "silencio@example.com"
    db.commit()
    sid = _sub_por_vencer(org["id"])
    assert billing_mail.send_reminders(db) == 0
    assert billing_mail.expiring(db, db.get(Subscription, sid), 7) == 0
    db.commit()
    # El proceso diario y el despachador tampoco.
    monkeypatch.setattr(billing_mail, "_last_run", 0.0)
    assert billing_mail.run_if_due(base.session_factory()) == 0
    assert billing_reminders.main() == 0
    assert db.query(OutboxEmail).count() == 0
    # No se reservó el aviso: al activar los cobros sale el que toque.
    db.expire_all()
    assert db.get(Subscription, sid).reminder_key is None


def test_asignacion_manual_del_admin_sigue(client, enforced_sin_cobros):
    """El Admin asigna, extiende y corrige planes a mano: no cobra nada ni manda correos."""
    api = client
    org, owner, _ = org_with_owner(api, "Liga Manual", "duena_manual")
    sub = api.post("/subscriptions", {"organization_id": org["id"], "plan_code": "dojo"}, expect=201)
    assert sub["source"] == "manual" and sub["is_current"]
    paid = api.post(f"/subscriptions/{sub['id']}/mark-paid", {"period": "year", "reference": "Fundador"})
    assert paid["is_current"] and paid["reference"] == "Fundador"
    assert api.patch(f"/subscriptions/{sub['id']}", {"status": "canceled"})["status"] == "canceled"
    assert _db().query(OutboxEmail).count() == 0
    # El historial se sigue pudiendo leer (vacío aquí).
    assert owner.get(f"/organizations/{org['id']}/payments") == []
