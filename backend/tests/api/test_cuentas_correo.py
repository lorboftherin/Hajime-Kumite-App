"""Correo en las cuentas: recuperar la contraseña, verificar el correo y registro abierto."""

import re
from datetime import timedelta

import pytest

from app.config import get_settings
from app.db import base
from app.db.models import OutboxEmail, PasswordReset, User
from app.services import accounts, mail
from tests.api.test_permissions import login_as


def _db():
    return next(base.get_session())


@pytest.fixture(autouse=True)
def _limpiar_correo():
    mail.CONSOLE_OUTBOX.clear()
    yield
    mail.CONSOLE_OUTBOX.clear()


def enviados(to=None):
    """Despacha la bandeja de salida con el proveedor de consola y devuelve lo enviado."""
    mail.drain(base.session_factory())
    return [m for m in mail.CONSOLE_OUTBOX if to is None or m.to == to]


def token_de(msg) -> str:
    m = re.search(r"#([A-Za-z0-9_-]{20,})", msg.text)
    assert m, msg.text
    return m.group(1)


def con_correo(api, username, email, password="secret123"):
    """Cuenta creada por el Admin con correo (sin verificar)."""
    hdr = login_as(api, username, password)
    uid = api.get("/auth/me", headers=hdr)["id"]
    api.patch(f"/users/{uid}", {"email": email})
    return uid, hdr


def test_forgot_password_does_not_reveal_accounts(client):
    api = client
    con_correo(api, "rosa", "rosa@example.com")
    enviados()  # descarta la verificación
    mail.CONSOLE_OUTBOX.clear()
    known = api.raw("POST", "/auth/forgot-password", json={"email": "Rosa@Example.com "})
    unknown = api.raw("POST", "/auth/forgot-password", json={"email": "nadie@example.com"})
    assert known.status_code == unknown.status_code == 202
    assert known.json() == unknown.json()
    out = enviados()
    assert [m.to for m in out] == ["rosa@example.com"]
    assert "/restablecer-clave#" in out[0].text and "<html" in out[0].html
    # El token no se guarda en claro.
    tok = token_de(out[0])
    db = _db()
    assert all(r.token_hash != tok for r in db.query(PasswordReset).all())


def test_reset_password_single_use_and_revokes_sessions(client):
    api = client
    _, old = con_correo(api, "hugo", "hugo@example.com")
    api.post("/auth/forgot-password", {"email": "hugo@example.com"}, expect=202)
    tok = token_de(enviados("hugo@example.com")[-1])
    assert api.raw("GET", "/auth/me", headers=old).status_code == 200
    api.post("/auth/reset-password", {"token": tok, "new_password": "nueva-clave-1"}, expect=204)
    # Todas las sesiones anteriores quedan cerradas.
    assert api.raw("GET", "/auth/me", headers=old).status_code == 401
    # Un solo uso.
    r = api.raw("POST", "/auth/reset-password", json={"token": tok, "new_password": "otra-clave-2"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "INVALID_TOKEN"
    ok = api.raw("POST", "/auth/login", json={"username": "hugo", "password": "nueva-clave-1"})
    assert ok.status_code == 200
    # También se puede entrar con el correo.
    assert api.raw("POST", "/auth/login", json={"username": "HUGO@example.com", "password": "nueva-clave-1"}).is_success
    # Aviso de que la contraseña cambió.
    assert any("cambió" in m.subject for m in enviados("hugo@example.com"))


def test_reset_token_expires_and_new_request_invalidates_old(client):
    api = client
    con_correo(api, "ines", "ines@example.com")
    api.post("/auth/forgot-password", {"email": "ines@example.com"}, expect=202)
    first = token_de(enviados("ines@example.com")[-1])
    api.post("/auth/forgot-password", {"email": "ines@example.com"}, expect=202)
    second = token_de(enviados("ines@example.com")[-1])
    r = api.raw("POST", "/auth/reset-password", json={"token": first, "new_password": "nueva-clave-1"})
    assert r.status_code == 400
    db = _db()
    for row in db.query(PasswordReset).all():
        row.expires_at = row.expires_at - timedelta(hours=2)
    db.commit()
    r = api.raw("POST", "/auth/reset-password", json={"token": second, "new_password": "nueva-clave-1"})
    assert r.status_code == 400


def test_forgot_password_limits(client):
    api = client
    con_correo(api, "lalo", "lalo@example.com")
    enviados()
    mail.CONSOLE_OUTBOX.clear()
    for _ in range(accounts.FORGOT_PER_EMAIL + 2):
        api.post("/auth/forgot-password", {"email": "lalo@example.com"}, expect=202)
    # Por correo: la respuesta no cambia, pero no se envían más de N.
    assert len(enviados("lalo@example.com")) == accounts.FORGOT_PER_EMAIL
    # Por IP: 429 al pasar el límite.
    codes = [
        api.raw("POST", "/auth/forgot-password", json={"email": f"x{i}@example.com"}).status_code
        for i in range(accounts.FORGOT_PER_IP)
    ]
    assert codes[-1] == 429


def test_email_verification_flow(client):
    api = client
    uid, hdr = con_correo(api, "maria", "maria@example.com")
    me = api.get("/auth/me", headers=hdr)
    assert me["email"] == "maria@example.com" and me["email_verified_at"] is None
    tok = token_de(enviados("maria@example.com")[-1])
    api.post("/auth/verify-email", {"token": tok})
    assert api.get("/auth/me", headers=hdr)["email_verified_at"] is not None
    assert api.raw("POST", "/auth/verify-email", json={"token": tok}).status_code == 400
    # Cambiar el correo pide la contraseña y lo deja sin verificar.
    r = api.raw("PATCH", "/auth/me", json={"email": "maria2@example.com"}, headers=hdr)
    assert r.status_code == 401
    me = api.c.patch(
        "/api/v1/auth/me", json={"email": "maria2@example.com", "current_password": "secret123"}, headers=hdr
    ).json()
    assert me["email"] == "maria2@example.com" and me["email_verified_at"] is None
    tok2 = token_de(enviados("maria2@example.com")[-1])
    api.post("/auth/verify-email", {"token": tok2})
    # Correo repetido en otra cuenta: rechazado.
    other = login_as(api, "otra")
    other_id = api.get("/auth/me", headers=other)["id"]
    r = api.raw("PATCH", f"/users/{other_id}", json={"email": "MARIA2@example.com"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "EMAIL_TAKEN"
    r = api.raw("POST", "/auth/verify-email/resend", headers=hdr)
    assert r.status_code == 409  # ya verificado
    assert uid


def test_signup_closed_by_default_and_open(client, monkeypatch):
    api = client
    body = {"email": "Nueva@Example.com", "password": "clave-segura-1", "display_name": "Nueva Persona"}
    r = api.raw("POST", "/auth/signup", json=body)
    assert r.status_code == 403 and r.json()["error"]["code"] == "SIGNUP_CLOSED"
    assert api.get("/auth/options") == {"open_signup": False}
    monkeypatch.setattr(get_settings(), "open_signup", True)
    first = api.raw("POST", "/auth/signup", json=body)
    again = api.raw("POST", "/auth/signup", json={**body, "password": "otra-clave-9"})
    assert first.status_code == again.status_code == 202 and first.json() == again.json()
    out = enviados("nueva@example.com")
    assert [("Confirma" in m.subject, "Ya tienes" in m.subject) for m in out] == [(True, False), (False, True)]
    db = _db()
    u = db.query(User).filter(User.email == "nueva@example.com").one()
    assert not u.is_admin and u.person_id is None and u.email_verified_at is None
    # Entra con el correo y la primera contraseña (el segundo registro no la cambió).
    tok = api.raw("POST", "/auth/login", json={"username": "nueva@example.com", "password": "clave-segura-1"})
    assert tok.status_code == 200 and tok.json()["user"]["roles"] == []
    bad = api.raw("POST", "/auth/signup", json={**body, "email": "no-es-correo"})
    assert bad.status_code == 422


def test_outbox_retries_with_backoff_then_fails(client, monkeypatch):
    calls = []

    class Caido:
        name = "caido"

        def send(self, msg):
            calls.append(msg.to)
            raise mail.MailError("servidor ocupado")

    monkeypatch.setattr(mail, "get_provider", lambda s=None: Caido())
    monkeypatch.setattr(get_settings(), "mail_max_attempts", 2)
    db = _db()
    row = mail.enqueue(db, "a@example.com", mail.render("Hola", "Hola", ["x"]), kind="prueba")
    db.commit()
    factory = base.session_factory()
    assert mail.dispatch_once(factory) == 0
    db.refresh(row)
    assert (row.status, row.attempts, row.last_error) == ("pending", 1, "servidor ocupado")
    assert row.next_attempt_at > base.utcnow() + timedelta(seconds=20)
    # Antes de la espera no se reintenta.
    assert mail.dispatch_once(factory) == 0 and len(calls) == 1
    row.next_attempt_at = base.utcnow() - timedelta(seconds=1)
    db.commit()
    mail.dispatch_once(factory)
    db.refresh(row)
    assert (row.status, row.attempts) == ("failed", 2) and len(calls) == 2
    # Un error permanente no se reintenta.
    monkeypatch.setattr(mail, "get_provider", lambda s=None: _Permanente())
    row2 = mail.enqueue(db, "b@example.com", mail.render("Hola", "Hola", ["x"]))
    db.commit()
    mail.dispatch_once(factory)
    db.refresh(row2)
    assert (row2.status, row2.attempts) == ("failed", 1)


class _Permanente:
    name = "permanente"

    def send(self, msg):
        raise mail.MailError("destinatario inválido", permanent=True)


def test_outbox_lease_prevents_double_send(client):
    db = _db()
    row = mail.enqueue(db, "c@example.com", mail.render("Hola", "Hola", ["x"]))
    db.commit()
    other = _db()
    assert mail.claim(db, row.id, lease_seconds=120) is True
    # Otro proceso no puede tomarlo mientras dura la reserva.
    assert mail.claim(other, row.id, lease_seconds=120) is False
    assert mail.dispatch_once(base.session_factory()) == 0 and mail.CONSOLE_OUTBOX == []
    # Si el primero murió, al vencer la reserva otro lo retoma y lo envía una sola vez.
    db.refresh(row)
    row.locked_until = base.utcnow() - timedelta(seconds=1)
    db.commit()
    assert mail.dispatch_once(base.session_factory()) == 1
    assert mail.dispatch_once(base.session_factory()) == 0
    assert [m.to for m in mail.CONSOLE_OUTBOX] == ["c@example.com"]
    db.refresh(row)
    assert row.status == "sent" and row.sent_at is not None and row.attempts == 2
    assert _db().query(OutboxEmail).filter(OutboxEmail.status == "sent").count() == 1


def test_smtp_provider_uses_starttls(monkeypatch):
    sent = {}

    class FakeSMTP:
        def __init__(self, host, port, timeout):
            sent["addr"] = (host, port)

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def ehlo(self):
            pass

        def starttls(self, context):
            sent["tls"] = True

        def login(self, user, password):
            sent["login"] = user

        def send_message(self, em):
            sent["msg"] = em

    monkeypatch.setattr(mail.smtplib, "SMTP", FakeSMTP)
    s = get_settings().model_copy(
        update={
            "mail_provider": "smtp",
            "smtp_host": "smtp.example.com",
            "smtp_user": "usuario",
            "smtp_password": "no-es-real",
            "smtp_from": "Hajime <hola@example.com>",
        }
    )
    provider = mail.get_provider(s)
    provider.send(mail.MailMessage("d@example.com", "Asunto", "<p>hola</p>", "hola"))
    assert sent["addr"] == ("smtp.example.com", 587) and sent["tls"] and sent["login"] == "usuario"
    em = sent["msg"]
    assert em["To"] == "d@example.com" and em.is_multipart()
    assert {p.get_content_type() for p in em.iter_parts()} == {"text/plain", "text/html"}


def test_acs_signature_is_deterministic():
    import base64

    key = base64.b64encode(b"clave-de-prueba-no-real").decode()
    h1 = mail.acs_signed_headers(
        "POST", "https://x.communication.azure.com/emails:send?api-version=1", b"{}", key, "Sat, 26 Sep 2026"
    )
    h2 = mail.acs_signed_headers(
        "POST", "https://x.communication.azure.com/emails:send?api-version=1", b"{}", key, "Sat, 26 Sep 2026"
    )
    assert h1 == h2
    assert h1["Authorization"].startswith("HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=")
    assert h1["x-ms-content-sha256"] == "RBNvo1WzZ4oRRq0W9+hknpT7T8If536DEMBg9hyq/4o="


def test_dispatcher_thread_sends_in_background(tmp_path):
    import time

    from sqlalchemy.orm import sessionmaker

    from app.db.base import Base, make_engine

    engine = make_engine(f"sqlite:///{tmp_path / 'd.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with factory() as db:
        mail.enqueue(db, "fondo@example.com", mail.render("Hola", "Hola", ["x"]))
        db.commit()
    d = mail.MailDispatcher(factory, get_settings().model_copy(update={"mail_poll_seconds": 0.05}))
    d.start()
    try:
        for _ in range(100):
            if mail.CONSOLE_OUTBOX:
                break
            time.sleep(0.05)
    finally:
        d.stop()
    assert [m.to for m in mail.CONSOLE_OUTBOX] == ["fondo@example.com"]
    engine.dispose()
