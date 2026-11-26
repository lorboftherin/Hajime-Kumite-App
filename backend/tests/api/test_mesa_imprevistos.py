"""Imprevistos de un torneo chico que la mesa resuelve sin salir de la mesa
(prueba en vivo de noviembre): repartir categorías entre tatamis, ordenar por
código, inscribir a quien llega tarde y cambiar a tiempo corrido."""

import uuid
from datetime import UTC, datetime

from tests.api.test_mock_tournament import register, setup_tournament
from tests.api.test_permissions import login_as


def cat(api, tid, code, sex, age_min, age_max, modality="kumite"):
    return api.post(
        f"/tournaments/{tid}/categories",
        {
            "code": code,
            "name": f"{code} {sex} {age_min}-{age_max}",
            "modality": modality,
            "sex": sex,
            "age_min": age_min,
            "age_max": age_max,
        },
        expect=201,
    )


def mesa_de(api, tatami_id, username):
    d = api.dojo(f"Dojo {username}")
    p = api.person("Mesa", username, d["id"])
    api.post(
        f"/persons/{p['id']}/roles",
        {"role": "table_operator", "scope_type": "tatami", "scope_id": tatami_id},
        expect=201,
    )
    return login_as(api, username, person_id=p["id"])


def test_mesa_reparte_tatamis_y_ordena_por_codigo(client):
    api = client
    t = setup_tournament(api, tatami_count=2)
    t1, t2 = (x["id"] for x in t["tatamis"])
    cats = {
        code: cat(api, t["id"], code, sex, 8, 9) for code, sex in (("B2", "F"), ("A1", "M"), ("B1", "M"), ("A2", "F"))
    }
    hdr = mesa_de(api, t2, "mesa2")
    # El coordinador decide: hombres al tatami 2, mujeres al 1.
    body = {
        "assignments": [
            {"category_id": cats[c]["id"], "tatami_id": t2 if c in ("A1", "B1") else t1}
            for c in ("B2", "A1", "B1", "A2")
        ]
    }
    r = api.raw("PUT", f"/tournaments/{t['id']}/tatami-plan", json=body, headers=hdr)
    assert r.status_code == 200, r.text
    q = r.json()["queues"]
    ids = {v["id"]: k for k, v in cats.items()}
    assert [ids[x] for x in q[str(t1)]] == ["A2", "B2"] and [ids[x] for x in q[str(t2)]] == ["A1", "B1"]
    # La mesa también reordena a mano y vuelve al orden por código.
    r = api.raw("PUT", f"/tatamis/{t1}/queue", json={"category_ids": [cats["B2"]["id"], cats["A2"]["id"]]}, headers=hdr)
    assert r.status_code == 200
    r = api.raw("POST", f"/tatamis/{t1}/queue/sort-by-code", headers=hdr)
    assert [c["code"] for c in r.json()] == ["A2", "B2"]
    queue = api.raw("GET", f"/tatamis/{t2}/queue", headers=hdr).json()
    assert queue["tatami"]["tournament_id"] == t["id"]
    # Alguien sin rol en el torneo no reparte.
    otro = login_as(api, "curioso")
    assert api.raw("PUT", f"/tournaments/{t['id']}/tatami-plan", json=body, headers=otro).status_code == 403


def test_inscripcion_tardia_desde_la_mesa(client):
    api = client
    t = setup_tournament(api)
    tat = t["tatamis"][0]["id"]
    d = api.dojo("Sede Norte")
    tres = cat(api, t["id"], "B7", "M", 6, 7)
    solo = cat(api, t["id"], "B9", "F", 6, 7)
    for c in (tres, solo):
        api.patch(f"/categories/{c['id']}", {"tatami_id": tat, "version": c["version"]})
    for i in range(3):
        register(api, t["id"], api.person(f"Niño{i}", "Paz", d["id"], sex="M")["id"], tres["id"], override="prueba")
    register(api, t["id"], api.person("Niña", "Luz", d["id"], sex="F")["id"], solo["id"], override="prueba")
    api.post(f"/categories/{tres['id']}/bracket", {"seed": 1})
    api.patch(
        f"/tournaments/{t['id']}/status",
        {"status": "registration_closed", "version": api.get(f"/tournaments/{t['id']}")["version"]},
    )
    hdr = mesa_de(api, tat, "mesa1")
    # Llega un niño sin inscribir: ocupa el bye libre de B7 sin mover a nadie.
    body = {
        "first_names": "Tardío",
        "last_names": "Ruiz",
        "sex": "M",
        "age": 7,
        "dojo_id": d["id"],
        "category_ids": [tres["id"]],
    }
    r = api.raw("POST", f"/tatamis/{tat}/late-entry", json=body, headers=hdr)
    assert r.status_code == 200, r.text
    assert r.json()["results"][0]["mode"] == "bye" and r.json()["results"][0]["reprint"] is True
    b = api.get(f"/categories/{tres['id']}/bracket")
    assert len(b["participants"]) == 4 and not [m for m in b["matches"] if m["status"] == "bye"]
    # Llega una niña a B9 (estaba sola): ahora hay llave.
    body = {
        "first_names": "Nueva",
        "last_names": "Soto",
        "sex": "F",
        "age": 6,
        "dojo_id": d["id"],
        "category_ids": [solo["id"]],
    }
    r = api.raw("POST", f"/tatamis/{tat}/late-entry", json=body, headers=hdr)
    assert r.json()["results"][0]["mode"] == "generated"
    assert len(api.get(f"/categories/{solo['id']}/bracket")["participants"]) == 2
    # Llave de 4 llena y sin empezar: se vuelve a sortear con el quinto.
    body["first_names"], body["sex"], body["category_ids"] = "Quinto", "M", [tres["id"]]
    r = api.raw("POST", f"/tatamis/{tat}/late-entry", json=body, headers=hdr)
    assert r.json()["results"][0]["mode"] == "regenerated"
    assert len(api.get(f"/categories/{tres['id']}/bracket")["participants"]) == 5


def test_tiempo_corrido_por_tatami_rige_desde_el_siguiente_combate(client):
    api = client
    t = setup_tournament(api)
    tat = t["tatamis"][0]["id"]
    d1, d2 = api.dojo("Uno"), api.dojo("Dos")
    c = cat(api, t["id"], "B3", "M", 8, 9)
    api.patch(f"/categories/{c['id']}", {"tatami_id": tat, "version": c["version"]})
    for i in range(4):
        register(
            api, t["id"], api.person(f"K{i}", "Lima", (d1, d2)[i % 2]["id"], sex="M")["id"], c["id"], override="prueba"
        )
    ms = [m for m in api.post(f"/categories/{c['id']}/bracket", {"seed": 1})["matches"] if m["status"] == "ready"]
    hdr = mesa_de(api, tat, "mesa3")
    now = datetime.now(UTC).isoformat()
    api.post(f"/matches/{ms[0]['id']}/events", {"id": str(uuid.uuid4()), "type": "start", "at": now}, expect=201)
    r = api.raw("PUT", f"/tatamis/{tat}/clock", json={"time_mode": "running"}, headers=hdr)
    assert r.status_code == 200 and r.json()["time_mode"] == "running"
    # El combate ya empezado conserva su modo; el siguiente usa el del tatami.
    assert api.get(f"/matches/{ms[0]['id']}")["rules"]["time_mode"] == "effective"
    assert api.get(f"/matches/{ms[1]['id']}")["rules"]["time_mode"] == "running"
    api.post(f"/matches/{ms[1]['id']}/events", {"id": str(uuid.uuid4()), "type": "start", "at": now}, expect=201)
    api.raw("PUT", f"/tatamis/{tat}/clock", json={"time_mode": None}, headers=hdr)
    assert api.get(f"/matches/{ms[1]['id']}")["rules"]["time_mode"] == "running"
