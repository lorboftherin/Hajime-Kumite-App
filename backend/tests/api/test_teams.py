"""Equipos temporales y kumite por equipos (sección 15)."""

import uuid

from tests.api.test_mock_tournament import KUMITE, register, setup_tournament

TEAM_KUMITE = {**KUMITE, "code": "KU-EQ-M", "name": "Kumite equipos 12-13 Masculino", "is_team": True}
TEAM_KUMITE.pop("weight_class")
TEAM_KATA = {
    "code": "KA-EQ-M",
    "name": "Kata equipos 12-13 Masculino",
    "modality": "kata",
    "sex": "M",
    "age_min": 12,
    "age_max": 13,
    "is_team": True,
}


def warnings_of(r):
    assert r.status_code == 409, r.text
    return {w["code"] for w in r.json()["error"]["details"]["warnings"]}


def people(api, dojo, prefix, n):
    return [api.person(f"{prefix}{i}", f"Apellido{prefix}", dojo["id"]) for i in range(n)]


def team(api, tid, cid, dojo, name, members, subs=(), override=None, expect=201):
    body = {
        "category_id": cid,
        "dojo_id": dojo["id"],
        "name": name,
        "members": [{"person_id": p["id"]} for p in members]
        + [{"person_id": p["id"], "role": "substitute"} for p in subs],
    }
    if override:
        body["override"] = {"reason": override}
    if expect is None:
        return api.raw("POST", f"/tournaments/{tid}/teams", json=body)
    return api.post(f"/tournaments/{tid}/teams", body, expect=expect)


def finish(api, mid, winner, override=None, expect=200):
    body = {"id": str(uuid.uuid4()), "at": "2026-10-17T11:00:00Z", "winner": winner, "method": "points"}
    if override:
        body["override"] = {"reason": override}
    if expect is None:
        return api.raw("POST", f"/matches/{mid}/finish", json=body)
    return api.post(f"/matches/{mid}/finish", body, expect=expect)


def lineup(api, mid, pairs, extra=False, override=None, expect=200):
    body = {"bouts": [{"aka_person_id": a, "ao_person_id": b} for a, b in pairs], "extra": extra}
    if override:
        body["override"] = {"reason": override}
    r = api.raw("PUT", f"/matches/{mid}/lineup", json=body)
    if expect is not None:
        assert r.status_code == expect, r.text
        return r.json()
    return r


def setup(api, tie_rule=None):
    t = setup_tournament(api, is_test=False)
    extra = {"kumite_rules": {"team_tie_rule": tie_rule}} if tie_rule else {}
    c = api.post(f"/tournaments/{t['id']}/categories", {**TEAM_KUMITE, **extra}, expect=201)
    dojos = [api.dojo(n) for n in ("Kaze", "Mizu", "Tsuchi")]
    members = [people(api, d, p, 3) for d, p in zip(dojos, ("K", "M", "T"), strict=True)]
    sub = api.person("Suplente", "Kaze", dojos[0]["id"])
    regs = [
        team(api, t["id"], c["id"], dojos[0], "Kaze A", members[0], subs=[sub]),
        team(api, t["id"], c["id"], dojos[1], "Mizu A", members[1]),
        team(api, t["id"], c["id"], dojos[2], "Tsuchi A", members[2]),
    ]
    return t, c, dojos, members, sub, regs


def first_team_match(api, c):
    b = api.post(f"/categories/{c['id']}/bracket", {"seed": 7})
    m = next(m for m in b["matches"] if m["status"] == "ready")
    return b, m


def test_team_registration_warnings_and_output(client):
    api = client
    t, c, dojos, members, sub, regs = setup(api)
    assert regs[0]["person_name"] == "Kaze A" and regs[0]["team_id"]
    roles = [(m["name"], m["role"]) for m in regs[0]["team_members"]]
    assert roles[-1] == ("Suplente Kaze", "substitute") and len(roles) == 4

    # Una persona no se inscribe sola en una categoría por equipos.
    r = api.raw("POST", f"/tournaments/{t['id']}/registrations", json={"person_id": sub["id"], "category_id": c["id"]})
    assert r.status_code == 409 and r.json()["error"]["code"] == "TEAM_CATEGORY"

    # Advertencias: pocos titulares, integrante de otro dojo y de otro equipo, nombre repetido.
    r = team(api, t["id"], c["id"], dojos[1], "Mizu A", [members[0][0], members[1][0]], expect=None)
    assert warnings_of(r) == {"TEAM_SHORT", "MEMBER_OTHER_DOJO", "MEMBER_IN_OTHER_TEAM", "TEAM_NAME_DUPLICATE"}

    # Persona repetida en el mismo equipo: se bloquea.
    body = {"category_id": c["id"], "dojo_id": dojos[0]["id"], "name": "X", "members": [{"person_id": sub["id"]}] * 2}
    assert api.raw("POST", f"/tournaments/{t['id']}/teams", json=body).json()["error"]["code"] == "TEAM_MEMBER_REPEATED"

    # Editar integrantes con control de versión.
    upd = {
        "version": regs[1]["team_version"],
        "name": "Mizu Uno",
        "members": [{"person_id": p["id"]} for p in members[1]],
    }
    out = api.patch(f"/teams/{regs[1]['team_id']}", upd)
    assert out["person_name"] == "Mizu Uno"
    assert api.raw("PATCH", f"/teams/{regs[1]['team_id']}", json=upd).status_code == 409


def test_team_match_flow_points_and_correction(client):
    api = client
    t, c, dojos, members, sub, regs = setup(api)
    b, m = first_team_match(api, c)
    names = {p["name"] for p in b["participants"].values()}
    assert names == {"Kaze A", "Mizu A", "Tsuchi A"}
    sb = api.get(f"/matches/{m['id']}")
    assert sb["is_team_match"] and sb["bout"] is None

    tm = api.get(f"/matches/{m['id']}/team")
    assert tm["settings"] == {"bouts": 3, "tie_rule": "points"} and tm["bouts"] == []
    aka = {x["person_id"] for x in tm["aka"]["members"]}
    ao = {x["person_id"] for x in tm["ao"]["members"]}
    aka_ids = [x["person_id"] for x in tm["aka"]["members"] if x["role"] == "starter"]
    ao_ids = [x["person_id"] for x in tm["ao"]["members"] if x["role"] == "starter"]

    # Alineación: integrante ajeno y repetido advierten.
    r = lineup(
        api, m["id"], [(aka_ids[0], ao_ids[0]), (aka_ids[0], ao_ids[1]), (next(iter(ao)), ao_ids[2])], expect=None
    )
    assert warnings_of(r) == {"PERSON_REPEATED", "NOT_IN_TEAM"}
    tm = lineup(api, m["id"], list(zip(aka_ids, ao_ids, strict=True)))
    bouts = [x["match"] for x in tm["bouts"]]
    assert [x["code"] for x in bouts] == [f"{m['code']}-B{i}" for i in (1, 2, 3)]
    assert tm["match"]["status"] == "in_progress" and aka and ao
    # Los combates individuales no aparecen en la llave.
    assert {x["id"] for x in api.get(f"/categories/{c['id']}/bracket")["matches"]}.isdisjoint({x["id"] for x in bouts})

    # El marcador del combate muestra al integrante y su equipo.
    sb = api.get(f"/matches/{bouts[0]['id']}")
    assert sb["bout"]["bout_number"] == 1 and sb["bout"]["parent_match_id"] == m["id"]
    assert sb["aka"]["dojo_name"] == tm["aka"]["name"] and sb["aka"]["name"] != tm["aka"]["name"]

    # Un combate de la llave no termina en empate.
    body = {"id": str(uuid.uuid4()), "at": "2026-10-17T11:00:00Z", "winner": "draw"}
    assert api.raw("POST", f"/matches/{m['id']}/finish", json=body).json()["error"]["code"] == "DRAW_NOT_ALLOWED"

    api.event(bouts[0]["id"], "point", "aka", 3)
    finish(api, bouts[0]["id"], "aka")
    api.event(bouts[1]["id"], "point", "ao", 2)
    finish(api, bouts[1]["id"], "ao")
    assert api.get(f"/matches/{m['id']}/team")["decision"]["pending_bouts"] == 1
    # Empate con marcador distinto advierte.
    api.event(bouts[2]["id"], "point", "aka", 1)
    r = finish(api, bouts[2]["id"], "draw", expect=None)
    assert warnings_of(r) == {"SCORE_MISMATCH"}
    ev = api.get(f"/matches/{bouts[2]['id']}")["events"][-1]
    api.event(bouts[2]["id"], "annul", target_id=ev["id"])
    finish(api, bouts[2]["id"], "draw")

    tm = api.get(f"/matches/{m['id']}/team")
    assert tm["decision"]["wins"] == {"aka": 1, "ao": 1} and tm["decision"]["points"] == {"aka": 3, "ao": 2}
    assert tm["match"]["status"] == "finished" and tm["match"]["method"] == "points"
    assert tm["match"]["winner_registration_id"] == tm["aka"]["registration_id"]
    assert (tm["match"]["aka_score"], tm["match"]["ao_score"]) == (1, 1)
    final = next(x for x in api.get(f"/categories/{c['id']}/bracket")["matches"] if x["round"] == 2)
    assert tm["aka"]["registration_id"] in (final["aka_registration_id"], final["ao_registration_id"])

    # Una alineación de un combate ya disputado no se cambia.
    r = lineup(api, m["id"], [(aka_ids[1], ao_ids[0]), (aka_ids[0], ao_ids[1]), (aka_ids[2], ao_ids[2])], expect=409)
    assert r["error"]["code"] == "BOUT_STARTED"

    # Corregir el combate 1 cambia el ganador del enfrentamiento: advierte y corrige la llave.
    r = finish(api, bouts[0]["id"], "ao", expect=None)
    assert warnings_of(r) >= {"WINNER_CHANGE", "TEAM_WINNER_CHANGE", "SCORE_MISMATCH"}
    finish(api, bouts[0]["id"], "ao", override="Error de la mesa: ganó ao")
    tm = api.get(f"/matches/{m['id']}/team")
    assert tm["match"]["winner_registration_id"] == tm["ao"]["registration_id"]
    assert tm["match"]["method"] == "victories"
    final = next(x for x in api.get(f"/categories/{c['id']}/bracket")["matches"] if x["round"] == 2)
    assert tm["ao"]["registration_id"] in (final["aka_registration_id"], final["ao_registration_id"])
    assert tm["aka"]["registration_id"] not in (final["aka_registration_id"], final["ao_registration_id"])


def test_extra_bout_and_history(client):
    api = client
    t, c, dojos, members, sub, regs = setup(api, tie_rule="extra_bout")
    _, m = first_team_match(api, c)
    tm = api.get(f"/matches/{m['id']}/team")
    aka_ids = [x["person_id"] for x in tm["aka"]["members"] if x["role"] == "starter"]
    ao_ids = [x["person_id"] for x in tm["ao"]["members"] if x["role"] == "starter"]
    # Antes del empate, un combate extra advierte.
    r = lineup(api, m["id"], [(aka_ids[0], ao_ids[0])], extra=True, expect=None)
    assert warnings_of(r) == {"EXTRA_NOT_NEEDED"}
    bouts = [x["match"] for x in lineup(api, m["id"], list(zip(aka_ids, ao_ids, strict=True)))["bouts"]]
    api.event(bouts[0]["id"], "point", "aka", 3)
    finish(api, bouts[0]["id"], "aka")
    api.event(bouts[1]["id"], "point", "ao", 1)
    finish(api, bouts[1]["id"], "ao")
    finish(api, bouts[2]["id"], "draw")
    tm = api.get(f"/matches/{m['id']}/team")
    assert tm["decision"]["needs_extra_bout"] and tm["match"]["status"] == "in_progress"

    tm = lineup(api, m["id"], [(aka_ids[2], ao_ids[2])], extra=True)
    extra = tm["bouts"][-1]
    assert extra["is_extra"] and extra["match"]["code"] == f"{m['code']}-X4"
    api.event(extra["match"]["id"], "point", "ao", 1)
    finish(api, extra["match"]["id"], "ao")
    tm = api.get(f"/matches/{m['id']}/team")
    assert tm["match"]["method"] == "extra_bout"
    assert tm["match"]["winner_registration_id"] == tm["ao"]["registration_id"]

    # Historial: quien peleó ve el resultado de su equipo y sus combates.
    h = api.get(f"/persons/{ao_ids[2]}/history")
    entry = next(e for e in h["tournaments"] if e["category_id"] == c["id"])
    assert entry["team_name"] == tm["ao"]["name"]
    assert [(f["code"], f["won"]) for f in entry["matches"]] == [(f"{m['code']}-B3", False), (f"{m['code']}-X4", True)]
    assert entry["matches"][0]["opponent_dojo"] == tm["aka"]["name"]
    # El suplente que no peleó no lo tiene en su historial.
    assert not api.get(f"/persons/{sub['id']}/history")["tournaments"]


def test_team_kata_uses_team_as_participant(client):
    api = client
    t = setup_tournament(api)
    c = api.post(f"/tournaments/{t['id']}/categories", TEAM_KATA, expect=201)
    dojos = [api.dojo("Kaze"), api.dojo("Mizu")]
    t1 = team(api, t["id"], c["id"], dojos[0], "Kaze kata", people(api, dojos[0], "K", 3))
    team(api, t["id"], c["id"], dojos[1], "Mizu kata", people(api, dojos[1], "M", 3))
    b = api.post(f"/categories/{c['id']}/bracket", {"seed": 3})
    m = b["matches"][0]
    assert {p["name"] for p in b["participants"].values()} == {"Kaze kata", "Mizu kata"}
    body = {"votes": ["aka", "aka", "ao"], "event_id": str(uuid.uuid4()), "at": "2026-10-17T11:00:00Z"}
    api.post(f"/matches/{m['id']}/flags", body)
    res = next(r for r in api.get(f"/tournaments/{t['id']}/results") if r["category_id"] == c["id"])
    assert {p["name"] for p in res["places"]} == {"Kaze kata", "Mizu kata"}
    assert any(p["name"] == "Kaze kata" for p in res["places"]) and t1["person_name"] == "Kaze kata"


def test_individual_and_team_categories_do_not_mix(client):
    api = client
    t = setup_tournament(api)
    ind = api.post(f"/tournaments/{t['id']}/categories", KUMITE, expect=201)
    eq = api.post(f"/tournaments/{t['id']}/categories", TEAM_KUMITE, expect=201)
    d = api.dojo("Kaze")
    r = team(api, t["id"], ind["id"], d, "X", people(api, d, "K", 3), expect=409)
    assert r["error"]["code"] == "NOT_TEAM_CATEGORY"
    p = api.person("Solo", "Uno", d["id"])
    reg = register(api, t["id"], p["id"], ind["id"], weight_class="-45")
    r = api.raw("PATCH", f"/registrations/{reg['id']}", json={"version": reg["version"], "category_id": eq["id"]})
    assert r.status_code == 409 and r.json()["error"]["code"] == "INVALID_STATE"
    r = api.raw(
        "POST", f"/tournaments/{t['id']}/categories/merge", json={"source_ids": [ind["id"]], "target_id": eq["id"]}
    )
    assert r.status_code == 409 and r.json()["error"]["code"] == "INVALID_STATE"


def test_team_final_decided_by_bouts_stores_podium_once(client):
    """Cerrar el combate que decide la final por equipos termina la categoría con su podio."""
    api = client
    t = setup_tournament(api, is_test=False)
    c = api.post(f"/tournaments/{t['id']}/categories", TEAM_KUMITE, expect=201)
    dojos = [api.dojo(n) for n in ("Kaze", "Mizu")]
    for d, p in zip(dojos, ("K", "M"), strict=True):
        team(api, t["id"], c["id"], d, f"{p} A", people(api, d, p, 3))
    _, m = first_team_match(api, c)
    tm = api.get(f"/matches/{m['id']}/team")
    aka_ids = [x["person_id"] for x in tm["aka"]["members"] if x["role"] == "starter"]
    ao_ids = [x["person_id"] for x in tm["ao"]["members"] if x["role"] == "starter"]
    bouts = [x["match"] for x in lineup(api, m["id"], list(zip(aka_ids, ao_ids, strict=True)))["bouts"]]
    for b in bouts[:2]:  # dos victorias de tres: la final se decide sin el tercer combate
        api.event(b["id"], "point", "aka", 2)
        finish(api, b["id"], "aka")
    assert api.get(f"/matches/{m['id']}/team")["match"]["status"] == "finished"
    assert api.get(f"/categories/{c['id']}")["status"] == "finished"
    res = next(r for r in api.get(f"/tournaments/{t['id']}/results") if r["category_id"] == c["id"])
    assert [p["place"] for p in res["places"]] == [1, 2]
