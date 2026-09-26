"""Sesiones: token de acceso corto, renovación rotada, cierre y rotación del secreto."""

from datetime import timedelta

import jwt

from app.config import get_settings
from app.db import base
from app.db.models import UserSession
from app.security import create_token, decode_token, key_id


def login(api, username="admin", password="secret123"):
    r = api.raw("POST", "/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return r.json()


def bearer(tok):
    return {"Authorization": f"Bearer {tok}"}


def test_login_returns_short_access_and_refresh_token(client):
    api = client
    out = login(api)
    assert out["refresh_token"] and out["expires_in"] == get_settings().access_token_minutes * 60
    payload = jwt.decode(out["access_token"], options={"verify_signature": False})
    assert payload["exp"] - payload["iat"] == get_settings().access_token_minutes * 60
    assert payload["sid"]
    assert jwt.get_unverified_header(out["access_token"])["kid"] == key_id(get_settings().jwt_secret)


def test_refresh_rotates_and_detects_reuse(client):
    api = client
    first = login(api)
    r = api.raw("POST", "/auth/refresh", json={"refresh_token": first["refresh_token"]})
    assert r.status_code == 200
    second = r.json()
    assert second["refresh_token"] != first["refresh_token"]
    assert api.raw("GET", "/auth/me", headers=bearer(second["access_token"])).status_code == 200
    # Reusar el anterior justo después (otra pestaña) se rechaza sin castigo.
    r = api.raw("POST", "/auth/refresh", json={"refresh_token": first["refresh_token"]})
    assert r.status_code == 401 and r.json()["error"]["code"] == "REFRESH_RACE"
    assert api.raw("GET", "/auth/me", headers=bearer(second["access_token"])).status_code == 200
    # Fuera del margen, reusarlo es señal de robo: se cierran todas las sesiones.
    db = next(base.get_session())
    sess = db.get(UserSession, decode_token(second["access_token"]).session_id)
    sess.rotated_at = sess.rotated_at - timedelta(minutes=5)
    db.commit()
    db.close()
    r = api.raw("POST", "/auth/refresh", json={"refresh_token": first["refresh_token"]})
    assert r.status_code == 401 and r.json()["error"]["code"] == "UNAUTHORIZED"
    assert api.raw("GET", "/auth/me", headers=bearer(second["access_token"])).status_code == 401
    r = api.raw("POST", "/auth/refresh", json={"refresh_token": second["refresh_token"]})
    assert r.status_code == 401
    assert api.raw("POST", "/auth/refresh", json={"refresh_token": "x" * 40}).status_code == 401


def test_logout_and_session_list(client):
    api = client
    a = login(api)
    b = login(api)
    own = api.raw("GET", "/auth/sessions", headers=bearer(a["access_token"])).json()
    assert len(own) >= 2 and sum(1 for s in own if s["current"]) == 1
    # Cerrar otra sesión propia corta su token de acceso al instante.
    sid_b = decode_token(b["access_token"]).session_id
    assert api.raw("DELETE", f"/auth/sessions/{sid_b}", headers=bearer(a["access_token"])).status_code == 204
    assert api.raw("GET", "/auth/me", headers=bearer(b["access_token"])).status_code == 401
    assert api.raw("POST", "/auth/refresh", json={"refresh_token": b["refresh_token"]}).status_code == 401
    # Cerrar sesión con el token de renovación (el de acceso pudo haber vencido).
    r = api.raw("POST", "/auth/logout", json={"refresh_token": a["refresh_token"]}, headers={"Authorization": ""})
    assert r.status_code == 204
    assert api.raw("GET", "/auth/me", headers=bearer(a["access_token"])).status_code == 401
    # No se cierran sesiones ajenas.
    api.post("/users", {"username": "ajeno", "password": "secret123"}, expect=201)
    other = login(api, "ajeno")
    sid_other = decode_token(other["access_token"]).session_id
    c = login(api)
    assert api.raw("DELETE", f"/auth/sessions/{sid_other}", headers=bearer(c["access_token"])).status_code == 404


def test_admin_closes_all_sessions_and_password_change_revokes(client):
    api = client
    u = api.post("/users", {"username": "tablet", "password": "secret123"}, expect=201)
    s1, s2 = login(api, "tablet"), login(api, "tablet")
    api.raw("DELETE", f"/users/{u['id']}/sessions").raise_for_status()
    for s in (s1, s2):
        assert api.raw("GET", "/auth/me", headers=bearer(s["access_token"])).status_code == 401
        assert api.raw("POST", "/auth/refresh", json={"refresh_token": s["refresh_token"]}).status_code == 401
    # Cambiar la contraseña cierra las demás sesiones y abre una nueva.
    s3, s4 = login(api, "tablet"), login(api, "tablet")
    r = api.raw(
        "POST",
        "/auth/change-password",
        json={"current_password": "secret123", "new_password": "otra-clave-9"},
        headers=bearer(s3["access_token"]),
    )
    new = r.json()
    assert r.status_code == 200 and new["refresh_token"]
    assert api.raw("POST", "/auth/refresh", json={"refresh_token": s4["refresh_token"]}).status_code == 401
    assert api.raw("GET", "/auth/me", headers=bearer(new["access_token"])).status_code == 200
    # Desactivar la cuenta también impide renovar.
    api.patch(f"/users/{u['id']}", {"is_active": False})
    assert api.raw("POST", "/auth/refresh", json={"refresh_token": new["refresh_token"]}).status_code == 401


def test_jwt_secret_rotation_keeps_sessions(client):
    api = client
    s = get_settings()
    old_secret, old_prev = s.jwt_secret, s.jwt_previous_secret
    token = login(api)["access_token"]
    legacy = jwt.encode({"sub": "1", "tv": 0, "exp": 9999999999}, old_secret, algorithm="HS256")  # sin kid ni sid
    try:
        s.jwt_secret, s.jwt_previous_secret = "nuevo-secreto-" + "x" * 40, old_secret
        assert api.raw("GET", "/auth/me", headers=bearer(token)).status_code == 200
        assert api.raw("GET", "/auth/me", headers=bearer(legacy)).status_code == 200
        fresh = create_token(1, 0)
        assert jwt.get_unverified_header(fresh)["kid"] == key_id(s.jwt_secret)
        # Sin el secreto anterior, los tokens viejos dejan de valer.
        s.jwt_previous_secret = None
        assert api.raw("GET", "/auth/me", headers=bearer(token)).status_code == 401
        assert decode_token(fresh) is not None
    finally:
        s.jwt_secret, s.jwt_previous_secret = old_secret, old_prev
