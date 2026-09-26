"""Organizaciones, planes y derechos (marcha blanca y enforced)."""

import io
from datetime import UTC, datetime, timedelta

import pytest
from openpyxl import Workbook

from app.config import get_settings
from tests.api.test_mock_tournament import KUMITE, register
from tests.api.test_permissions import login_as


@pytest.fixture()
def enforced(monkeypatch):
    monkeypatch.setattr(get_settings(), "billing_mode", "enforced")


def as_user(api, headers):
    """Mismo cliente, otra sesión: devuelve funciones get/post/patch/delete con esa cabecera."""

    class U:
        def raw(self, method, path, **kw):
            return api.raw(method, path, headers=headers, **kw)

        def get(self, path, expect=200):
            r = self.raw("GET", path)
            assert r.status_code == expect, r.text
            return r.json()

        def post(self, path, json=None, expect=200):
            r = self.raw("POST", path, json=json)
            assert r.status_code == expect, r.text
            return r.json() if r.content else None

        def patch(self, path, json=None, expect=200):
            r = self.raw("PATCH", path, json=json)
            assert r.status_code == expect, r.text
            return r.json()

    return U()


def org_with_owner(api, name, username):
    hdr = login_as(api, username)
    owner_id = api.raw("GET", "/auth/me", headers=hdr).json()["id"]
    org = api.post("/organizations", {"name": name, "kind": "league", "owner_user_id": owner_id}, expect=201)
    return org, as_user(api, hdr), owner_id


def new_tournament(u, org_id, **kw):
    body = {"name": "Copa de la liga", "start_date": "2026-11-20", "organization_id": org_id, **kw}
    return u.post("/tournaments", body, expect=201)


def test_migration_org_principal_y_creacion_por_defecto(client):
    api = client
    # El Admin sin organización propia crea en la organización principal.
    t = api.post("/tournaments", {"name": "Torneo", "start_date": "2026-10-17"}, expect=201)
    assert t["organization_name"] == "Organización principal"
    orgs = api.get("/organizations")
    assert [o["slug"] for o in orgs] == ["principal"] and orgs[0]["tournament_count"] == 1


def test_permisos_por_organizacion(client):
    api = client
    org_a, owner_a, _ = org_with_owner(api, "Liga de Lima", "duena_a")
    org_b, owner_b, _ = org_with_owner(api, "Liga del Callao", "duena_b")
    assert org_a["slug"] == "liga-de-lima"
    me = owner_a.get("/auth/me")
    assert me["organizations"] == [{"id": org_a["id"], "name": "Liga de Lima", "slug": "liga-de-lima", "role": "owner"}]
    assert me["can_view_documents"] is True  # owner/admin = organizador

    t = new_tournament(owner_a, org_a["id"])
    assert t["organization_id"] == org_a["id"] and t["organization_name"] == "Liga de Lima"
    # No crea torneos en una organización ajena.
    r = owner_a.raw(
        "POST", "/tournaments", json={"name": "X torneo", "start_date": "2026-11-20", "organization_id": org_b["id"]}
    )
    assert r.status_code == 403
    # La otra organización no lo ve ni lo edita; la lista filtra.
    assert owner_b.raw("GET", f"/tournaments/{t['id']}").status_code == 403
    assert (
        owner_b.raw("PATCH", f"/tournaments/{t['id']}", json={"version": t["version"], "name": "X"}).status_code == 403
    )
    assert [x["id"] for x in owner_a.get("/tournaments")] == [t["id"]]
    assert owner_b.get("/tournaments") == []
    assert owner_a.get(f"/tournaments?organization_id={org_a['id']}")[0]["id"] == t["id"]

    # Owner/admin administra todos los torneos de la organización: categorías, estado…
    owner_a.post(f"/tournaments/{t['id']}/categories", KUMITE, expect=201)
    owner_a.patch(f"/tournaments/{t['id']}/status", {"status": "registration_open", "version": t["version"]})

    # Miembros: invitar por usuario existente, cambiar rol, quitar.
    login_as(api, "lector")
    members = owner_a.post(
        f"/organizations/{org_a['id']}/members", {"username": "lector", "role": "member"}, expect=201
    )
    assert {m["username"]: m["role"] for m in members} == {"duena_a": "owner", "lector": "member"}
    tok = api.raw("POST", "/auth/login", json={"username": "lector", "password": "secret123"}).json()["access_token"]
    lector = as_user(api, {"Authorization": f"Bearer {tok}"})
    # member lee pero no administra
    assert lector.get(f"/tournaments/{t['id']}")["id"] == t["id"]
    assert lector.raw("POST", f"/tournaments/{t['id']}/categories", json={**KUMITE, "code": "OTRA"}).status_code == 403
    assert lector.raw("PATCH", f"/organizations/{org_a['id']}", json={"version": 1, "name": "Hack"}).status_code == 403
    # admin de la organización administra, pero no nombra dueños
    owner_a.patch(f"/organizations/{org_a['id']}/members/{lector.get('/auth/me')['id']}", {"role": "admin"})
    lector_id = lector.get("/auth/me")["id"]
    assert lector.raw("POST", f"/tournaments/{t['id']}/categories", json={**KUMITE, "code": "OTRA"}).status_code == 201
    r = lector.raw("PATCH", f"/organizations/{org_a['id']}/members/{lector_id}", json={"role": "owner"})
    assert r.status_code == 403
    upd = lector.patch(f"/organizations/{org_a['id']}", {"version": org_a["version"], "name": "Liga Metropolitana"})
    assert upd["name"] == "Liga Metropolitana" and upd["my_role"] == "admin"
    # La dueña única no se puede quitar
    owner_id = owner_a.get("/auth/me")["id"]
    r = owner_a.raw("DELETE", f"/organizations/{org_a['id']}/members/{owner_id}")
    assert r.status_code == 409
    after = owner_a.raw("DELETE", f"/organizations/{org_a['id']}/members/{lector_id}").json()
    assert [m["username"] for m in after] == ["duena_a"]
    assert lector.raw("GET", f"/tournaments/{t['id']}").status_code == 403
    # Solo el Admin Global crea organizaciones
    assert owner_a.raw("POST", "/organizations", json={"name": "Nueva"}).status_code == 403


def test_rol_organizador_con_ambito_de_organizacion(client):
    api = client
    org, owner, _ = org_with_owner(api, "Liga Norte", "duena_n")
    t = new_tournament(owner, org["id"])
    d = api.dojo("Norte")
    p = api.person("Orga", "Liga", d["id"])
    hdr = login_as(api, "org_liga", person_id=p["id"])
    api.post(
        f"/persons/{p['id']}/roles",
        {"role": "organizer", "scope_type": "organization", "scope_id": org["id"]},
        expect=201,
    )
    u = as_user(api, hdr)
    assert u.get(f"/tournaments/{t['id']}")["id"] == t["id"]
    t2 = new_tournament(u, org["id"])  # también crea torneos en esa organización
    assert {x["id"] for x in u.get("/tournaments")} == {t["id"], t2["id"]}
    # Rol de organización inexistente: 404; rol sin ámbito de organización: 409
    r = api.raw(
        "POST",
        f"/persons/{p['id']}/roles",
        json={"role": "sensei", "scope_type": "organization", "scope_id": org["id"]},
    )
    assert r.status_code == 409
    r = api.raw(
        "POST", f"/persons/{p['id']}/roles", json={"role": "organizer", "scope_type": "organization", "scope_id": 999}
    )
    assert r.status_code == 404


def test_marcha_blanca_permite_todo(client):
    api = client
    assert api.get("/plans")["mode"] == "marcha_blanca"
    org, owner, _ = org_with_owner(api, "Dojo Kaze", "sensei_kaze")
    assert set(owner.get(f"/organizations/{org['id']}")["features"]) >= {"organize_tournaments", "multi_tatami"}
    t = new_tournament(owner, org["id"], tatami_count=2)
    owner.post(f"/tournaments/{t['id']}/tatamis", {"name": "Tatami 3"}, expect=201)
    owner.raw("PUT", f"/tournaments/{t['id']}/self-registration", json={"open": True})
    r = owner.raw("PUT", f"/tournaments/{t['id']}/public", json={"enabled": True})
    token = r.json()["public_token"]
    anon = api.c.__class__(api.c.app)
    assert anon.get(f"/api/v1/public/{token}/tatamis/{t['tatamis'][0]['id']}").status_code == 200


def _xlsx() -> bytes:
    wb = Workbook()
    wb.active.append(["Dojo", "Nombres"])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def test_enforced_402_y_suscripcion_manual(client, enforced):
    api = client
    org, owner, _ = org_with_owner(api, "Liga Sur", "duena_s")
    body = {"name": "Copa Sur", "start_date": "2026-11-20", "organization_id": org["id"]}
    r = owner.raw("POST", "/tournaments", json=body)
    assert r.status_code == 402
    err = r.json()["error"]
    assert err["code"] == "PLAN_REQUIRED"
    assert err["details"]["feature"] == "organize_tournaments" and err["details"]["plan"] == "dojo"
    assert owner.get(f"/organizations/{org['id']}")["features"] == []

    # Solo el Admin asigna suscripciones manuales.
    sub_body = {"organization_id": org["id"], "plan_code": "dojo", "status": "active"}
    assert owner.raw("POST", "/subscriptions", json=sub_body).status_code == 403
    sub = api.post("/subscriptions", sub_body, expect=201)
    assert sub["is_current"] and sub["plan_name"] == "Dojo" and sub["source"] == "manual"
    info = owner.get(f"/organizations/{org['id']}")
    assert info["subscription"]["plan_code"] == "dojo" and "multi_tatami" in info["features"]
    t = owner.post("/tournaments", {**body, "tatami_count": 2}, expect=201)

    # Suscripción vencida: todo lo de pago vuelve a pedir plan.
    past = (datetime.now(UTC) - timedelta(days=1)).isoformat()
    api.patch(f"/subscriptions/{sub['id']}", {"current_period_end": past})
    r = owner.raw("POST", f"/tournaments/{t['id']}/tatamis", json={"name": "Tatami 3"})
    assert r.status_code == 402 and r.json()["error"]["details"]["feature"] == "multi_tatami"
    r = owner.raw("PUT", f"/tournaments/{t['id']}/self-registration", json={"open": True})
    assert r.status_code == 402 and r.json()["error"]["details"]["feature"] == "dojo_self_registration"
    r = owner.raw(
        "POST",
        f"/tournaments/{t['id']}/imports",
        files={"file": ("l.xlsx", _xlsx(), "application/octet-stream")},
    )
    assert r.status_code == 402 and r.json()["error"]["details"]["feature"] == "excel_import"
    token = owner.raw("PUT", f"/tournaments/{t['id']}/public", json={"enabled": True}).json()["public_token"]
    anon = api.c.__class__(api.c.app)
    r = anon.get(f"/api/v1/public/{token}/tatamis/{t['tatamis'][0]['id']}")
    assert r.status_code == 402 and r.json()["error"]["details"]["feature"] == "live_overlay"
    assert anon.get(f"/api/v1/public/{token}").status_code == 200  # el vivo básico es gratis

    # Shadow Mode (resultado oficial del papel)
    c = owner.post(f"/tournaments/{t['id']}/categories", KUMITE, expect=201)
    ver = owner.get(f"/tournaments/{t['id']}")["version"]
    owner.patch(f"/tournaments/{t['id']}/status", {"status": "registration_open", "version": ver})
    d = api.dojo("Sur")
    for i in range(2):
        p = api.person(f"S{i}", f"Sur{i}", d["id"])
        register(api, t["id"], p["id"], c["id"], weight_class="-45")
    m = api.post(f"/categories/{c['id']}/bracket", {"seed": 1})["matches"][0]
    r = owner.raw("POST", f"/matches/{m['id']}/official-result", json={"official_winner_registration_id": None})
    assert r.status_code == 402 and r.json()["error"]["details"]["feature"] == "shadow_mode"

    # El Admin marca pagado (proveedor manual): vuelve a estar vigente un año.
    paid = api.post(f"/subscriptions/{sub['id']}/mark-paid", {"period": "year", "reference": "YAPE-001"})
    assert paid["is_current"] and paid["reference"] == "YAPE-001"
    owner.post(f"/tournaments/{t['id']}/tatamis", {"name": "Tatami 3"}, expect=201)
    # El Admin Global nunca se bloquea.
    api.post("/tournaments", {**body, "name": "Copa del Admin"}, expect=201)


def test_planes_checkout_y_webhook(client, enforced):
    api = client
    plans = api.get("/plans")
    assert plans["mode"] == "enforced"
    by = {p["code"]: p for p in plans["plans"]}
    assert set(by) == {"marcha_blanca", "publico", "competidor", "competidor_plus", "dojo", "organizador"}
    assert by["dojo"]["price_pen_month"] == 69 and by["organizador"]["price_pen_year"] == 1490
    assert by["competidor_plus"]["price_pen_month"] == 9.9
    # Precios como configuración (solo el Admin)
    assert api.patch("/plans/dojo", {"price_pen_month": 79})["price_pen_month"] == 79

    org, owner, _ = org_with_owner(api, "Club Pago", "duena_p")
    co = owner.post(f"/organizations/{org['id']}/checkout", {"plan_code": "organizador", "period": "year"})
    assert co["provider"] == "manual" and co["url"] is None and co["instructions"]
    subs = owner.get(f"/organizations/{org['id']}/subscriptions")
    assert subs[0]["status"] == "past_due" and not subs[0]["is_current"]
    assert owner.raw("POST", "/tournaments", json={"name": "Copa P", "start_date": "2026-11-20"}).status_code == 402
    api.post(f"/subscriptions/{co['subscription_id']}/mark-paid", {"period": "year"})
    owner.post("/tournaments", {"name": "Copa P", "start_date": "2026-11-20"}, expect=201)
    assert api.raw("POST", "/payments/webhook/manual", content=b"{}").status_code == 400

    # Competidor Plus: por persona
    from app.db import base
    from app.db.models import Person
    from app.services import entitlements

    d = api.dojo("Plus")
    p = api.person("Ana", "Plus", d["id"], sex="F")
    db = next(base.get_session())
    person = db.get(Person, p["id"])
    assert not entitlements.has(db, person, "plus_insights")
    r = api.raw("POST", "/subscriptions", json={"person_id": p["id"], "plan_code": "dojo"})
    assert r.status_code == 409  # plan de organización para una persona
    api.post("/subscriptions", {"person_id": p["id"], "plan_code": "competidor_plus"}, expect=201)
    assert entitlements.has(db, person, "plus_insights")
    assert not entitlements.has(db, person, "organize_tournaments")
    db.close()
