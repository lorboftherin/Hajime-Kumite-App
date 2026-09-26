"""Reglas deportivas configurables y cambios con la llave generada (API)."""

import uuid

from tests.api.test_mock_tournament import KUMITE, register, setup_tournament
from tests.api.test_teams import first_team_match, lineup
from tests.api.test_teams import setup as team_setup

AT = "2026-10-17T10:00:00Z"


def codes(r):
    assert r.status_code == 409, r.text
    body = r.json()["error"]
    return {w["code"] for w in body["details"].get("warnings", [])} or {body["code"]}


def kumite_cat(api, tid, code="K", **fields):
    return api.post(f"/tournaments/{tid}/categories", {**KUMITE, "code": code, **fields}, expect=201)


def fill(api, tid, cid, dojos, n, prefix="P"):
    regs = []
    for i in range(n):
        p = api.person(f"{prefix}{i}", f"Ap{prefix}{i}", dojos[i % len(dojos)]["id"])
        regs.append(register(api, tid, p["id"], cid, weight_class="-45"))
    return regs


def late_registration(api, tid, cid, dojo, name="Tarde"):
    p = api.person(name, "Tardío", dojo["id"])
    return register(api, tid, p["id"], cid, weight_class="-45", override="Inscripción el día del torneo")


# ---------------------------------------------------------------------------
# Inscripción tardía y retiro con la llave generada
# ---------------------------------------------------------------------------


def test_late_entry_takes_a_free_bye_with_dojo_separation(client):
    api = client
    dojos = [api.dojo(n) for n in ("Uno", "Dos", "Tres")]
    t = setup_tournament(api)
    c = kumite_cat(api, t["id"])
    fill(api, t["id"], c["id"], dojos, 5)
    b = api.post(f"/categories/{c['id']}/bracket", {"seed": 3})
    assert b["size"] == 8 and b["slots"].count(None) == 3
    # Se disputa un combate de primera ronda: la llave ya no se regenera.
    played = next(m for m in b["matches"] if m["status"] == "ready")
    api.finish(played["id"], "aka", override="papel")
    r = api.raw("POST", f"/categories/{c['id']}/bracket", json={"seed": 4})
    assert r.status_code == 409 and r.json()["error"]["code"] == "BRACKET_STARTED"
    assert "Añadir a la llave" in r.json()["error"]["message"]

    new = late_registration(api, t["id"], c["id"], dojos[0])
    body = {"registration_id": new["id"], "reason": "Llegó tarde"}
    assert codes(api.raw("POST", f"/categories/{c['id']}/bracket/entrants", json=body)) == {"BRACKET_IN_PROGRESS"}
    out = api.post(f"/categories/{c['id']}/bracket/entrants", {**body, "override": {"reason": "Autoriza el juez"}})
    nb = out["bracket"]
    pos = out["result"]["position"]
    assert nb["slots"][pos] == new["id"] and nb["version_number"] == b["version_number"] + 1
    rival = nb["slots"][pos ^ 1]
    assert rival is not None and nb["participants"][str(rival)]["dojo_id"] != dojos[0]["id"]
    r1 = next(m for m in nb["matches"] if m["code"] == f"R1-{pos // 2 + 1}")
    assert r1["status"] == "ready" and {r1["aka_registration_id"], r1["ao_registration_id"]} == {new["id"], rival}
    # El combate ya disputado sigue intacto.
    assert next(m for m in nb["matches"] if m["id"] == played["id"])["status"] == "finished"
    versions = api.get(f"/categories/{c['id']}/bracket/versions")
    assert len(versions) == 2 and versions[-1]["current"]


def test_late_entry_without_free_bye(client):
    api = client
    dojos = [api.dojo("Uno"), api.dojo("Dos")]
    t = setup_tournament(api)
    c = kumite_cat(api, t["id"])
    fill(api, t["id"], c["id"], dojos, 4)
    api.post(f"/categories/{c['id']}/bracket", {"seed": 1})
    new = late_registration(api, t["id"], c["id"], dojos[0])
    r = api.raw("POST", f"/categories/{c['id']}/bracket/entrants", json={"registration_id": new["id"]})
    assert r.status_code == 409 and r.json()["error"]["code"] == "NO_FREE_BYE"
    assert "regenérala" in r.json()["error"]["message"]


def test_remove_before_playing_leaves_a_bye(client):
    api = client
    dojos = [api.dojo("Uno"), api.dojo("Dos")]
    t = setup_tournament(api)
    c = kumite_cat(api, t["id"])
    regs = fill(api, t["id"], c["id"], dojos, 4)
    b = api.post(f"/categories/{c['id']}/bracket", {"seed": 1})
    m = b["matches"][0]
    gone, rival = m["aka_registration_id"], m["ao_registration_id"]
    out = api.post(f"/categories/{c['id']}/bracket/entrants/remove", {"registration_id": gone, "reason": "Lesión"})
    assert out["result"]["mode"] == "bye"
    nb = out["bracket"]
    r1 = next(x for x in nb["matches"] if x["code"] == m["code"])
    assert r1["status"] == "bye" and r1["winner_registration_id"] == rival
    reg = next(r for r in api.get(f"/tournaments/{t['id']}/registrations") if r["id"] == gone)
    assert reg["status"] == "withdrawn"
    assert regs


def test_remove_after_winning_is_a_walkover_or_pending_walkover(client):
    api = client
    dojos = [api.dojo("Uno"), api.dojo("Dos")]
    t = setup_tournament(api)
    c = kumite_cat(api, t["id"])
    fill(api, t["id"], c["id"], dojos, 4)
    b = api.post(f"/categories/{c['id']}/bracket", {"seed": 1})
    semi1, semi2 = [m for m in b["matches"] if m["round"] == 1]
    api.finish(semi1["id"], "aka", override="papel")
    winner = semi1["aka_registration_id"]
    # Su rival en la final aún no se conoce: el walkover queda pendiente.
    out = api.post(f"/categories/{c['id']}/bracket/entrants/remove", {"registration_id": winner, "reason": "Lesión"})
    assert out["result"]["mode"] == "walkover_pending"
    # Al cerrarse la otra semifinal, la final se cierra sola por walkover.
    api.finish(semi2["id"], "ao", override="papel")
    final = next(m for m in api.get(f"/categories/{c['id']}/bracket")["matches"] if m["round"] == 2)
    assert final["status"] == "finished" and final["method"] == "walkover"
    assert final["winner_registration_id"] == semi2["ao_registration_id"]
    assert api.get(f"/categories/{c['id']}")["status"] == "finished"


def test_remove_with_known_rival_records_walkover_now(client):
    api = client
    dojos = [api.dojo("Uno"), api.dojo("Dos")]
    t = setup_tournament(api)
    c = kumite_cat(api, t["id"])
    fill(api, t["id"], c["id"], dojos, 4)
    b = api.post(f"/categories/{c['id']}/bracket", {"seed": 1})
    semi1, semi2 = [m for m in b["matches"] if m["round"] == 1]
    api.finish(semi1["id"], "aka", override="papel")
    api.finish(semi2["id"], "aka", override="papel")
    out = api.post(
        f"/categories/{c['id']}/bracket/entrants/remove",
        {"registration_id": semi1["aka_registration_id"], "reason": "Lesión"},
    )
    assert out["result"]["mode"] == "walkover"
    final = next(m for m in out["bracket"]["matches"] if m["round"] == 2)
    assert final["winner_registration_id"] == semi2["aka_registration_id"] and final["method"] == "walkover"


def test_round_robin_add_and_remove(client):
    api = client
    dojos = [api.dojo("Uno"), api.dojo("Dos")]
    t = setup_tournament(api)
    c = kumite_cat(api, t["id"], format="round_robin")
    regs = fill(api, t["id"], c["id"], dojos, 3)
    b = api.post(f"/categories/{c['id']}/bracket", {"seed": 1})
    assert len(b["matches"]) == 3
    new = late_registration(api, t["id"], c["id"], dojos[0])
    out = api.post(f"/categories/{c['id']}/bracket/entrants", {"registration_id": new["id"]})
    assert out["result"]["matches_added"] == 3 and len(out["bracket"]["matches"]) == 6
    out = api.post(f"/categories/{c['id']}/bracket/entrants/remove", {"registration_id": regs[0]["id"]})
    assert out["result"]["matches_voided"] == 3 and len(out["bracket"]["matches"]) == 3
    assert regs[0]["id"] not in {s["registration_id"] for s in out["bracket"]["standings"]}


def test_move_registration_between_brackets_on_tournament_day(client):
    api = client
    dojos = [api.dojo("Uno"), api.dojo("Dos")]
    t = setup_tournament(api)
    a = kumite_cat(api, t["id"], "A")
    b_ = kumite_cat(api, t["id"], "B")
    regs_a = fill(api, t["id"], a["id"], dojos, 4, "A")
    fill(api, t["id"], b_["id"], dojos, 3, "B")
    api.post(f"/categories/{a['id']}/bracket", {"seed": 1})
    api.post(f"/categories/{b_['id']}/bracket", {"seed": 1})
    mover = regs_a[0]
    body = {"version": mover["version"], "category_id": b_["id"]}
    r = api.raw("PATCH", f"/registrations/{mover['id']}", json=body)
    assert codes(r) == {"BRACKET_MOVE_OUT", "BRACKET_MOVE_IN"}
    moved = api.patch(f"/registrations/{mover['id']}", {**body, "override": {"reason": "Pesaje: sube de categoría"}})
    assert moved["category_id"] == b_["id"] and moved["status"] == "active"
    ba = api.get(f"/categories/{a['id']}/bracket")
    bb = api.get(f"/categories/{b_['id']}/bracket")
    assert mover["id"] not in ba["slots"] and mover["id"] in bb["slots"]


# ---------------------------------------------------------------------------
# Kata
# ---------------------------------------------------------------------------


def kata_cat(api, tid, **fields):
    body = {"code": "KA", "name": "Kata", "modality": "kata", "sex": "M", "age_min": 12, "age_max": 13, **fields}
    return api.post(f"/tournaments/{tid}/categories", body, expect=201)


def kata_people(api, tid, cid, n, dojos):
    return [register(api, tid, api.person(f"K{i}", "Kata", dojos[i % 2]["id"])["id"], cid) for i in range(n)]


def test_flags_on_a_scores_category_require_override(client):
    api = client
    dojos = [api.dojo("Uno"), api.dojo("Dos")]
    t = setup_tournament(api)
    c = kata_cat(api, t["id"], kata_method="scores", kata_structure="bracket")
    kata_people(api, t["id"], c["id"], 2, dojos)
    m = api.post(f"/categories/{c['id']}/bracket", {})["matches"][0]
    body = {"votes": ["aka", "aka", "ao"], "event_id": str(uuid.uuid4()), "at": AT}
    assert codes(api.raw("POST", f"/matches/{m['id']}/flags", json=body)) == {"KATA_METHOD_MISMATCH"}
    res = api.post(f"/matches/{m['id']}/flags", {**body, "override": {"reason": "Falla el tablero de notas"}})
    assert res["winner"] == "aka"


def test_kata_scores_in_bracket(client):
    api = client
    dojos = [api.dojo("Uno"), api.dojo("Dos")]
    t = setup_tournament(api, kata_defaults={"no_repeat_kata": True})
    c = kata_cat(api, t["id"], kata_method="scores", kata_structure="bracket", kata_judges=5)
    kata_people(api, t["id"], c["id"], 4, dojos)
    b = api.post(f"/categories/{c['id']}/bracket", {"seed": 2})
    semi = b["matches"][0]
    tie = ["7.0", "7.5", "7.5", "7.5", "8.0"]
    body = {"aka_scores": tie, "ao_scores": tie, "event_id": str(uuid.uuid4()), "at": AT}
    res = api.post(f"/matches/{semi['id']}/kata-scores", body)
    assert res["winner"] is None and res["needs_head_judge"]
    body = {
        **body,
        "ao_scores": ["7.2", "7.4", "7.5", "7.6", "7.8"],
        "aka_kata_name": "Bassai Dai",
        "ao_kata_name": "Jion",
    }
    res = api.post(f"/matches/{semi['id']}/kata-scores", body)
    assert res["winner"] == "ao" and res["aka_total"] == res["ao_total"] == 22.5
    after = next(m for m in api.get(f"/categories/{c['id']}/bracket")["matches"] if m["id"] == semi["id"])
    assert after["method"] == "scores" and after["winner_registration_id"] == semi["ao_registration_id"]
    # Regla «no repetir kata»: en la final repite Jion -> advertencia.
    other = b["matches"][1]
    api.post(
        f"/matches/{other['id']}/kata-scores",
        {"aka_scores": ["8"] * 5, "ao_scores": ["7"] * 5, "event_id": str(uuid.uuid4()), "at": AT},
    )
    final = next(m for m in api.get(f"/categories/{c['id']}/bracket")["matches"] if m["round"] == 2)
    color = "aka" if final["aka_registration_id"] == semi["ao_registration_id"] else "ao"
    body = {
        "aka_scores": ["8"] * 5,
        "ao_scores": ["7"] * 5,
        f"{color}_kata_name": "jion",
        "event_id": str(uuid.uuid4()),
        "at": AT,
    }
    assert codes(api.raw("POST", f"/matches/{final['id']}/kata-scores", json=body)) == {"KATA_REPEATED"}


def test_kata_multiple_rounds_order_and_medals(client):
    api = client
    dojos = [api.dojo("Uno"), api.dojo("Dos")]
    t = setup_tournament(api, kata_defaults={"method": "scores", "structure": "rounds", "judges": 3})
    c = kata_cat(api, t["id"], kata_rules={"rounds": [3]})
    regs = kata_people(api, t["id"], c["id"], 5, dojos)
    b = api.post(f"/categories/{c['id']}/bracket", {"seed": 5})
    assert b["kata_rounds"]["total"] == 2 and b["kata_rounds"]["current"] == 1
    # Orden de salida: se fija con el endpoint (lista completa) y se intercambia con swap.
    order = [s["registration_id"] for s in b["standings"]]
    b = api.raw("PUT", f"/categories/{c['id']}/kata-order", json={"registration_ids": order[::-1]}).json()
    assert [s["registration_id"] for s in b["standings"]] == order[::-1]
    b = api.patch(f"/brackets/{b['id']}/slots", {"version": b["version"], "a": 0, "b": 1})
    assert [s["registration_id"] for s in b["standings"]][:2] == [order[-2], order[-1]]
    notes = {r["id"]: f"{9 - i * 0.5:.1f}" for i, r in enumerate(regs)}  # 9.0, 8.5, 8.0, 7.5, 7.0
    for rid, n in notes.items():
        b = api.post(f"/categories/{c['id']}/kata-scores", {"registration_id": rid, "scores": [n] * 3})
    rounds = b["kata_rounds"]
    assert rounds["current"] == 2 and rounds["rounds"][0]["qualified"] == [r["id"] for r in regs[:3]]
    # 2.ª ronda (final): el mejor clasificado sale último.
    assert [s["registration_id"] for s in b["standings"]] == [regs[2]["id"], regs[1]["id"], regs[0]["id"]]
    assert b["podium"]["places"] == []
    for rid, n in ((regs[0]["id"], "7.0"), (regs[1]["id"], "8.0"), (regs[2]["id"], "9.0")):
        b = api.post(f"/categories/{c['id']}/kata-scores", {"registration_id": rid, "scores": [n] * 3})
    places = {p["registration_id"]: p["place"] for p in b["podium"]["places"]}
    assert places == {regs[2]["id"]: 1, regs[1]["id"]: 2, regs[0]["id"]: 3}
    # Las notas de la 1.ª ronda se conservan.
    assert b["kata_rounds"]["rounds"][0]["standings"][0]["total"] is not None


def test_wkf_preset_with_technical_and_athletic_scores(client):
    api = client
    dojos = [api.dojo("Uno"), api.dojo("Dos")]
    t = setup_tournament(api, kata_defaults={"method": "scores", "structure": "rounds", "preset": "wkf"})
    c = kata_cat(api, t["id"])
    regs = kata_people(api, t["id"], c["id"], 2, dojos)
    api.post(f"/categories/{c['id']}/bracket", {"seed": 1})
    tech = ["8.0", "8.2", "8.4", "8.4", "8.6", "8.8", "9.0"]
    ath = ["8.0", "8.0", "8.2", "8.4", "8.4", "8.6", "9.0"]
    r = api.raw("POST", f"/categories/{c['id']}/kata-scores", json={"registration_id": regs[0]["id"], "scores": tech})
    assert r.status_code == 400  # faltan las notas atléticas
    b = api.post(
        f"/categories/{c['id']}/kata-scores",
        {"registration_id": regs[0]["id"], "scores": tech, "athletic_scores": ath},
    )
    row = next(s for s in b["standings"] if s["registration_id"] == regs[0]["id"])
    assert row["total"] == 25.28 and row["technical"] == 25.4


# ---------------------------------------------------------------------------
# Kumite
# ---------------------------------------------------------------------------


def one_match(api, tid, dojos, **fields):
    c = kumite_cat(api, tid, **fields)
    fill(api, tid, c["id"], dojos, 2)
    return c, api.post(f"/categories/{c['id']}/bracket", {"seed": 1})["matches"][0]


def test_point_values_and_two_ladders_of_fouls(client):
    api = client
    dojos = [api.dojo("Uno"), api.dojo("Dos")]
    t = setup_tournament(api, kumite_rules={"sanction_preset": "two_categories", "point_values": [1, 2]})
    _, m = one_match(api, t["id"], dojos)
    api.event(m["id"], "point", "aka", 3, expect=409)  # el ippon no está habilitado
    ev = {"id": str(uuid.uuid4()), "type": "sanction", "at": AT, "color": "aka", "value": 2, "infraction": "jogai"}
    sb = api.post(f"/matches/{m['id']}/events", ev, expect=201)
    assert sb["sanction"] == {"aka": 0, "ao": 0} and sb["sanction_c2"] == {"aka": 2, "ao": 0}
    assert sb["infractions"]["jogai"]["ladder"] == "c2" and sb["rules"]["sanction_preset"] == "two_categories"
    assert sb["events"][-1]["infraction"] == "jogai"
    bad = {**ev, "id": str(uuid.uuid4()), "infraction": "karma"}
    assert api.raw("POST", f"/matches/{m['id']}/events", json=bad).json()["error"]["code"] == "INVALID_INFRACTION"


def test_golden_point_and_hantei_with_votes(client):
    api = client
    dojos = [api.dojo("Uno"), api.dojo("Dos")]
    t = setup_tournament(api, kumite_rules={"tie_rule": "golden_point", "golden_point_seconds": 45})
    _, m = one_match(api, t["id"], dojos)
    api.event(m["id"], "start")
    sb = api.event(m["id"], "golden_point")
    assert sb["golden_point"] and sb["period_seconds"] == 90 + 45
    api.event(m["id"], "golden_point", expect=409)
    sb = api.event(m["id"], "point", "ao", 1)
    assert sb["suggestion"]["winner"] == "ao" and sb["suggestion"]["method"] == "golden_point"

    # Hantei con votos: el color debe coincidir con la mayoría.
    t2 = setup_tournament(api)
    _, m2 = one_match(api, t2["id"], dojos, code="K2")
    body = {"id": str(uuid.uuid4()), "type": "hantei", "at": AT, "color": "aka", "votes": ["ao", "ao", "aka"]}
    assert api.raw("POST", f"/matches/{m2['id']}/events", json=body).json()["error"]["code"] == "HANTEI_VOTES"
    sb = api.post(f"/matches/{m2['id']}/events", {**body, "color": "ao"}, expect=201)
    assert [v["color"] for v in sb["hantei_votes"]] == ["ao", "ao", "aka"]


def test_hantei_finish_warns_when_it_contradicts_the_score(client):
    api = client
    dojos = [api.dojo("Uno"), api.dojo("Dos")]
    t = setup_tournament(api)
    _, m = one_match(api, t["id"], dojos)
    api.event(m["id"], "point", "aka", 3)
    r = api.raw(
        "POST",
        f"/matches/{m['id']}/finish",
        json={"id": str(uuid.uuid4()), "at": AT, "winner": "ao", "method": "hantei"},
    )
    assert codes(r) == {"SCORE_MISMATCH"}


def test_disqualify_from_the_whole_tournament(client):
    api = client
    dojos = [api.dojo("Uno"), api.dojo("Dos")]
    t = setup_tournament(api)
    a = kumite_cat(api, t["id"], "A")
    b_ = kumite_cat(api, t["id"], "B")
    regs = fill(api, t["id"], a["id"], dojos, 4, "A")
    fill(api, t["id"], b_["id"], dojos, 3, "B")
    bad = regs[0]
    reg_b = register(api, t["id"], bad["person_id"], b_["id"], weight_class="-45")
    api.post(f"/categories/{a['id']}/bracket", {"seed": 1})
    api.post(f"/categories/{b_['id']}/bracket", {"seed": 1})
    r = api.raw("POST", f"/registrations/{bad['id']}/disqualify", json={"reason": "Conducta antideportiva"})
    assert codes(r) == {"DISQUALIFY_TOURNAMENT"}
    out = api.post(
        f"/registrations/{bad['id']}/disqualify",
        {"reason": "Conducta antideportiva", "override": {"reason": "Confirmado por el director"}},
    )
    assert {x["registration_id"] for x in out["withdrawn"]} == {bad["id"], reg_b["id"]}
    states = {r["id"]: r["status"] for r in api.get(f"/tournaments/{t['id']}/registrations")}
    assert states[bad["id"]] == states[reg_b["id"]] == "withdrawn"
    assert bad["id"] not in api.get(f"/categories/{a['id']}/bracket")["slots"]


# ---------------------------------------------------------------------------
# Equipos
# ---------------------------------------------------------------------------


def test_team_empty_slot_is_a_walkover_and_extra_bout_needs_hantei(client):
    api = client
    t, c, dojos, members, sub, regs = team_setup(api, tie_rule="extra_bout")
    _, m = first_team_match(api, c)
    tm = api.get(f"/matches/{m['id']}/team")
    aka = [x["person_id"] for x in tm["aka"]["members"] if x["role"] == "starter"]
    ao = [x["person_id"] for x in tm["ao"]["members"] if x["role"] == "starter"]
    # AO no presenta a nadie para el 3.er combate: walkover 8–0 para AKA.
    out = lineup(api, m["id"], [(aka[0], ao[0]), (aka[1], ao[1]), (aka[2], None)])
    third = out["bouts"][2]["match"]
    assert third["status"] == "finished" and third["method"] == "walkover"
    assert (third["aka_score"], third["ao_score"]) == (8, 0)
    # El orden declarado no cambia tras empezar el primer combate.
    first = out["bouts"][0]["match"]
    api.event(first["id"], "start")
    r = lineup(api, m["id"], [(aka[0], ao[0]), (aka[1], ao[2]), (aka[2], None)], expect=None)
    assert codes(r) == {"LINEUP_LOCKED"}
    api.finish(first["id"], "ao", override="papel")
    second = out["bouts"][1]["match"]
    api.finish(second["id"], "draw", override="empate")
    d = api.get(f"/matches/{m['id']}/team")["decision"]
    assert d["wins"] == {"aka": 1, "ao": 1} and d["needs_extra_bout"]
    extra = lineup(api, m["id"], [(aka[0], ao[0])], extra=True)["bouts"][-1]["match"]
    r = api.raw("POST", f"/matches/{extra['id']}/finish", json={"id": str(uuid.uuid4()), "at": AT, "winner": "draw"})
    assert r.json()["error"]["code"] == "EXTRA_BOUT_NEEDS_HANTEI"
    api.finish(extra["id"], "aka", method="hantei")
    assert api.get(f"/matches/{m['id']}/team")["decision"]["winner"] == "aka"


def test_team_remaining_bouts_not_disputed_and_min_starters(client):
    api = client
    t, c, dojos, members, sub, regs = team_setup(api)
    _, m = first_team_match(api, c)
    tm = api.get(f"/matches/{m['id']}/team")
    aka = [x["person_id"] for x in tm["aka"]["members"] if x["role"] == "starter"]
    ao = [x["person_id"] for x in tm["ao"]["members"] if x["role"] == "starter"]
    bouts = [x["match"] for x in lineup(api, m["id"], list(zip(aka, ao, strict=True)))["bouts"]]
    api.finish(bouts[0]["id"], "aka", override="papel")
    api.finish(bouts[1]["id"], "aka", override="papel")
    rest = api.get(f"/matches/{m['id']}/team")["bouts"][2]["match"]
    assert rest["status"] == "void" and rest["method"] == "not_disputed"

    # Mínimo de titulares: el que presenta menos pierde el enfrentamiento.
    t2 = setup_tournament(api, kumite_rules={"team_min_starters": 3})
    c2 = api.post(
        f"/tournaments/{t2['id']}/categories",
        {
            **{k: v for k, v in c.items() if k in ("modality", "sex")},
            "code": "EQ2",
            "name": "Equipos 2",
            "is_team": True,
        },
        expect=201,
    )
    from tests.api.test_teams import team

    team(api, t2["id"], c2["id"], dojos[0], "Kaze B", members[0])
    team(api, t2["id"], c2["id"], dojos[1], "Mizu B", members[1])
    b = api.post(f"/categories/{c2['id']}/bracket", {"seed": 1})
    m2 = b["matches"][0]
    tm = api.get(f"/matches/{m2['id']}/team")
    aka = [x["person_id"] for x in tm["aka"]["members"] if x["role"] == "starter"]
    ao = [x["person_id"] for x in tm["ao"]["members"] if x["role"] == "starter"]
    out = lineup(api, m2["id"], [(aka[0], ao[0]), (aka[1], ao[0]), (aka[2], ao[1])], override="Solo dos")
    assert out["match"]["method"] == "incomplete_team"
    final = api.get(f"/categories/{c2['id']}/bracket")["matches"][0]
    assert final["method"] == "incomplete_team" and final["winner_registration_id"] == m2["aka_registration_id"]


# ---------------------------------------------------------------------------
# Categorías
# ---------------------------------------------------------------------------


def test_split_and_undo_split_by_weight(client):
    api = client
    dojos = [api.dojo("Uno"), api.dojo("Dos")]
    t = setup_tournament(api)
    c = kumite_cat(api, t["id"], weight_class="-60", max_entrants=3)
    assert c["weight_max_kg"] == 60 and c["weight_min_kg"] is None
    regs = []
    for i, w in enumerate(["-40", "-45", "-50", "-55"]):
        p = api.person(f"S{i}", "Split", dojos[i % 2]["id"])
        body = {"person_id": p["id"], "category_id": c["id"], "weight_class": w}
        if i == 3:
            r = api.raw("POST", f"/tournaments/{t['id']}/registrations", json=body)
            assert "CATEGORY_FULL" in codes(r)
        body["override"] = {"reason": "Peso por confirmar en el pesaje"}
        regs.append(api.post(f"/tournaments/{t['id']}/registrations", body, expect=201))
    assert "split" in api.get(f"/categories/{c['id']}")["advice"]
    new = api.post(f"/categories/{c['id']}/split", {"criterion": "weight", "reason": "Muchos inscritos"})
    old = api.get(f"/categories/{c['id']}")
    assert old["entrant_count"] == 2 and new["entrant_count"] == 2
    assert old["weight_max_kg"] == 45 and new["weight_min_kg"] == 45 and new["split_from_id"] == c["id"]
    moved = {r["id"] for r in api.get(f"/tournaments/{t['id']}/registrations?category_id={new['id']}")}
    assert moved == {regs[2]["id"], regs[3]["id"]}
    back = api.post(f"/categories/{c['id']}/unsplit")
    assert back["entrant_count"] == 4 and back["name"] == c["name"] and back["weight_max_kg"] == 60
    assert api.get(f"/categories/{new['id']}")["status"] == "cancelled"


def test_age_mode_birth_year_and_suggestions_without_weight(client):
    api = client
    d = api.dojo("Uno")
    t = setup_tournament(api)
    c = kumite_cat(api, t["id"], age_min=13, age_max=13, grade_min=None, grade_max=None)
    p = api.person("Nov", "Iembre", d["id"], birth="2013-11-20")  # 12 años el 17/10/2026
    body = {"person_id": p["id"], "category_id": c["id"], "weight_class": "-45"}
    assert "AGE_BELOW_MIN" in codes(api.raw("POST", f"/tournaments/{t['id']}/registrations", json=body))
    api.patch(f"/tournaments/{t['id']}", {"version": t["version"], "age_mode": "birth_year"})
    reg = api.post(f"/tournaments/{t['id']}/registrations", body, expect=201)
    assert reg["age_at_reference"] == 13
    # Sugerencias: sin peso se proponen igual las de kumite; con peso, se filtra.
    p2 = api.person("Otro", "Mas", d["id"], birth="2013-01-10")
    sug = api.get(f"/tournaments/{t['id']}/suggestions?person_id={p2['id']}&modality=kumite")
    assert [x["category_id"] for x in sug] == [c["id"]]
    sug = api.get(f"/tournaments/{t['id']}/suggestions?person_id={p2['id']}&modality=kumite&weight_class=-60")
    assert sug == []


def test_invalid_rules_are_rejected_and_defaults_are_published(client):
    api = client
    t = setup_tournament(api)
    r = api.raw("PATCH", f"/tournaments/{t['id']}", json={"version": t["version"], "kata_defaults": {"judges": 4}})
    assert r.status_code == 409 and r.json()["error"]["code"] == "INVALID_RULES"
    r = api.raw(
        "PATCH",
        f"/tournaments/{t['id']}",
        json={"version": t["version"], "competition_rules": {"round_robin_criteria": ["wins", "karma"]}},
    )
    assert r.json()["error"]["code"] == "INVALID_RULES"
    d = api.get("/rules/defaults")
    assert d["kumite"]["golden_point_seconds"] == 60 and d["competition"]["round_robin_bronzes"] == 1
    assert d["kata"]["discard_each_side"] is None and "jogai" in d["infractions"]
    cat = api.get("/kata-catalog")
    assert {s["style"] for s in cat["styles"]} == {"Shotokan", "Goju-ryu", "Shito-ryu", "Wado-ryu"}
    assert "Unsu" in cat["katas"]


# ---------------------------------------------------------------------------
# Round robin y grupos + eliminación
# ---------------------------------------------------------------------------


def test_round_robin_two_bronzes_option(client):
    api = client
    dojos = [api.dojo("Uno"), api.dojo("Dos")]
    t = setup_tournament(api, competition_rules={"round_robin_bronzes": 2})
    c = kumite_cat(api, t["id"], format="round_robin")
    regs = fill(api, t["id"], c["id"], dojos, 5)
    b = api.post(f"/categories/{c['id']}/bracket", {"seed": 1, "override": {"reason": "Cinco inscritos"}})
    rank = {r["id"]: i for i, r in enumerate(regs)}  # gana siempre el de menor índice
    for m in b["matches"]:
        a, o = m["aka_registration_id"], m["ao_registration_id"]
        api.finish(m["id"], "aka" if rank[a] < rank[o] else "ao", override="papel")
    podium = api.get(f"/categories/{c['id']}/bracket")["podium"]
    places = sorted((p["place"], p["registration_id"]) for p in podium["places"])
    assert [p for p, _ in places] == [1, 2, 3, 3]


def test_groups_knockout_flow(client):
    api = client
    dojos = [api.dojo(n) for n in ("Uno", "Dos", "Tres")]
    t = setup_tournament(api, competition_rules={"groups": 2, "group_qualifiers": 2})
    c = kumite_cat(api, t["id"], format="groups_knockout")
    regs = fill(api, t["id"], c["id"], dojos, 6)
    b = api.post(f"/categories/{c['id']}/bracket", {"seed": 3})
    assert b["format"] == "groups_knockout" and len(b["groups"]) == 2
    group_matches = [m for m in b["matches"] if m["kind"] == "group"]
    assert len(group_matches) == 6 and all(m["status"] == "ready" for m in group_matches)
    ko = [m for m in b["matches"] if m["kind"] == "main"]
    assert all(m["status"] == "pending" and m["aka_registration_id"] is None for m in ko)
    rank = {r["id"]: i for i, r in enumerate(regs)}
    for m in group_matches:
        a, o = m["aka_registration_id"], m["ao_registration_id"]
        api.finish(m["id"], "aka" if rank[a] < rank[o] else "ao", override="papel")
    b = api.get(f"/categories/{c['id']}/bracket")
    firsts = {g["letter"]: g["standings"][0]["registration_id"] for g in b["groups"]}
    seconds = {g["letter"]: g["standings"][1]["registration_id"] for g in b["groups"]}
    semis = [m for m in b["matches"] if m["kind"] == "main" and m["round"] == 1]
    pairs = {frozenset([m["aka_registration_id"], m["ao_registration_id"]]) for m in semis}
    assert pairs == {frozenset([firsts["A"], seconds["B"]]), frozenset([firsts["B"], seconds["A"]])}
    for m in semis:
        a, o = m["aka_registration_id"], m["ao_registration_id"]
        api.finish(m["id"], "aka" if rank[a] < rank[o] else "ao", override="papel")
    rows = api.get(f"/categories/{c['id']}/bracket")["matches"]
    final = next(m for m in rows if m["kind"] == "main" and m["round"] == 2)
    api.finish(final["id"], "aka", override="papel")
    b = api.get(f"/categories/{c['id']}/bracket")
    assert b["podium"]["complete"] and len(b["podium"]["places"]) == 4
