"""Cuentas: cambio de contraseña, administración de usuarios y límite de intentos."""

from app import security


def login(api, username, password):
    return api.raw("POST", "/auth/login", json={"username": username, "password": password})


def test_change_password_invalidates_old_sessions(client):
    api = client
    api.post("/users", {"username": "ana", "password": "inicial123"}, expect=201)
    r = login(api, "ana", "inicial123")
    old = {"Authorization": f"Bearer {r.json()['access_token']}"}
    assert r.json()["user"]["must_change_password"] is True
    bad = api.raw(
        "POST", "/auth/change-password", json={"current_password": "x", "new_password": "nueva12345"}, headers=old
    )
    assert bad.status_code == 401
    ok = api.raw(
        "POST",
        "/auth/change-password",
        json={"current_password": "inicial123", "new_password": "nueva12345"},
        headers=old,
    )
    assert ok.status_code == 200 and ok.json()["user"]["must_change_password"] is False
    new = {"Authorization": f"Bearer {ok.json()['access_token']}"}
    assert api.raw("GET", "/auth/me", headers=old).status_code == 401
    assert api.raw("GET", "/auth/me", headers=new).status_code == 200
    assert login(api, "ana", "inicial123").status_code == 401
    assert login(api, "ana", "nueva12345").status_code == 200


def test_admin_deactivates_and_resets(client):
    api = client
    u = api.post("/users", {"username": "beto", "password": "inicial123"}, expect=201)
    tok = login(api, "beto", "inicial123").json()["access_token"]
    hdr = {"Authorization": f"Bearer {tok}"}
    api.patch(f"/users/{u['id']}", {"is_active": False})
    assert api.raw("GET", "/auth/me", headers=hdr).status_code == 401
    assert login(api, "beto", "inicial123").status_code == 401
    out = api.patch(f"/users/{u['id']}", {"is_active": True, "reset_password": "reseteada123"})
    assert out["must_change_password"] is True
    assert login(api, "beto", "reseteada123").status_code == 200
    me = api.get("/auth/me")
    r = api.raw("PATCH", f"/users/{me['id']}", json={"is_active": False})
    assert r.status_code == 409


def test_login_throttle(client, monkeypatch):
    api = client
    api.post("/users", {"username": "carla", "password": "inicial123"}, expect=201)
    for _ in range(security.MAX_FAILURES):
        assert login(api, "carla", "mala").status_code == 401
    r = login(api, "carla", "inicial123")
    assert r.status_code == 429 and r.json()["error"]["code"] == "TOO_MANY_ATTEMPTS"
    # Pasado el bloqueo, vuelve a permitir
    real = security.time.monotonic
    monkeypatch.setattr(security.time, "monotonic", lambda: real() + security.LOCK_SECONDS + 1)
    assert login(api, "carla", "inicial123").status_code == 200


def test_changing_age_reference_recomputes_ages(client):
    from tests.api.test_mock_tournament import KUMITE, register, setup_tournament

    api = client
    d = api.dojo("Edad")
    t = setup_tournament(api)
    c = api.post(f"/tournaments/{t['id']}/categories", KUMITE, expect=201)
    p = api.person("Luis", "Rojas", d["id"], birth="2013-12-15")
    reg = register(api, t["id"], p["id"], c["id"], weight_class="-45")
    assert reg["age_at_reference"] == 12  # al 17/10/2026
    t = api.get(f"/tournaments/{t['id']}")
    api.patch(f"/tournaments/{t['id']}", {"version": t["version"], "age_reference_date": "2026-12-31"})
    regs = api.get(f"/tournaments/{t['id']}/registrations")
    assert regs[0]["age_at_reference"] == 13
