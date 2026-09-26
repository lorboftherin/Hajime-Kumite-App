"""Cuentas de competidor: reclamo de perfiles (adulto y menor), tutela, consentimiento y perfil público."""

import itertools
import json
import re

import pytest

from app.config import get_settings
from app.db import base
from app.db.models import DataConsent, Guardianship, Person, Tournament, User
from app.services import mail
from tests.api.test_mock_tournament import KUMITE, register, setup_tournament
from tests.api.test_stats import play


def _db():
    return next(base.get_session())


@pytest.fixture(autouse=True)
def _abierto(monkeypatch):
    monkeypatch.setattr(get_settings(), "open_signup", True)
    mail.CONSOLE_OUTBOX.clear()
    yield
    mail.CONSOLE_OUTBOX.clear()


def cuenta(api, email, name="Cuenta Competidor", verify=True):
    """Registro abierto + verificación del correo. Devuelve las cabeceras de la sesión."""
    api.post("/auth/signup", {"email": email, "password": "clave-segura-1", "display_name": name}, expect=202)
    if verify:
        mail.drain(base.session_factory())
        msg = [m for m in mail.CONSOLE_OUTBOX if m.to == email][-1]
        tok = re.search(r"#([A-Za-z0-9_-]{20,})", msg.text).group(1)
        api.post("/auth/verify-email", {"token": tok})
    r = api.raw("POST", "/auth/login", json={"username": email, "password": "clave-segura-1"})
    assert r.status_code == 200
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


_anio = itertools.count(1960)


def staff_de_dojo(api, username, dojo_id, role="sensei"):
    p = api.person(username.title(), f"Sensei {username}", dojo_id, birth=f"{next(_anio)}-01-01")
    api.post(f"/persons/{p['id']}/roles", {"role": role, "scope_type": "dojo", "scope_id": dojo_id}, expect=201)
    api.post("/users", {"username": username, "password": "secret123", "person_id": p["id"]}, expect=201)
    r = api.raw("POST", "/auth/login", json={"username": username, "password": "secret123"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def public_id(pid):
    return _db().get(Person, pid).public_id


def test_adult_claims_own_profile_reviewed_by_their_dojo(client):
    api = client
    kaze, mizu = api.dojo("Kaze"), api.dojo("Mizu")
    adult = api.person(
        "Rocio",
        "Paredes Luna",
        kaze["id"],
        sex="F",
        birth="1995-03-04",
        document={"doc_type": "DNI", "number": "44556677"},
    )
    other = api.person("Rosa", "Otra", kaze["id"], sex="F", birth="1996-03-04")
    # Sin verificar el correo no se reclama.
    unverified = cuenta(api, "sinverificar@example.com", verify=False)
    r = api.raw(
        "POST",
        "/profile-claims",
        json={"public_id": public_id(adult["id"]), "relationship": "self"},
        headers=unverified,
    )
    assert r.status_code == 403 and r.json()["error"]["code"] == "EMAIL_NOT_VERIFIED"

    me = cuenta(api, "rocio@example.com", "Rocío")
    found = api.get("/profiles/search", params={"q": "rocio paredes"}, headers=me)
    assert found == [
        {
            "public_id": public_id(adult["id"]),
            "name": "Rocio P.",
            "dojo": "Dojo Kaze",
            "tournaments": [],
            "tournament_count": 0,
        }
    ]
    raw = json.dumps(found)
    assert "1995" not in raw and "44556677" not in raw and "6677" not in raw
    assert api.raw("GET", f"/persons/{adult['id']}/history", headers=me).status_code == 403

    claim = api.post(
        "/profile-claims",
        {"public_id": public_id(adult["id"]), "relationship": "self", "evidence": "Soy yo", "document_last4": "6677"},
        expect=201,
        headers=me,
    )
    assert claim["status"] == "pending"  # sin aprobación automática por defecto
    assert (
        api.raw(
            "POST", "/profile-claims", json={"public_id": public_id(adult["id"]), "relationship": "self"}, headers=me
        ).json()["error"]["code"]
        == "CLAIM_PENDING"
    )

    # Un sensei de otro dojo no ve ni revisa la solicitud.
    ajeno = staff_de_dojo(api, "senseimizu", mizu["id"])
    assert api.get("/profile-claims", headers=ajeno) == []
    r = api.raw("POST", f"/profile-claims/{claim['id']}/review", json={"approve": True}, headers=ajeno)
    assert r.status_code == 403
    # Una cuenta sin rol tampoco.
    assert api.raw("GET", "/profile-claims", headers=me).status_code == 403

    sensei = staff_de_dojo(api, "senseikaze", kaze["id"])
    pending = api.get("/profile-claims", headers=sensei)
    assert [(c["id"], c["document_match"], c["is_minor"], c["birth_date"]) for c in pending] == [
        (claim["id"], True, False, None)  # el sensei no ve la fecha de nacimiento
    ]
    assert api.get("/profile-claims/pending-count", headers=sensei) == {"pending": 1}
    api.post(f"/profile-claims/{claim['id']}/review", {"approve": True}, headers=sensei)
    assert api.get("/auth/me", headers=me)["person_id"] == adult["id"]
    assert api.get("/me/profiles", headers=me)[0]["relationship"] == "self"
    assert api.get(f"/persons/{adult['id']}/history", headers=me)["person_id"] == adult["id"]
    assert api.get(f"/persons/{adult['id']}/stats", headers=me)["person_id"] == adult["id"]
    assert api.raw("GET", f"/persons/{other['id']}/history", headers=me).status_code == 403
    # Ya revisada; y aviso por correo.
    r = api.raw("POST", f"/profile-claims/{claim['id']}/review", json={"approve": False}, headers=sensei)
    assert r.status_code == 409
    mail.drain(base.session_factory())
    assert any(m.to == "rocio@example.com" and "aprobada" in m.subject for m in mail.CONSOLE_OUTBOX)
    # El perfil ya no lo puede reclamar otra cuenta.
    otro = cuenta(api, "impostor@example.com")
    r = api.raw(
        "POST", "/profile-claims", json={"public_id": public_id(adult["id"]), "relationship": "self"}, headers=otro
    )
    assert r.json()["error"]["code"] == "PROFILE_TAKEN"


def test_auto_approve_adult_with_matching_document(client, monkeypatch):
    api = client
    monkeypatch.setattr(get_settings(), "auto_approve_self_claim", True)
    d = api.dojo("Kaze")
    adult = api.person(
        "Mario", "Quispe", d["id"], birth="1990-01-01", document={"doc_type": "DNI", "number": "10203040"}
    )
    wrong = cuenta(api, "mal@example.com")
    c = api.post(
        "/profile-claims",
        {"public_id": public_id(adult["id"]), "relationship": "self", "document_last4": "9999"},
        expect=201,
        headers=wrong,
    )
    assert c["status"] == "pending"
    me = cuenta(api, "mario@example.com")
    c = api.post(
        "/profile-claims",
        {"public_id": public_id(adult["id"]), "relationship": "self", "document_last4": "3040"},
        expect=201,
        headers=me,
    )
    assert c["status"] == "approved"
    assert api.get("/auth/me", headers=me)["person_id"] == adult["id"]
    # El reclamo pendiente de la otra cuenta ya no se puede aprobar.
    r = api.raw("POST", f"/profile-claims/{c['id'] - 1}/review", json={"approve": True})
    assert r.status_code == 409 and r.json()["error"]["code"] == "PROFILE_TAKEN"


def test_minor_claim_by_parent_with_consent_and_human_review(client, monkeypatch):
    api = client
    monkeypatch.setattr(get_settings(), "auto_approve_self_claim", True)
    d, rival_dojo = api.dojo("Kaze"), api.dojo("Mizu")
    kid = api.person("Diego", "Ramirez Soto", d["id"], document={"doc_type": "DNI", "number": "71234567"})
    rival = api.person("Bruno", "Castillo Vega", rival_dojo["id"])
    # Torneo oficial ya jugado: el rival es otro menor.
    t = setup_tournament(api, is_test=False)
    c = api.post(f"/tournaments/{t['id']}/categories", KUMITE, expect=201)
    regs = {register(api, t["id"], p["id"], c["id"], weight_class="-45")["id"]: p for p in (kid, rival)}
    m = api.post(f"/categories/{c['id']}/bracket", {"seed": 1})["matches"][0]
    play(api, m["id"], [("aka", 3)], "aka")
    assert regs

    parent = cuenta(api, "mama@example.com", "Mamá de Diego")
    pid = public_id(kid["id"])
    r = api.raw("POST", "/profile-claims", json={"public_id": pid, "relationship": "self"}, headers=parent)
    assert r.json()["error"]["code"] == "MINOR_PROFILE"
    r = api.raw("POST", "/profile-claims", json={"public_id": pid, "relationship": "parent"}, headers=parent)
    assert r.json()["error"]["code"] == "CONSENT_REQUIRED"
    claim = api.post(
        "/profile-claims",
        {"public_id": pid, "relationship": "parent", "consent": True, "document_last4": "4567"},
        expect=201,
        headers=parent,
    )
    # Menores: nunca aprobación automática, aunque el documento coincida.
    assert claim["status"] == "pending"
    assert api.raw("GET", f"/persons/{kid['id']}/history", headers=parent).status_code == 403

    dojo_admin = staff_de_dojo(api, "admindojo", d["id"], role="dojo_admin")
    api.post(f"/profile-claims/{claim['id']}/review", {"approve": True}, headers=dojo_admin)
    db = _db()
    g = db.query(Guardianship).one()
    assert (g.person_id, g.relation) == (kid["id"], "parent")
    consent = db.query(DataConsent).filter(DataConsent.person_id == kid["id"]).one()
    assert consent.scope == "publicación de resultados y estadísticas" and consent.given_by == "Mamá de Diego"
    assert api.get("/auth/me", headers=parent)["person_id"] is None

    profiles = api.get("/me/profiles", headers=parent)
    assert [(p["person_id"], p["relationship"]) for p in profiles] == [(kid["id"], "parent")]
    h = api.get(f"/persons/{kid['id']}/history", headers=parent)
    fights = h["tournaments"][0]["matches"]
    # Del rival (otro menor) solo el nombre abreviado.
    assert fights[0]["opponent"] == "Bruno C."
    assert api.get(f"/persons/{kid['id']}/stats", headers=parent)["kumite"]["matches"] == 1
    assert api.raw("GET", f"/persons/{rival['id']}/history", headers=parent).status_code == 403
    # El organizador sigue viendo el nombre completo.
    assert api.get(f"/persons/{kid['id']}/history")["tournaments"][0]["matches"][0]["opponent"] == "Bruno Castillo Vega"
    # El padre puede dejar la tutela.
    api.raw("DELETE", f"/me/guardianships/{profiles[0]['guardianship_id']}", headers=parent)
    assert api.raw("GET", f"/persons/{kid['id']}/history", headers=parent).status_code == 403


def test_rejected_claim_and_adult_profile_needs_self(client):
    api = client
    d = api.dojo("Kaze")
    adult = api.person("Ana", "Adulta", d["id"], sex="F", birth="1990-01-01")
    kid = api.person("Nino", "Menor", d["id"])
    u = cuenta(api, "ana@example.com")
    r = api.raw(
        "POST",
        "/profile-claims",
        json={"public_id": public_id(adult["id"]), "relationship": "guardian", "consent": True},
        headers=u,
    )
    assert r.json()["error"]["code"] == "ADULT_PROFILE"
    c = api.post(
        "/profile-claims",
        {"public_id": public_id(kid["id"]), "relationship": "guardian", "consent": True},
        expect=201,
        headers=u,
    )
    api.post(f"/profile-claims/{c['id']}/review", {"approve": False, "reason": "No coincide con la ficha"})
    mine = api.get("/profile-claims/mine", headers=u)
    assert [(x["status"], x["reason"], x["person_name"]) for x in mine] == [
        ("rejected", "No coincide con la ficha", "Nino M.")
    ]
    assert _db().query(Guardianship).count() == 0 and _db().query(DataConsent).count() == 0


def test_public_profile_without_sensitive_data(client):
    api = client
    d = api.dojo("Kaze")
    kid = api.person("Lucia", "Fernandez Rojas", d["id"], sex="F", document={"doc_type": "DNI", "number": "76543210"})
    adult = api.person("Carlos", "Mendoza", d["id"], birth="1990-05-05")
    rival = api.person("Sara", "Rival", d["id"], sex="F")
    kumite_f = {**KUMITE, "code": "KU-F", "sex": "F", "name": "Kumite 12-13 Femenino -45"}
    official = setup_tournament(api, is_test=False, name="Copa Lima")
    test = setup_tournament(api, name="Torneo de prueba")
    for t in (official, test):
        c = api.post(f"/tournaments/{t['id']}/categories", kumite_f, expect=201)
        register(api, t["id"], kid["id"], c["id"], weight_class="-45")
        register(api, t["id"], rival["id"], c["id"], weight_class="-45")
        m = api.post(f"/categories/{c['id']}/bracket", {"seed": 1})["matches"][0]
        winner = "aka" if m["aka_registration_id"] else "ao"
        play(api, m["id"], [(winner, 3)], winner)
    future = setup_tournament(api, is_test=False, name="Copa Futura")
    cf = api.post(f"/tournaments/{future['id']}/categories", kumite_f, expect=201)
    register(api, future["id"], kid["id"], cf["id"], weight_class="-45")
    db = _db()
    db.get(Tournament, official["id"]).status = "finished"
    db.get(Tournament, test["id"]).status = "finished"
    db.commit()

    anon = client.c
    anon.headers.pop("Authorization")
    r = anon.get(f"/api/v1/public/persons/{public_id(kid['id'])}")
    assert r.status_code == 200 and "public" in r.headers["cache-control"]
    data = r.json()
    assert data["name"] == "Lucia F."
    assert data["dojo"] == "Dojo Kaze"
    assert [e["tournament_name"] for e in data["tournaments"]] == ["Copa Lima"]  # sin prueba ni futuros
    assert data["tournament_count"] == 1 and sum(data["medals"].values()) == 1
    raw = r.text
    for secret in ("76543210", "birth", "document", "Fernandez Rojas", "person_id", "email", "Sara", "opponent"):
        assert secret not in raw, secret
    assert str(kid["id"]) != data["public_id"]
    # Adulto con fecha conocida: nombre completo.
    assert anon.get(f"/api/v1/public/persons/{public_id(adult['id'])}").json()["name"] == "Carlos Mendoza"
    assert anon.get("/api/v1/public/persons/no-existe").status_code == 404


def test_public_id_backfilled_by_migration(tmp_path):
    from alembic import command
    from sqlalchemy import text

    from app.db.base import make_engine
    from app.db.migrate import alembic_config, upgrade_database

    engine = make_engine(f"sqlite:///{tmp_path / 'm.db'}")
    cfg = alembic_config()
    with engine.begin() as conn:
        cfg.attributes["connection"] = conn
        command.upgrade(cfg, "0008_mesa_principal")
        for i in range(3):
            conn.execute(
                text(
                    "INSERT INTO persons (first_names, last_names, normalized_name, sex, identity_incomplete, "
                    "is_test_data, version, created_at, updated_at) "
                    f"VALUES ('P{i}', 'X', 'p{i} x', 'M', 1, 0, 1, '2026-01-01', '2026-01-01')"
                )
            )
        conn.execute(
            text(
                "INSERT INTO users (username, password_hash, is_active, is_admin, token_version, "
                "must_change_password, display_name, created_at, updated_at) "
                "VALUES ('viejo', 'x', 1, 0, 0, 0, '', '2026-01-01', '2026-01-01')"
            )
        )
    upgrade_database(engine)
    with engine.connect() as conn:
        ids = conn.execute(text("SELECT public_id FROM persons")).scalars().all()
        assert len(ids) == 3 and all(ids) and len(set(ids)) == 3
        assert conn.execute(text("SELECT email FROM users")).scalar() is None


def test_anonymize_and_delete_account_remove_guardianship(client):
    api = client
    d = api.dojo("Kaze")
    kids = [api.person("Nina", "Uno", d["id"], sex="F"), api.person("Nico", "Dos", d["id"])]
    parent = cuenta(api, "papa@example.com", "Papá")
    for k in kids:
        c = api.post(
            "/profile-claims",
            {"public_id": public_id(k["id"]), "relationship": "parent", "consent": True},
            expect=201,
            headers=parent,
        )
        api.post(f"/profile-claims/{c['id']}/review", {"approve": True})
    assert _db().query(Guardianship).count() == 2
    # Anonimizar a un menor borra su tutela y su consentimiento (sin romper la referencia del reclamo).
    api.post(f"/persons/{kids[0]['id']}/anonymize", {"reason": "Pedido de la familia"})
    assert [g.person_id for g in _db().query(Guardianship).all()] == [kids[1]["id"]]
    # Borrar la cuenta quita el correo y las tutelas.
    api.post("/auth/delete-account", {"password": "clave-segura-1"}, expect=204, headers=parent)
    assert _db().query(Guardianship).count() == 0
    assert _db().query(User).filter(User.email == "papa@example.com").count() == 0
