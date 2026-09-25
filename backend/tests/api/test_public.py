"""Seguimiento en vivo público y overlay: opcional, sin sesión y con datos mínimos."""

from tests.api.test_mock_tournament import KUMITE, register, setup_tournament
from tests.api.test_stats import play
from tests.api.test_teams import first_team_match, lineup
from tests.api.test_teams import setup as team_setup


def enable(api, tid, **kw):
    return api.c.put(f"/api/v1/tournaments/{tid}/public", json={"enabled": True, **kw}).json()


def test_public_live_is_opt_in_minimal_and_revocable(client):
    api = client
    t = setup_tournament(api, is_test=False)
    c = api.post(f"/tournaments/{t['id']}/categories", KUMITE, expect=201)
    api.patch(f"/categories/{c['id']}", {"tatami_id": t["tatamis"][0]["id"], "version": c["version"]})
    d = api.dojo("Kaze")
    ps = [api.person("Diego Alonso", "Ramos Quispe", d["id"]), api.person("Mateo", "Huamán Torres", d["id"])]
    for p in ps:
        register(api, t["id"], p["id"], c["id"], weight_class="-45")
    m = api.post(f"/categories/{c['id']}/bracket", {"seed": 1})["matches"][0]
    assert api.get(f"/tournaments/{t['id']}")["public_token"] is None

    out = enable(api, t["id"])
    token = out["public_token"]
    assert token and out["public_names"] == "short"
    anon = api.c.__class__(api.c.app)  # cliente sin encabezado de sesión
    api.event(m["id"], "start")
    api.event(m["id"], "point", "aka", 2)

    live = anon.get(f"/api/v1/public/{token}").json()
    assert live["tournament"]["name"] == t["name"]
    cur = live["tatamis"][0]["current"]
    assert {cur["aka"]["name"], cur["ao"]["name"]} == {"Diego R.", "Mateo H."} and sorted(cur["score"]) == [0, 2]
    text = str(live)
    assert "Ramos Quispe" not in text and "birth" not in text and "person_id" not in text

    tid = t["tatamis"][0]["id"]
    ov = anon.get(f"/api/v1/public/{token}/tatamis/{tid}").json()["match"]
    assert sorted(ov["score"]) == [0, 2] and ov["running"] is False and ov["duration"] == 90

    # Nombres completos si el organizador lo decide; revocar corta el enlace.
    enable(api, t["id"], names="full")
    assert "Diego Alonso Ramos Quispe" in str(anon.get(f"/api/v1/public/{token}").json())
    api.c.put(f"/api/v1/tournaments/{t['id']}/public", json={"enabled": False})
    assert anon.get(f"/api/v1/public/{token}").status_code == 404
    assert anon.get("/api/v1/public/inventado").status_code == 404


def test_overlay_follows_the_live_bout_of_a_team_match(client):
    api = client
    t, c, dojos, members, sub, regs = team_setup(api)
    tat = api.get(f"/tournaments/{t['id']}")["tatamis"][0]["id"]
    cat = api.get(f"/categories/{c['id']}")
    api.patch(f"/categories/{c['id']}", {"tatami_id": tat, "version": cat["version"]})
    _, m = first_team_match(api, c)
    tm = api.get(f"/matches/{m['id']}/team")
    aka = [x["person_id"] for x in tm["aka"]["members"] if x["role"] == "starter"]
    ao = [x["person_id"] for x in tm["ao"]["members"] if x["role"] == "starter"]
    bouts = [x["match"] for x in lineup(api, m["id"], list(zip(aka, ao, strict=True)))["bouts"]]
    play(api, bouts[0]["id"], [("aka", 3)], "aka")
    api.event(bouts[1]["id"], "start")
    api.event(bouts[1]["id"], "point", "ao", 1)
    token = enable(api, t["id"])["public_token"]
    ov = api.c.get(f"/api/v1/public/{token}/tatamis/{tat}").json()["match"]
    assert ov["team"] == {"aka": tm["aka"]["name"], "ao": tm["ao"]["name"], "wins": [1, 0], "bout": 2, "extra": False}
    assert ov["score"] == [0, 1] and ov["aka"]["dojo"] == tm["aka"]["name"] and ov["running"] is False
