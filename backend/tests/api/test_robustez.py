"""Errores con formato, identificador de petición, cabeceras, salud e inicio de sesión."""

import json
import logging
import time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.exc import TimeoutError as PoolTimeoutError
from sqlalchemy.orm import Session

import app.main as main_module
from app.config import get_settings
from app.db import base
from app.db.migrate import upgrade_database
from app.db.models import User
from app.domain.errors import DomainError
from app.main import create_app
from app.observability import JsonFormatter
from app.security import hash_password, password_needs_rehash, verify_password
from app.services import login_guard


def _route(api, path, exc):
    def boom():
        raise exc

    api.c.app.add_api_route(path, boom, methods=["GET"])


# --- Errores ---------------------------------------------------------------


def test_paused_database_answers_503_with_retry_after(client):
    _route(client, "/_t/pausa", OperationalError("SELECT 1", {}, Exception("[HYT00] Login timeout expired")))
    r = client.c.get("/_t/pausa", headers={"X-Request-ID": "pausa-1"})
    assert r.status_code == 503
    assert r.headers["retry-after"] == "10"
    err = r.json()["error"]
    assert err["code"] == "DB_WAKING"
    assert err["message"] == "La base de datos está despertando, reintenta en unos segundos"
    assert err["request_id"] == "pausa-1"


def test_other_database_errors_are_json(client):
    _route(client, "/_t/caida", OperationalError("SELECT 1", {}, Exception("disk I/O error")))
    _route(client, "/_t/pool", PoolTimeoutError("QueuePool limit reached"))
    _route(client, "/_t/unico", IntegrityError("INSERT", {}, Exception("UNIQUE constraint failed")))
    r = client.c.get("/_t/caida")
    assert r.status_code == 503 and r.json()["error"]["code"] == "DB_UNAVAILABLE"
    r = client.c.get("/_t/pool")
    assert r.status_code == 503 and r.headers["retry-after"] == "10"
    r = client.c.get("/_t/unico")
    assert r.status_code == 409 and r.json()["error"]["code"] == "CONFLICT"


def test_unexpected_errors_are_500_json_and_logged(client, caplog):
    _route(client, "/_t/bug", RuntimeError("se rompió"))
    _route(client, "/_t/valor", ValueError("bug disfrazado"))
    with caplog.at_level(logging.ERROR):
        r = client.c.get("/_t/bug")
    assert r.status_code == 500
    body = r.json()["error"]
    assert body["code"] == "INTERNAL_ERROR" and "se rompió" not in body["message"]
    assert body["request_id"] == r.headers["x-request-id"]
    rec = next(x for x in caplog.records if x.levelno == logging.ERROR)
    assert rec.exc_info and rec.request_id == body["request_id"]
    # Un ValueError cualquiera ya no se hace pasar por error del usuario.
    assert client.c.get("/_t/valor").status_code == 500


def test_domain_errors_are_400(client):
    _route(client, "/_t/dominio", DomainError("Grado inválido"))
    r = client.c.get("/_t/dominio")
    assert r.status_code == 400 and r.json()["error"] == {
        "code": "INVALID_VALUE",
        "message": "Grado inválido",
        "details": {},
        "request_id": r.headers["x-request-id"],
    }


# --- Identificador de petición y logs --------------------------------------


def test_request_id_is_echoed_or_generated(client, caplog):
    with caplog.at_level(logging.INFO, logger="hajime.access"):
        r = client.c.get("/api/v1/auth/me", headers={"X-Request-ID": "abc-123"})
    assert r.headers["x-request-id"] == "abc-123"
    access = [x for x in caplog.records if x.name == "hajime.access"]
    line = json.loads(JsonFormatter().format(access[-1]))
    assert line["request_id"] == "abc-123"
    assert line["method"] == "GET" and line["path"] == "/api/v1/auth/me" and line["status"] == 200
    assert line["duration_ms"] >= 0
    # Sin cabecera (o con una inválida) se genera uno nuevo.
    gen = client.c.get("/health", headers={"X-Request-ID": "con espacios;y<basura>"}).headers["x-request-id"]
    assert len(gen) == 32 and gen != client.c.get("/health").headers["x-request-id"]
    # Los errores llevan el mismo identificador.
    r = client.raw("GET", "/tournaments/999999", headers={"X-Request-ID": "xyz"})
    assert r.status_code == 404 and r.json()["error"]["request_id"] == "xyz"


# --- Cabeceras de seguridad, documentación y CORS ---------------------------


def test_security_headers(client):
    h = client.c.get("/health").headers
    assert h["x-content-type-options"] == "nosniff"
    assert h["x-frame-options"] == "DENY"
    assert h["referrer-policy"] == "strict-origin-when-cross-origin"
    assert "strict-transport-security" not in h  # dev
    # El overlay para OBS sí se puede incrustar.
    assert "x-frame-options" not in client.c.get("/overlay/token/1").headers


def test_prod_hides_docs_adds_hsts_and_restricts_cors(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "environment", "prod")
    monkeypatch.setattr(s, "cors_origins", None)
    assert s.allowed_cors_origins() == []
    c = TestClient(create_app())  # sin `with`: no corre el arranque (pide secreto JWT en prod)
    assert c.get("/docs").status_code == 404
    assert c.get("/openapi.json").status_code == 404
    h = c.get("/health/live").headers
    assert h["strict-transport-security"].startswith("max-age=")
    pre = {"Origin": "http://localhost:4200", "Access-Control-Request-Method": "GET"}
    assert "access-control-allow-origin" not in c.options("/health", headers=pre).headers
    monkeypatch.setattr(s, "expose_docs", True)
    monkeypatch.setattr(s, "cors_origins", ["https://hajime.example.pe"])
    c = TestClient(create_app())
    assert c.get("/openapi.json").status_code == 200
    pre["Origin"] = "https://hajime.example.pe"
    assert c.options("/health", headers=pre).headers["access-control-allow-origin"] == "https://hajime.example.pe"


def test_dev_keeps_docs_and_local_origins():
    s = get_settings()
    assert s.environment == "dev" and s.docs_enabled()
    assert "http://localhost:4200" in s.allowed_cors_origins()


# --- Salud -------------------------------------------------------------------


def test_health_live_and_ready(client, monkeypatch):
    assert client.c.get("/health/live").json()["status"] == "ok"
    assert client.c.get("/health").json()["status"] == "ok"
    assert client.c.get("/health/ready").json() == {"status": "ok", "database": "ok"}

    def fails():
        raise OperationalError("SELECT 1", {}, Exception("sin conexión"))

    monkeypatch.setattr(main_module, "_ping_database", fails)
    r = client.c.get("/health/ready")
    assert r.status_code == 503 and r.json()["database"] == "unavailable"

    monkeypatch.setattr(main_module, "_ping_database", lambda: time.sleep(1))
    monkeypatch.setattr(main_module, "READY_TIMEOUT_SECONDS", 0.2)
    t0 = time.monotonic()
    r = client.c.get("/health/ready")
    assert r.status_code == 503 and time.monotonic() - t0 < 0.9
    # /health/live no depende de la base.
    assert client.c.get("/health/live").status_code == 200


# --- Contraseñas ---------------------------------------------------------------


def test_old_hashes_still_verify_and_are_rehashed_on_login(client):
    old = hash_password("clave-vieja", iterations=390_000)
    assert verify_password("clave-vieja", old) and password_needs_rehash(old)
    db = next(base.get_session())
    db.add(User(username="vieja", password_hash=old, display_name="Vieja"))
    db.commit()
    r = client.raw("POST", "/auth/login", json={"username": "vieja", "password": "clave-vieja"})
    assert r.status_code == 200
    db.expire_all()
    new = db.scalar(select(User.password_hash).where(User.username == "vieja"))
    assert new != old and new.split("$")[1] == str(get_settings().password_iterations)
    assert not password_needs_rehash(new)
    assert client.raw("POST", "/auth/login", json={"username": "vieja", "password": "clave-vieja"}).status_code == 200
    db.close()


def test_password_cost_is_configurable(monkeypatch):
    monkeypatch.setattr(get_settings(), "password_iterations", 1000)
    h = hash_password("x")
    assert h.split("$")[1] == "1000" and verify_password("x", h) and not verify_password("y", h)
    assert not verify_password("x", "basura") and password_needs_rehash("basura")


# --- Bloqueo de intentos compartido entre procesos ------------------------


@pytest.fixture()
def two_processes(tmp_path):
    """Dos «procesos»: dos engines independientes sobre el mismo archivo SQLite."""
    url = f"sqlite:///{tmp_path / 'intentos.db'}"
    a, b = base.make_engine(url), base.make_engine(url)
    upgrade_database(a)
    yield Session(a), Session(b)
    a.dispose()
    b.dispose()


def test_login_lock_is_shared_between_processes(two_processes):
    s1, s2 = two_processes
    for i in range(login_guard.MAX_FAILURES):
        assert login_guard.login_locked_for(s2 if i % 2 else s1, "ana", "1.2.3.4") == 0
        login_guard.register_login_failure(s1 if i % 2 else s2, "ana", "1.2.3.4")
    # Los fallos se repartieron entre los dos y ambos ven el bloqueo.
    assert 0 < login_guard.login_locked_for(s1, "ana", "1.2.3.4") <= login_guard.LOCK.total_seconds()
    assert login_guard.login_locked_for(s2, "ana", "1.2.3.4") > 0
    # Desde otra IP, el mismo usuario puede entrar.
    assert login_guard.login_locked_for(s2, "ana", "5.6.7.8") == 0


def test_ip_limit_blocks_many_users_from_one_ip(two_processes):
    s1, s2 = two_processes
    for i in range(login_guard.MAX_FAILURES_IP):
        login_guard.register_login_failure(s1 if i % 2 else s2, f"usuario{i}", "9.9.9.9")
    assert login_guard.login_locked_for(s1, "otro", "9.9.9.9") > 0
    # Entrar bien con una cuenta no reinicia el contador de la IP.
    login_guard.clear_login_failures(s2, "otro", "9.9.9.9")
    assert login_guard.login_locked_for(s1, "otro", "9.9.9.9") > 0
    assert login_guard.login_locked_for(s1, "otro", "8.8.8.8") == 0


def test_lock_expires_and_counting_restarts(two_processes, monkeypatch):
    s1, s2 = two_processes
    for _ in range(login_guard.MAX_FAILURES):
        login_guard.register_login_failure(s1, "beto", "1.1.1.1")
    assert login_guard.login_locked_for(s2, "beto", "1.1.1.1") > 0
    real = login_guard.utcnow
    monkeypatch.setattr(login_guard, "utcnow", lambda: real() + login_guard.LOCK + login_guard.WINDOW)
    assert login_guard.login_locked_for(s2, "beto", "1.1.1.1") == 0
    # Un fallo más tras cumplir el bloqueo no vuelve a bloquear: la cuenta empieza de cero.
    login_guard.register_login_failure(s2, "beto", "1.1.1.1")
    assert login_guard.login_locked_for(s1, "beto", "1.1.1.1") == 0


def test_unknown_user_still_pays_the_hash(client, monkeypatch):
    # Sin verificar contra un hash de referencia, un usuario inexistente respondería al
    # instante y delataría qué usuarios existen.
    from app.api.routers import core

    calls = []
    monkeypatch.setattr(core, "burn_password_check", calls.append)
    assert client.raw("POST", "/auth/login", json={"username": "nadie", "password": "x"}).status_code == 401
    assert calls == ["x"]
