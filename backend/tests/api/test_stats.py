"""Estadísticas, líderes y premios del torneo."""

from tests.api.test_mock_tournament import KUMITE, register, setup_tournament
from tests.api.test_teams import first_team_match, lineup
from tests.api.test_teams import setup as team_setup


def play(api, mid, points, winner):
    api.event(mid, "start")
    for color, value in points:
        api.event(mid, "point", color, value)
        api.event(mid, "resume")
    api.finish(mid, winner)


def test_individual_stats_leaders_awards_and_summary(client):
    api = client
    t = setup_tournament(api, is_test=False)
    c = api.post(f"/tournaments/{t['id']}/categories", KUMITE, expect=201)
    dojos = [api.dojo("Kaze"), api.dojo("Mizu")]
    people = [api.person(f"P{i}", "Uno", dojos[i % 2]["id"]) for i in range(4)]
    regs = {register(api, t["id"], p["id"], c["id"], weight_class="-45")["id"]: p for p in people}
    b = api.post(f"/categories/{c['id']}/bracket", {"seed": 5})
    semis = [m for m in b["matches"] if m["round"] == 1]
    finalists = []
    for m in semis:
        play(api, m["id"], [("aka", 3), ("aka", 1), ("ao", 2)], "aka")
        finalists.append(regs[m["aka_registration_id"]])
    final = next(m for m in api.get(f"/categories/{c['id']}/bracket")["matches"] if m["round"] == 2)
    play(api, final["id"], [("ao", 1), ("aka", 3)], "aka")
    champion = regs[final["aka_registration_id"]]

    st = api.get(f"/persons/{champion['id']}/stats")
    k = st["kumite"]
    assert (k["matches"], k["wins"], k["losses"]) == (2, 2, 0)
    assert k["techniques"]["ippon"] == 2 and k["points_for"] == 7 and k["win_pct"] == 100.0
    assert st["medals"]["gold"] == 1 and st["tournaments"] == 1
    earned = {b["code"] for b in st["badges"] if b["earned"]}
    assert {"first_win", "ippon", "gold", "unbeaten"} <= earned and "wins_10" not in earned
    assert st["form"] == ["win", "win"]

    lb = api.get(f"/tournaments/{t['id']}/leaders")
    assert lb["leaders"]["mvp"][0]["person_id"] == champion["id"]
    assert {a["code"] for a in lb["awards"]} >= {"mvp", "ippon", "fastest", "senshu"}
    assert lb["leaders"]["ippon"][0]["ippon"] == 2
    assert api.get("/leaders")["leaders"]["wins"][0]["person_id"] == champion["id"]

    sm = api.get(f"/matches/{final['id']}/summary")
    assert [(x["type"], x["aka"], x["ao"]) for x in sm["timeline"]] == [
        ("point", 0, 1),
        ("point", 3, 1),
        ("finish", 3, 1),
    ]
    assert sm["senshu"] == "ao" and sm["match"]["winner"] == "aka"
    assert (
        sm["aka"]["techniques"]["ippon"] == 1
        and sm["aka"]["name"] == f"{champion['first_names']} {champion['last_names']}"
    )
    assert finalists


def test_test_tournaments_do_not_count(client):
    api = client
    t = setup_tournament(api)  # es_prueba
    c = api.post(f"/tournaments/{t['id']}/categories", KUMITE, expect=201)
    d = api.dojo("Kaze")
    ps = [api.person(f"Q{i}", "Dos", d["id"]) for i in range(2)]
    for p in ps:
        register(api, t["id"], p["id"], c["id"], weight_class="-45")
    m = api.post(f"/categories/{c['id']}/bracket", {"seed": 1})["matches"][0]
    play(api, m["id"], [("aka", 3)], "aka")
    assert api.get(f"/persons/{ps[0]['id']}/stats")["kumite"]["matches"] == 0
    assert api.get(f"/tournaments/{t['id']}/leaders")["awards"] == []


def test_team_bouts_count_for_the_member_who_fought(client):
    api = client
    t, c, dojos, members, sub, regs = team_setup(api)
    _, m = first_team_match(api, c)
    tm = api.get(f"/matches/{m['id']}/team")
    aka = [x["person_id"] for x in tm["aka"]["members"] if x["role"] == "starter"]
    ao = [x["person_id"] for x in tm["ao"]["members"] if x["role"] == "starter"]
    bouts = [x["match"] for x in lineup(api, m["id"], list(zip(aka, ao, strict=True)))["bouts"]]
    play(api, bouts[0]["id"], [("aka", 3)], "aka")
    play(api, bouts[1]["id"], [("aka", 2)], "aka")
    st = api.get(f"/persons/{aka[0]}/stats")
    assert st["kumite"]["matches"] == 1 and st["kumite"]["techniques"]["ippon"] == 1
    assert api.get(f"/persons/{aka[2]}/stats")["kumite"]["matches"] == 0
    lb = api.get(f"/tournaments/{t['id']}/leaders")["leaders"]
    assert lb["ippon"][0]["person_id"] == aka[0] and lb["ippon"][0]["dojo"] == tm["aka"]["name"]
