"""Herramientas del organizador: walkover por retiro, cola de tatami, verificación
previa al inicio y corrección de filas de importación."""

from tests.api.test_mock_tournament import KUMITE, _xlsx, register, setup_tournament


def _category(api, tid, code, **kw):
    return api.post(
        f"/tournaments/{tid}/categories", {**KUMITE, "code": code, "name": f"Kumite {code}", **kw}, expect=201
    )


def _fill(api, tid, cid, n, tag):
    d = api.dojo(f"D{tag}")
    return [
        register(api, tid, api.person(f"{tag}{i}", "Prueba", d["id"])["id"], cid, weight_class="-45") for i in range(n)
    ]


def _audit(api, tid):
    return api.get("/audit", params={"tournament_id": tid, "limit": 200})


def test_walkover_in_all_pending_matches_of_a_withdrawn_registration(client):
    api = client
    t = setup_tournament(api)
    c = _category(api, t["id"], "WO")
    regs = _fill(api, t["id"], c["id"], 4, "W")
    bracket = api.post(f"/categories/{c['id']}/bracket", {"seed": 3})
    first = next(m for m in bracket["matches"] if m["aka_registration_id"] and m["ao_registration_id"])
    quitter = first["aka_registration_id"]
    rival = first["ao_registration_id"]

    # Con la inscripción activa no se da walkover.
    r = api.raw("POST", f"/registrations/{quitter}/walkover", json={})
    assert r.status_code == 409

    res = api.post(f"/registrations/{quitter}/withdraw", {"reason": "Lesión"})
    assert "walkover" in res["options"]
    out = api.post(f"/registrations/{quitter}/walkover", {"reason": "Lesión en el calentamiento"})
    assert out["walkover_matches"] == [first["code"]]
    sb = api.get(f"/matches/{first['id']}")
    assert sb["match"]["status"] == "finished" and sb["method"] == "walkover"
    assert sb["match"]["winner_registration_id"] == rival
    assert any(a["action"] == "walkover" and a["entity_id"] == str(quitter) for a in _audit(api, t["id"]))
    # Repetir no hace nada (no quedan combates suyos pendientes).
    assert api.post(f"/registrations/{quitter}/walkover", {})["walkover_matches"] == []
    assert {r["id"] for r in regs} >= {quitter, rival}


def test_tatami_queue_is_replaced_in_one_transaction(client):
    api = client
    t = setup_tournament(api, tatami_count=2)
    t1, t2 = t["tatamis"]
    c1, c2, c3 = (_category(api, t["id"], code) for code in ("Q1", "Q2", "Q3"))

    out = api.c.put(f"/api/v1/tatamis/{t1['id']}/queue", json={"category_ids": [c2["id"], c1["id"]]})
    assert out.status_code == 200, out.text
    assert [(c["id"], c["tatami_id"], c["queue_position"]) for c in out.json()] == [
        (c2["id"], t1["id"], 1),
        (c1["id"], t1["id"], 2),
    ]
    # Mover una categoría a otro tatami la saca de la cola anterior.
    out = api.c.put(f"/api/v1/tatamis/{t2['id']}/queue", json={"category_ids": [c1["id"], c3["id"]]}).json()
    assert [c["id"] for c in out] == [c1["id"], c3["id"]]
    left = api.c.put(f"/api/v1/tatamis/{t1['id']}/queue", json={"category_ids": [c2["id"]]}).json()
    assert [c["id"] for c in left] == [c2["id"]]
    # Quitar todas deja la categoría sin tatami.
    assert api.c.put(f"/api/v1/tatamis/{t1['id']}/queue", json={"category_ids": []}).json() == []
    assert api.get(f"/categories/{c2['id']}")["tatami_id"] is None

    # Todo o nada: repetidas, inexistentes o de otro torneo no cambian nada.
    other = setup_tournament(api)
    foreign = _category(api, other["id"], "X1")
    for bad, code in (([c3["id"], c3["id"]], 409), ([c3["id"], 99999], 404), ([c3["id"], foreign["id"]], 409)):
        assert api.c.put(f"/api/v1/tatamis/{t2['id']}/queue", json={"category_ids": bad}).status_code == code
    assert [c["id"] for c in api.get(f"/tournaments/{t['id']}/categories") if c["tatami_id"] == t2["id"]] == [
        c1["id"],
        c3["id"],
    ]
    assert any(a["action"] == "queue" and a["entity"] == "tatami" for a in _audit(api, t["id"]))


def test_readiness_lists_problems_by_severity(client):
    api = client
    t = setup_tournament(api)
    no_bracket = _category(api, t["id"], "R1")
    _fill(api, t["id"], no_bracket["id"], 2, "A")
    single = _category(api, t["id"], "R2")
    _fill(api, t["id"], single["id"], 1, "B")
    with_bracket = _category(api, t["id"], "R3")
    _fill(api, t["id"], with_bracket["id"], 2, "C")
    api.post(f"/categories/{with_bracket['id']}/bracket", {"seed": 1})

    r = api.get(f"/tournaments/{t['id']}/readiness")
    by_code = {i["code"]: i for i in r["issues"]}
    assert r["ready"] is False
    assert by_code["NO_BRACKET"]["severity"] == "error"
    assert by_code["NO_BRACKET"]["category_ids"] == [no_bracket["id"]]
    assert by_code["SINGLE_ENTRANT"]["category_ids"] == [single["id"]]
    assert by_code["NO_TATAMI"]["category_ids"] == [with_bracket["id"]]
    assert by_code["TATAMI_WITHOUT_OPERATOR"]["severity"] == "warning"
    # Los competidores de prueba nacieron en 2013: menores sin consentimiento registrado.
    assert by_code["MINOR_WITHOUT_CONSENT"]["severity"] == "warning"
    assert "1 categoría con inscritos no tiene llave" in by_code["NO_BRACKET"]["message"]
    # Los errores van primero.
    sev = [i["severity"] for i in r["issues"]]
    assert sev == sorted(sev, key={"error": 0, "warning": 1, "info": 2}.get)

    # Resuelto lo bloqueante, queda lista (con avisos).
    api.post(f"/categories/{no_bracket['id']}/bracket", {"seed": 1})
    tat = t["tatamis"][0]["id"]
    api.c.put(f"/api/v1/tatamis/{tat}/queue", json={"category_ids": [no_bracket["id"], with_bracket["id"]]})
    api.post(f"/categories/{single['id']}/cancel", {"reason": "Un solo inscrito"})
    r = api.get(f"/tournaments/{t['id']}/readiness")
    assert r["ready"] is True
    assert {"NO_BRACKET", "NO_TATAMI", "SINGLE_ENTRANT"}.isdisjoint({i["code"] for i in r["issues"]})


def test_import_row_can_be_corrected_and_revalidated(client):
    api = client
    t = setup_tournament(api)
    tid = t["id"]
    c = _category(api, tid, "IMP", sex="F")
    content = _xlsx([["Dojo Sur", "", "", "", "Rosa", "", "xx", "F", "8 kyu", "-45", "kumite"]])
    batch = api.post(
        f"/tournaments/{tid}/imports", files={"file": ("l.xlsx", content, "application/octet-stream")}, expect=201
    )
    row = batch["rows"][0]
    assert row["status"] == "error" and row["suggested_category_ids"] == []

    fixed = api.c.patch(
        f"/api/v1/imports/{batch['id']}/rows/{row['id']}",
        json={"data": {"apellidos": "Huamán", "fecha_nacimiento": "03/03/2013"}},
    )
    assert fixed.status_code == 200, fixed.text
    row = fixed.json()["rows"][0]
    assert row["status"] == "new" and row["errors"] == [], row["errors"]
    assert row["data"]["apellidos"] == "Huamán" and row["data"]["fecha_nacimiento"] == "2013-03-03"
    assert row["data"]["modalidades"] == ["kumite"]  # lo demás se conserva
    assert row["suggested_category_ids"] == [c["id"]]

    # Una corrección que rompe la fila la vuelve a marcar con error.
    broken = api.c.patch(f"/api/v1/imports/{batch['id']}/rows/{row['id']}", json={"data": {"sexo": "Z"}}).json()
    assert broken["rows"][0]["status"] == "error"
    api.c.patch(f"/api/v1/imports/{batch['id']}/rows/{row['id']}", json={"data": {"sexo": "F"}})

    assert api.c.patch(f"/api/v1/imports/{batch['id']}/rows/99999", json={"data": {}}).status_code == 404
    res = api.post(f"/imports/{batch['id']}/confirm", {"decisions": []})
    assert res["registrations"] == 1
    # Confirmada, ya no se edita.
    assert api.c.patch(f"/api/v1/imports/{batch['id']}/rows/{row['id']}", json={"data": {}}).status_code == 409


def test_category_basic_fields_are_editable(client):
    api = client
    t = setup_tournament(api)
    c = _category(api, t["id"], "ED")
    out = api.patch(
        f"/categories/{c['id']}",
        {
            "version": c["version"],
            "name": "Kumite 12-14 F",
            "sex": "F",
            "age_min": 12,
            "age_max": 14,
            "grade_min": 2,
            "grade_max": 6,
            "weight_class": "-50",
            "duration_seconds": 120,
        },
    )
    assert (
        out["name"],
        out["sex"],
        out["age_max"],
        out["grade_min"],
        out["weight_class"],
        out["duration_seconds"],
    ) == (
        "Kumite 12-14 F",
        "F",
        14,
        2,
        "-50",
        120,
    )
