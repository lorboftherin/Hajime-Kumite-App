"""Correo y cuentas junto con organizaciones: avisos al sensei y al dojo, historial del
administrador del dojo y hoja del combate para la persona y su apoderado."""

import pytest

from app.db import base
from app.services import mail
from tests.api.test_autoinscripcion import open_tournament, sensei
from tests.api.test_mock_tournament import KUMITE, register, setup_tournament
from tests.api.test_reclamos_perfil import _abierto, cuenta, public_id  # noqa: F401 - fixture autouse
from tests.api.test_stats import play


@pytest.fixture(autouse=True)
def _correo_limpio():
    mail.CONSOLE_OUTBOX.clear()
    yield
    mail.CONSOLE_OUTBOX.clear()


def enviados(to):
    mail.drain(base.session_factory())
    return [m for m in mail.CONSOLE_OUTBOX if m.to == to]


def con_correo(api, user_api, email):
    uid = user_api.get("/auth/me")["id"]
    api.patch(f"/users/{uid}", {"email": email})
    return uid


def dojo_admin(api, username, dojo_id, first="Kenji"):
    """Sensei con rol dojo_admin (como lo deja aceptar una invitación)."""
    s, p = sensei(api, username, dojo_id, first=first)
    api.post(f"/persons/{p['id']}/roles", {"role": "dojo_admin", "scope_type": "dojo", "scope_id": dojo_id}, expect=201)
    return s


def test_registration_decision_mails_the_sensei(client):
    api = client
    kaze = api.dojo("Kaze")
    t, c = open_tournament(api)
    s1 = dojo_admin(api, "sensei1", kaze["id"])
    con_correo(api, s1, "sensei1@example.com")
    a = api.person("Mateo", "Huaman", kaze["id"])
    b = api.person("Diego", "Ramos", kaze["id"])
    base_url = f"/dojo-portal/dojos/{kaze['id']}/tournaments/{t['id']}/registrations"
    items = [{"person_id": p["id"], "category_id": c["id"], "weight_class": "-45"} for p in (a, b)]
    created = s1.post(base_url, {"items": items}, expect=201)
    ids = {x["person_id"]: x["id"] for x in created}
    enviados("sensei1@example.com")
    mail.CONSOLE_OUTBOX.clear()
    api.post(f"/tournaments/{t['id']}/registration-requests/decide", {"ids": [ids[a["id"]]], "action": "approve"})
    api.post(
        f"/tournaments/{t['id']}/registration-requests/decide",
        {"ids": [ids[b["id"]]], "action": "reject", "reason": "Peso fuera de la categoría"},
    )
    out = enviados("sensei1@example.com")
    assert len(out) == 2
    assert "Aprobadas: Mateo Huaman" in out[0].text and "No aprobadas" not in out[0].text
    assert "No aprobadas: Diego Ramos" in out[1].text and "Peso fuera de la categoría" in out[1].text
    assert t["name"] in out[0].subject


def test_new_claim_notifies_dojo_reviewers(client):
    api = client
    kaze, mizu = api.dojo("Kaze"), api.dojo("Mizu")
    kid = api.person("Nina", "Menor", kaze["id"], sex="F")
    s1 = dojo_admin(api, "senseikaze", kaze["id"])
    con_correo(api, s1, "kaze@example.com")
    s2 = dojo_admin(api, "senseimizu", mizu["id"], first="Hiro")
    con_correo(api, s2, "mizu@example.com")
    parent = cuenta(api, "mama@example.com")
    enviados("kaze@example.com")
    mail.CONSOLE_OUTBOX.clear()
    api.post(
        "/profile-claims",
        {"public_id": public_id(kid["id"]), "relationship": "parent", "consent": True},
        expect=201,
        headers=parent,
    )
    got = enviados("kaze@example.com")
    assert len(got) == 1 and "Nina M." in got[0].text and "/solicitudes" in got[0].text
    assert "Menor" not in got[0].text.replace("menor de edad", "")  # sin apellido completo
    assert enviados("mizu@example.com") == []


def test_dojo_admin_sees_full_history_of_current_members(client):
    api = client
    kaze, mizu = api.dojo("Kaze"), api.dojo("Mizu")
    mine = api.person("Rosa", "Kaze", kaze["id"], sex="F")
    other = api.person("Luis", "Mizu", mizu["id"])
    s1 = dojo_admin(api, "senseikaze", kaze["id"])
    assert s1.get(f"/persons/{mine['id']}/history")["person_id"] == mine["id"]
    assert s1.get(f"/persons/{mine['id']}/stats")["person_id"] == mine["id"]
    assert s1.raw("GET", f"/persons/{other['id']}/history").status_code == 403
    # Si cambia de dojo, deja de verlo.
    api.post(f"/persons/{mine['id']}/memberships", {"dojo_id": mizu["id"], "start_date": "2026-09-01"}, expect=201)
    assert s1.raw("GET", f"/persons/{mine['id']}/history").status_code == 403


def test_match_summary_for_person_and_guardian(client):
    api = client
    d, rd = api.dojo("Kaze"), api.dojo("Mizu")
    kid = api.person("Diego", "Ramirez", d["id"])
    rival = api.person("Bruno", "Castillo", rd["id"])
    stranger_kid = api.person("Otro", "Nino", d["id"])
    t = setup_tournament(api, is_test=False)
    c = api.post(f"/tournaments/{t['id']}/categories", KUMITE, expect=201)
    for p in (kid, rival):
        register(api, t["id"], p["id"], c["id"], weight_class="-45")
    m = api.post(f"/categories/{c['id']}/bracket", {"seed": 1})["matches"][0]
    play(api, m["id"], [("aka", 3)], "aka")

    parent = cuenta(api, "papa@example.com")
    assert api.raw("GET", f"/matches/{m['id']}/summary", headers=parent).status_code == 403
    claim = api.post(
        "/profile-claims",
        {"public_id": public_id(kid["id"]), "relationship": "parent", "consent": True},
        expect=201,
        headers=parent,
    )
    api.post(f"/profile-claims/{claim['id']}/review", {"approve": True})
    sm = api.get(f"/matches/{m['id']}/summary", headers=parent)
    names = {sm["aka"]["name"], sm["ao"]["name"]}
    assert names == {"Diego Ramirez", "Bruno C."}  # el rival, abreviado
    assert sm["timeline"]
    # El organizador ve los nombres completos.
    full = api.get(f"/matches/{m['id']}/summary")
    assert {full["aka"]["name"], full["ao"]["name"]} == {"Diego Ramirez", "Bruno Castillo"}

    # Otro apoderado (de un menor que no peleó) no la ve.
    other = cuenta(api, "otro@example.com")
    c2 = api.post(
        "/profile-claims",
        {"public_id": public_id(stranger_kid["id"]), "relationship": "guardian", "consent": True},
        expect=201,
        headers=other,
    )
    api.post(f"/profile-claims/{c2['id']}/review", {"approve": True})
    assert api.raw("GET", f"/matches/{m['id']}/summary", headers=other).status_code == 403
