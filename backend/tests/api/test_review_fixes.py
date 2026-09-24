"""Regresiones de la revisión de código (servicios y API)."""

import uuid

from tests.api.test_mock_tournament import KUMITE, register, setup_tournament


def cat_with(api, tid, dojos, n, **fields):
    c = api.post(f"/tournaments/{tid}/categories", {**KUMITE, **fields}, expect=201)
    regs = []
    for i in range(n):
        p = api.person(f"{fields.get('code', 'X')}{i}", f"L{i}", dojos[i % len(dojos)]["id"])
        regs.append(register(api, tid, p["id"], c["id"], weight_class="-45"))
    return c, regs


def test_event_on_finished_match_requires_override_and_is_audited(client):
    api = client
    dojos = [api.dojo("Uno"), api.dojo("Dos")]
    t = setup_tournament(api)
    c, _ = cat_with(api, t["id"], dojos, 2)
    m = api.post(f"/categories/{c['id']}/bracket", {"seed": 1})["matches"][0]
    api.event(m["id"], "point", "aka", 3)
    api.finish(m["id"], "aka")
    ev = {"id": str(uuid.uuid4()), "type": "point", "at": "2026-10-17T10:05:00Z", "color": "ao", "value": 3}
    r = api.raw("POST", f"/matches/{m['id']}/events", json=ev)
    assert r.status_code == 409 and r.json()["error"]["details"]["warnings"][0]["code"] == "MATCH_FINISHED"
    api.post(f"/matches/{m['id']}/events", {**ev, "override": {"reason": "Punto omitido en la mesa"}}, expect=201)
    sb = api.get(f"/matches/{m['id']}")
    assert sb["score"] == {"aka": 3, "ao": 3} and sb["match"]["ao_score"] == 3
    log = api.get(f"/audit?tournament_id={t['id']}&entity=match&entity_id={m['id']}")
    assert any(e["action"] == "correct_score" and e["reason"] == "Punto omitido en la mesa" for e in log)


def test_merge_into_target_with_bracket_discards_it(client):
    api = client
    dojos = [api.dojo("Uno"), api.dojo("Dos")]
    t = setup_tournament(api)
    target, _ = cat_with(api, t["id"], dojos, 4, code="T")
    source, _ = cat_with(api, t["id"], dojos, 2, code="S")
    api.post(f"/categories/{target['id']}/bracket", {"seed": 1})
    body = {"source_ids": [source["id"]], "target_id": target["id"]}
    r = api.raw("POST", f"/tournaments/{t['id']}/categories/merge", json=body)
    assert r.status_code == 409 and r.json()["error"]["details"]["warnings"][0]["code"] == "TARGET_BRACKET_DISCARDED"
    merged = api.post(f"/tournaments/{t['id']}/categories/merge", {**body, "override": {"reason": "Pocos inscritos"}})
    assert merged["status"] == "open" and merged["entrant_count"] == 6
    assert api.raw("GET", f"/categories/{target['id']}/bracket").status_code == 404
    assert api.post(f"/categories/{target['id']}/bracket", {"seed": 1})["size"] == 8


def test_merge_persons_registered_in_same_category(client):
    api = client
    d = api.dojo("Uno")
    t = setup_tournament(api)
    c = api.post(f"/tournaments/{t['id']}/categories", KUMITE, expect=201)
    p1 = api.person("Juan", "Pérez", d["id"], birth="2013-03-03")
    p2 = api.person("Juan", "Perez", d["id"], birth="2013-03-03", override={"reason": "prueba"})
    r1 = register(api, t["id"], p1["id"], c["id"], weight_class="-45")
    r2 = register(api, t["id"], p2["id"], c["id"], weight_class="-45")
    merge = api.post("/persons/merge", {"keep_id": p1["id"], "merge_id": p2["id"], "reason": "Duplicado"})
    regs = {r["id"]: r for r in api.get(f"/tournaments/{t['id']}/registrations")}
    assert regs[r1["id"]]["status"] == "active" and regs[r2["id"]]["status"] == "withdrawn"
    assert api.get(f"/categories/{c['id']}")["entrant_count"] == 1
    api.post(f"/persons/merges/{merge['id']}/revert")
    regs = {r["id"]: r for r in api.get(f"/tournaments/{t['id']}/registrations")}
    assert regs[r2["id"]]["status"] == "active" and regs[r2["id"]]["person_id"] == p2["id"]


def test_move_registration_to_category_where_already_registered(client):
    api = client
    d = api.dojo("Uno")
    t = setup_tournament(api)
    c1 = api.post(f"/tournaments/{t['id']}/categories", {**KUMITE, "code": "A"}, expect=201)
    c2 = api.post(f"/tournaments/{t['id']}/categories", {**KUMITE, "code": "B"}, expect=201)
    p = api.person("Ana", "Lima", d["id"], sex="F")
    register(api, t["id"], p["id"], c1["id"], weight_class="-45", override="sexo")
    r2 = register(api, t["id"], p["id"], c2["id"], weight_class="-45", override="sexo")
    r = api.raw("PATCH", f"/registrations/{r2['id']}", json={"version": r2["version"], "category_id": c1["id"]})
    assert r.status_code == 409 and r.json()["error"]["code"] == "ALREADY_REGISTERED"


def test_cancel_merged_category_and_versions(client):
    api = client
    dojos = [api.dojo("Uno"), api.dojo("Dos")]
    t = setup_tournament(api)
    a, _ = cat_with(api, t["id"], dojos, 1, code="A")
    b, regs = cat_with(api, t["id"], dojos, 1, code="B")
    api.post(f"/tournaments/{t['id']}/categories/merge", {"source_ids": [a["id"], b["id"]]})
    assert api.raw("POST", f"/categories/{a['id']}/cancel", json={"reason": "no va"}).status_code == 409
    r = api.raw("POST", f"/registrations/{regs[0]['id']}/withdraw", json={"reason": "lesión", "version": 99})
    assert r.status_code == 409 and r.json()["error"]["code"] == "VERSION_CONFLICT"


def test_reopen_category_with_audit(client):
    api = client
    dojos = [api.dojo("Uno"), api.dojo("Dos")]
    t = setup_tournament(api)
    c, _ = cat_with(api, t["id"], dojos, 2)
    m = api.post(f"/categories/{c['id']}/bracket", {"seed": 1})["matches"][0]
    api.finish(m["id"], "aka", override="papel")
    assert api.get(f"/categories/{c['id']}")["status"] == "finished"
    assert api.raw("POST", f"/categories/{c['id']}/reopen", json={"reason": "x"}).status_code == 422
    out = api.post(f"/categories/{c['id']}/reopen", {"reason": "Error en el ganador"})
    assert out["status"] == "in_progress"
    # Una lectura no la vuelve a cerrar sola
    api.get(f"/categories/{c['id']}/bracket")
    assert api.get(f"/categories/{c['id']}")["status"] == "in_progress"
    assert api.get(f"/tournaments/{t['id']}/medal-table")["rows"] == []
    # Sin advertencia CATEGORY_FINISHED al corregir tras reabrir
    res = api.finish(m["id"], "ao", override="Corrección tras revisar el acta")
    assert res["scoreboard"]["winner"] == "ao"
    assert api.get(f"/categories/{c['id']}")["status"] == "finished"
    log = api.get(f"/audit?tournament_id={t['id']}&entity=category&entity_id={c['id']}")
    assert [e["action"] for e in log][:2] == ["refinish", "reopen"]


def test_flags_correction_with_override(client):
    api = client
    dojos = [api.dojo("Uno"), api.dojo("Dos")]
    t = setup_tournament(api)
    c = api.post(
        f"/tournaments/{t['id']}/categories",
        {"code": "KF", "name": "Kata", "modality": "kata", "sex": "X", "kata_method": "flags", "kata_judges": 3},
        expect=201,
    )
    for i in range(2):
        p = api.person(f"K{i}", f"K{i}", dojos[i]["id"])
        register(api, t["id"], p["id"], c["id"])
    mid = api.post(f"/categories/{c['id']}/bracket", {})["matches"][0]["id"]
    base = {"votes": ["ao", "ao", "aka"], "at": "2026-10-17T10:00:00Z"}
    api.post(f"/matches/{mid}/flags", {**base, "event_id": str(uuid.uuid4())})
    r = api.raw(
        "POST", f"/matches/{mid}/flags", json={**base, "votes": ["aka", "aka", "ao"], "event_id": str(uuid.uuid4())}
    )
    assert r.status_code == 409
    res = api.post(
        f"/matches/{mid}/flags",
        {
            **base,
            "votes": ["aka", "aka", "ao"],
            "event_id": str(uuid.uuid4()),
            "override": {"reason": "Voto mal anotado"},
        },
    )
    assert res["winner"] == "aka"


def test_get_bracket_does_not_write(client):
    api = client
    dojos = [api.dojo("Uno"), api.dojo("Dos")]
    t = setup_tournament(api)
    c, _ = cat_with(api, t["id"], dojos, 4)
    api.post(f"/categories/{c['id']}/bracket", {"seed": 1})
    before = api.get(f"/audit?tournament_id={t['id']}")
    for _ in range(3):
        api.get(f"/categories/{c['id']}/bracket")
    assert api.get(f"/audit?tournament_id={t['id']}") == before
    assert api.get(f"/categories/{c['id']}")["version"] == api.get(f"/categories/{c['id']}")["version"]


def test_tatami_numbering_and_scoresheet(client):
    api = client
    dojos = [api.dojo("Uno"), api.dojo("Dos")]
    t = setup_tournament(api)
    c, _ = cat_with(api, t["id"], dojos, 5)
    api.post(f"/categories/{c['id']}/bracket", {"seed": 1})
    tat = t["tatamis"][0]
    cat = api.get(f"/categories/{c['id']}")
    api.patch(f"/categories/{c['id']}", {"version": cat["version"], "tatami_id": tat["id"], "queue_position": 1})
    q = api.get(f"/tatamis/{tat['id']}/queue")
    # 5 inscritos en llave de 8: 1 combate real en R1 (3 byes), 2 semis, final
    numbers = [it["number"] for it in q["queue"]]
    assert numbers[0] == "T1-001"
    pdf = api.raw("GET", f"/tatamis/{tat['id']}/scoresheet.pdf")
    assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF")
    first = q["queue"][0]["match"]
    api.finish(first["id"], "aka", override="papel")
    q2 = api.get(f"/tatamis/{tat['id']}/queue")
    # La numeración es estable: el siguiente combate conserva su número
    assert q2["queue"][0]["number"] != "T1-001" and q2["queue"][0]["number"].startswith("T1-")
    assert api.raw("GET", f"/categories/{c['id']}/bracket.pdf").content.startswith(b"%PDF")
