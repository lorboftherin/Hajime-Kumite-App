"""Dos tablets en el mismo combate: una lleva la mesa y la otra queda en solo lectura."""

from datetime import timedelta

from app.db import base
from app.db.models import MatchPresence
from tests.api.test_multi_tatami import ev, fin, operator, two_tatamis


def _presence(api, mid, device, hdr):
    return api.raw("POST", f"/matches/{mid}/presence", json={"device_id": device}, headers=hdr).json()


def _event(api, mid, hdr, device, body=None):
    return api.raw("POST", f"/matches/{mid}/events", json=body or ev("start"), headers={**hdr, "X-Device-Id": device})


def test_first_tablet_leads_and_the_other_is_read_only_until_it_takes_the_table(client):
    api = client
    t, tats, (m1, _) = two_tatamis(api)
    h1, _ = operator(api, "uno", tats[0]["id"])
    h2, _ = operator(api, "dos", tats[0]["id"])
    mid = m1["id"]

    first = _presence(api, mid, "tablet-uno", h1)
    assert first["primary"] is True and first["owner"] is None
    second = _presence(api, mid, "tablet-dos", h2)
    assert second["primary"] is False
    assert second["owner"] == {"user": "Mesa uno", "same_user": False}

    # La dueña registra; la otra recibe 409 CONFLICT_DEVICE (y nada se guarda).
    assert _event(api, mid, h1, "tablet-uno").status_code == 201
    r = _event(api, mid, h2, "tablet-dos", ev("point", "aka", 1))
    assert r.status_code == 409 and r.json()["error"]["code"] == "CONFLICT_DEVICE"
    assert api.get(f"/matches/{mid}")["score"] == {"aka": 0, "ao": 0}
    r = api.raw("POST", f"/matches/{mid}/finish", json=fin("aka"), headers={**h2, "X-Device-Id": "tablet-dos"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "CONFLICT_DEVICE"

    # «Tomar la mesa»: la segunda pasa a registrar y la primera queda en solo lectura.
    took = api.raw("POST", f"/matches/{mid}/presence/take", json={"device_id": "tablet-dos"}, headers=h2).json()
    assert took["primary"] is True
    assert _event(api, mid, h2, "tablet-dos", ev("point", "aka", 1)).status_code == 201
    assert _event(api, mid, h1, "tablet-uno", ev("point", "ao", 1)).status_code == 409
    assert _presence(api, mid, "tablet-uno", h1)["primary"] is False
    audit = api.get("/audit", params={"tournament_id": t["id"], "limit": 50})
    assert any(a["action"] == "take_table" and a["entity_id"] == str(mid) for a in audit)

    # Sin X-Device-Id (scripts, versiones anteriores) no se comprueba la tablet.
    assert api.raw("POST", f"/matches/{mid}/events", json=ev("pause"), headers=h1).status_code == 201


def test_a_silent_owner_is_replaced_by_the_next_active_tablet(client):
    api = client
    _, tats, (m1, _) = two_tatamis(api)
    h1, _ = operator(api, "uno", tats[0]["id"])
    h2, _ = operator(api, "dos", tats[0]["id"])
    mid = m1["id"]
    assert _presence(api, mid, "tablet-uno", h1)["primary"] is True
    assert _presence(api, mid, "tablet-dos", h2)["primary"] is False

    # La dueña deja de latir (se apagó): pasado el margen, la otra la toma sola al latir.
    db = next(base.get_session())
    row = db.query(MatchPresence).filter_by(match_id=mid, device_id="tablet-uno").one()
    row.last_seen = row.last_seen - timedelta(minutes=5)
    db.commit()
    db.close()
    assert _presence(api, mid, "tablet-dos", h2)["primary"] is True
    assert _event(api, mid, h2, "tablet-dos").status_code == 201
    # Si la primera vuelve, queda en solo lectura.
    back = _presence(api, mid, "tablet-uno", h1)
    assert back["primary"] is False and back["owner"]["user"] == "Mesa dos"


def test_a_viewer_without_operator_role_never_takes_the_table(client):
    api = client
    _, tats, (m1, _) = two_tatamis(api)
    h_other, _ = operator(api, "ajeno", tats[1]["id"])  # opera OTRO tatami
    h1, _ = operator(api, "uno", tats[0]["id"])
    mid = m1["id"]
    seen = _presence(api, mid, "tablet-ajena", h_other)
    assert seen["primary"] is False and seen["owner"] is None
    assert _presence(api, mid, "tablet-uno", h1)["primary"] is True
    r = api.raw("POST", f"/matches/{mid}/presence/take", json={"device_id": "tablet-ajena"}, headers=h_other)
    assert r.status_code == 403
