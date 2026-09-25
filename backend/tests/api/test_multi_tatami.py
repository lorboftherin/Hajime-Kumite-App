"""MVP-3: varios tatamis con varios operadores a la vez, árbitros y senseis."""

import uuid

from tests.api.test_mock_tournament import KUMITE, register, setup_tournament
from tests.api.test_permissions import login_as


def ev(type_, color=None, value=None, sec=0):
    return {
        "id": str(uuid.uuid4()),
        "type": type_,
        "color": color,
        "value": value,
        "at": f"2026-10-17T10:{sec // 60:02d}:{sec % 60:02d}Z",
    }


def fin(winner, eid=None):
    return {"id": eid or str(uuid.uuid4()), "at": "2026-10-17T10:05:00Z", "winner": winner, "method": "points"}


def two_tatamis(api):
    t = setup_tournament(api, tatami_count=2)
    tats = t["tatamis"]
    d1, d2 = api.dojo("Uno"), api.dojo("Dos")
    matches = []
    for i, tat in enumerate(tats):
        c = api.post(
            f"/tournaments/{t['id']}/categories", {**KUMITE, "code": f"K{i}", "name": f"Kumite {i}"}, expect=201
        )
        c = api.patch(f"/categories/{c['id']}", {"tatami_id": tat["id"], "version": c["version"]})
        for j, d in enumerate((d1, d2)):
            p = api.person(f"T{i}", f"C{j}", d["id"])
            register(api, t["id"], p["id"], c["id"], weight_class="-45")
        matches.append(api.post(f"/categories/{c['id']}/bracket", {"seed": 1})["matches"][0])
    return t, tats, matches


def operator(api, username, tatami_id):
    d = api.dojo(f"Op {username}")
    p = api.person("Mesa", username, d["id"])
    hdr = login_as(api, username, person_id=p["id"], display_name=f"Mesa {username}")
    api.post(
        f"/persons/{p['id']}/roles",
        {"role": "table_operator", "scope_type": "tatami", "scope_id": tatami_id},
        expect=201,
    )
    return hdr, p


def test_operators_scoped_to_their_tatami_work_in_parallel(client):
    api = client
    t, tats, (m1, m2) = two_tatamis(api)
    h1, _ = operator(api, "uno", tats[0]["id"])
    h2, _ = operator(api, "dos", tats[1]["id"])

    # Cada operador solo toca los combates de su tatami.
    assert api.raw("POST", f"/matches/{m2['id']}/events", json=ev("start"), headers=h1).status_code == 403
    assert api.raw("POST", f"/matches/{m1['id']}/events", json=ev("start"), headers=h2).status_code == 403

    # Los dos tatamis se operan a la vez, con eventos intercalados.
    script = [
        (h1, m1, ev("start", sec=0)),
        (h2, m2, ev("start", sec=1)),
        (h1, m1, ev("point", "aka", 3, sec=10)),
        (h2, m2, ev("point", "ao", 2, sec=12)),
        (h1, m1, ev("resume", sec=15)),
        (h2, m2, ev("resume", sec=16)),
        (h2, m2, ev("point", "ao", 1, sec=30)),
    ]
    for hdr, m, body in script:
        assert api.raw("POST", f"/matches/{m['id']}/events", json=body, headers=hdr).status_code == 201
    assert api.raw("POST", f"/matches/{m1['id']}/finish", json=fin("aka"), headers=h1).status_code == 200
    assert api.raw("POST", f"/matches/{m2['id']}/finish", json=fin("ao"), headers=h2).status_code == 200
    s1, s2 = api.get(f"/matches/{m1['id']}"), api.get(f"/matches/{m2['id']}")
    assert (s1["score"], s1["winner"]) == ({"aka": 3, "ao": 0}, "aka")
    assert (s2["score"], s2["winner"]) == ({"aka": 0, "ao": 3}, "ao")
    q = api.get(f"/tatamis/{tats[0]['id']}/queue")
    assert q["progress"] == {"done": 1, "total": 1} and q["assigned_operators"] == ["Mesa uno"]

    # Solo el operador de mesa se asigna a un tatami, y el tatami debe existir.
    pid = api.person("Otro", "Rol", api.dojo("R")["id"])["id"]
    r = api.raw(
        "POST", f"/persons/{pid}/roles", json={"role": "organizer", "scope_type": "tatami", "scope_id": tats[0]["id"]}
    )
    assert r.status_code == 409
    r = api.raw(
        "POST", f"/persons/{pid}/roles", json={"role": "table_operator", "scope_type": "tatami", "scope_id": 999}
    )
    assert r.status_code == 404


def test_two_tablets_on_the_same_match_are_warned_and_never_overwrite(client):
    api = client
    t, tats, (m1, _) = two_tatamis(api)
    h1, _ = operator(api, "uno", tats[0]["id"])
    h2, _ = operator(api, "otra", tats[0]["id"])

    first = api.raw("POST", f"/matches/{m1['id']}/presence", json={"device_id": "tablet-uno"}, headers=h1).json()
    assert first["others"] == []
    second = api.raw("POST", f"/matches/{m1['id']}/presence", json={"device_id": "tablet-dos"}, headers=h2).json()
    assert [o["user"] for o in second["others"]] == ["Mesa uno"]
    ops = api.get(f"/tatamis/{tats[0]['id']}/queue")["operators"]
    assert sorted(o["user"] for o in ops) == ["Mesa otra", "Mesa uno"]

    # El mismo evento reenviado por ambas tablets se guarda una sola vez.
    e = ev("start")
    assert api.raw("POST", f"/matches/{m1['id']}/events", json=e, headers=h1).status_code == 201
    assert api.raw("POST", f"/matches/{m1['id']}/events", json=e, headers=h2).status_code == 200
    # La segunda tablet no puede pisar el cierre de la primera sin confirmar y dejar motivo.
    assert api.raw("POST", f"/matches/{m1['id']}/finish", json=fin("aka"), headers=h1).status_code == 200
    r = api.raw("POST", f"/matches/{m1['id']}/finish", json=fin("ao"), headers=h2)
    assert r.status_code == 409 and "WINNER_CHANGE" in {w["code"] for w in r.json()["error"]["details"]["warnings"]}
    assert api.get(f"/matches/{m1['id']}")["winner"] == "aka"

    api.raw("DELETE", f"/matches/{m1['id']}/presence?device_id=tablet-uno", headers=h1)
    again = api.raw("POST", f"/matches/{m1['id']}/presence", json={"device_id": "tablet-dos"}, headers=h2).json()
    assert again["others"] == []


def test_referees_registry_and_optional_assignment(client):
    api = client
    t, tats, (m1, _) = two_tatamis(api)
    ref = api.post("/persons", {"first_names": "Rosa", "last_names": "Árbitra", "sex": "F"}, expect=201)
    ref2 = api.post("/persons", {"first_names": "Luis", "last_names": "Juez", "sex": "M"}, expect=201)
    ov = api.post(f"/tournaments/{t['id']}/referees", {"person_id": ref["id"]})
    assert [r["name"] for r in ov["referees"]] == ["Rosa Árbitra"]  # sin dojo, sin problema

    body = {"person_id": ref["id"], "target_type": "tatami", "target_id": tats[0]["id"], "position": "Árbitro central"}
    ov = api.post(f"/tournaments/{t['id']}/referee-assignments", body)
    assert ov["assignments"][0]["target"] == tats[0]["name"]
    assert api.raw("POST", f"/tournaments/{t['id']}/referee-assignments", json=body).status_code == 409
    # Asignar a alguien no registrado lo registra como árbitro del torneo.
    ov = api.post(
        f"/tournaments/{t['id']}/referee-assignments",
        {"person_id": ref2["id"], "target_type": "match", "target_id": m1["id"], "position": "Juez 1"},
    )
    assert {r["name"] for r in ov["referees"]} == {"Rosa Árbitra", "Luis Juez"}

    q = api.get(f"/tatamis/{tats[0]['id']}/queue")
    assert q["referees"] == [{"name": "Rosa Árbitra", "position": "Árbitro central"}]
    mr = api.get(f"/matches/{m1['id']}/referees")
    assert [(a["name"], a["via"]) for a in mr["assigned"]] == [("Luis Juez", "match"), ("Rosa Árbitra", "tatami")]

    # Un operador de mesa no asigna árbitros; el organizador puede quitar asignaciones.
    h1, _ = operator(api, "uno", tats[0]["id"])
    assert api.raw("POST", f"/tournaments/{t['id']}/referee-assignments", json=body, headers=h1).status_code == 403
    aid = ov["assignments"][0]["id"]
    assert len(api.c.delete(f"/api/v1/referee-assignments/{aid}").json()["assignments"]) == 1


def test_sensei_is_registered_in_their_dojo(client):
    api = client
    d = api.dojo("Kaze")
    p = api.person("Hiro", "Sensei", d["id"])
    api.post(f"/persons/{p['id']}/roles", {"role": "sensei", "scope_type": "dojo", "scope_id": d["id"]}, expect=201)
    assert api.get(f"/dojos/{d['id']}/history")["senseis"] == [{"person_id": p["id"], "name": "Hiro Sensei"}]
    r = api.raw("POST", f"/persons/{p['id']}/roles", json={"role": "sensei", "scope_type": "tournament", "scope_id": 1})
    assert r.status_code == 409


def test_excel_import_registers_referees_and_senseis(client):
    from tests.api.test_mock_tournament import _xlsx

    api = client
    t = setup_tournament(api)
    tid = t["id"]
    c = api.post(f"/tournaments/{tid}/categories", {**KUMITE, "code": "KF", "sex": "F", "name": "Kumite F"}, expect=201)
    content = _xlsx(
        [
            ["Dojo Kaze", "", "", "", "Ana", "Competidora", "10/10/2013", "F", "8 kyu", "-45", "kumite", ""],
            ["", "", "", "", "Rosa", "Árbitra", "", "F", "", "", "", "árbitro"],
            ["Dojo Kaze", "", "", "", "Hiro", "Maestro", "01/01/1980", "M", "3 dan", "", "", "sensei, árbitro"],
            ["Dojo Kaze", "", "", "", "Mal", "Rol", "", "M", "", "", "", "entrenador"],
        ]
    )
    batch = api.post(
        f"/tournaments/{tid}/imports", files={"file": ("staff.xlsx", content, "application/octet-stream")}, expect=201
    )
    rows = batch["rows"]
    assert [r["status"] for r in rows] == ["new", "new", "new", "error"]
    assert rows[0]["suggested_category_ids"] == [c["id"]] and rows[1]["suggested_category_ids"] == []
    assert "Rol inválido: entrenador" in rows[3]["errors"]
    res = api.post(f"/imports/{batch['id']}/confirm", {"decisions": []})
    assert res == {"created_people": 3, "registrations": 1, "skipped": 1}
    refs = {r["name"] for r in api.get(f"/tournaments/{tid}/referees")["referees"]}
    assert refs == {"Rosa Árbitra", "Hiro Maestro"}
    dojo = next(d for d in api.get("/dojos") if d["name"] == "Dojo Kaze")
    assert [s["name"] for s in api.get(f"/dojos/{dojo['id']}/history")["senseis"]] == ["Hiro Maestro"]
