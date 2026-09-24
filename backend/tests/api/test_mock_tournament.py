"""Guion del torneo mock (sección 27) contra la API completa."""

import io
import uuid

from openpyxl import Workbook

KUMITE = {
    "code": "KU-12-13-M-45",
    "name": "Kumite 12-13 Masculino -45",
    "modality": "kumite",
    "sex": "M",
    "age_min": 12,
    "age_max": 13,
    "grade_min": 1,
    "grade_max": 4,  # 10 kyu .. 7 kyu
    "weight_class": "-45",
    "duration_seconds": 90,
}


def setup_tournament(api, **kw):
    t = api.post(
        "/tournaments",
        {"name": "Mock", "start_date": "2026-10-17", "is_test": True, **kw},
        expect=201,
    )
    t = api.patch(f"/tournaments/{t['id']}/status", {"status": "registration_open", "version": t["version"]})
    return t


def register(api, tid, pid, cid, override=None, expect=201, **kw):
    body = {"person_id": pid, "category_id": cid, **kw}
    if override:
        body["override"] = {"reason": override}
    return api.post(f"/tournaments/{tid}/registrations", body, expect=expect)


def test_auth_required(client):
    r = client.c.get("/api/v1/tournaments", headers={"Authorization": ""})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "UNAUTHORIZED"


def test_duplicate_person_warning_and_merge(client):
    api = client
    d = api.dojo("Dojo A")
    p1 = api.person("José Luis", "Pérez García", d["id"], birth="2014-05-01")
    r = api.raw(
        "POST",
        "/persons",
        json={"first_names": "Jose Luis", "last_names": "Perez Garcia", "sex": "M", "birth_date": "2014-05-01"},
    )
    assert r.status_code == 409
    err = r.json()["error"]
    assert err["code"] == "WARNINGS" and err["details"]["duplicates"][0]["person_id"] == p1["id"]
    p2 = api.person(
        "Jose Luis",
        "Perez Garcia",
        d["id"],
        birth="2014-05-01",
        override={"reason": "Operador confirma que es otra persona"},
    )
    t = setup_tournament(api)
    c = api.post(f"/tournaments/{t['id']}/categories", KUMITE, expect=201)
    reg = register(api, t["id"], p2["id"], c["id"], weight_class="-45")
    merged = api.post("/persons/merge", {"keep_id": p1["id"], "merge_id": p2["id"], "reason": "Duplicado"})
    assert merged["moved"]["registrations"] == [reg["id"]]
    regs = api.get(f"/tournaments/{t['id']}/registrations?person_id={p1['id']}")
    assert len(regs) == 1
    api.post(f"/persons/merges/{merged['id']}/revert")
    assert api.get(f"/tournaments/{t['id']}/registrations?person_id={p2['id']}")[0]["id"] == reg["id"]


def test_override_is_required_and_recorded(client):
    api = client
    d = api.dojo("Dojo A")
    p = api.person("Ana", "Soto", d["id"], grade="3 kyu")  # baja de nivel en 10-7 kyu
    t = setup_tournament(api)
    c = api.post(f"/tournaments/{t['id']}/categories", KUMITE, expect=201)
    r = api.raw("POST", f"/tournaments/{t['id']}/registrations", json={"person_id": p["id"], "category_id": c["id"]})
    assert r.status_code == 409
    codes = {w["code"] for w in r.json()["error"]["details"]["warnings"]}
    assert "GRADE_ABOVE_MAX" in codes
    reg = register(api, t["id"], p["id"], c["id"], override="Autorizado por el organizador", weight_class="-45")
    ov = api.get(f"/overrides?entity=registration&entity_id={reg['id']}")
    assert any(o["code"] == "GRADE_ABOVE_MAX" and o["reason"] == "Autorizado por el organizador" for o in ov)


def test_full_kumite_flow(client):
    api = client
    dojos = [api.dojo(n) for n in ("Dojo A", "Dojo B", "Dojo C", "Dojo D")]
    t = setup_tournament(api)
    tid = t["id"]
    c = api.post(f"/tournaments/{tid}/categories", KUMITE, expect=201)
    assert c["status"] == "empty"
    # 8 inscritos, 4 del mismo dojo
    owners = [0, 0, 0, 0, 1, 1, 2, 3]
    regs = []
    for i, k in enumerate(owners):
        p = api.person(f"Comp{i}", f"Apellido{i}", dojos[k]["id"])
        regs.append(register(api, tid, p["id"], c["id"], weight_class="-45"))
    assert api.get(f"/categories/{c['id']}")["status"] == "open"

    # Llave: ningún cruce del mismo dojo en primera ronda
    b = api.post(f"/categories/{c['id']}/bracket", {"seed": 42})
    assert b["same_dojo_first_round"] == 0 and b["size"] == 8
    assert len(b["matches"]) == 7
    # Misma semilla -> misma llave (regenerar antes de empezar, con override)
    b2 = api.post(f"/categories/{c['id']}/bracket", {"seed": 42, "override": {"reason": "Regenerar"}})
    assert b2["slots"] == b["slots"] and b2["version_number"] == 2
    assert api.get(f"/categories/{c['id']}")["status"] == "ready"

    # Asignar al tatami y ver la cola
    tat = t["tatamis"][0]
    cat = api.get(f"/categories/{c['id']}")
    api.patch(f"/categories/{c['id']}", {"version": cat["version"], "tatami_id": tat["id"], "queue_position": 1})
    q = api.get(f"/tatamis/{tat['id']}/queue")
    assert len(q["queue"]) == 4

    r1 = {m["code"]: m for m in b2["matches"]}
    m1 = r1["R1-1"]["id"]
    # Error de mesa: punto al color equivocado, deshacer
    e_wrong = api.event(m1, "start")
    wrong = api.event(m1, "point", "ao", 2)
    wrong_id = wrong["events"][-1]["id"]
    api.event(m1, "annul", target_id=wrong_id)
    sb = api.event(m1, "point", "aka", 2)
    assert sb["score"] == {"aka": 2, "ao": 0}
    # Idempotencia: el mismo evento dos veces se guarda una vez
    eid = str(uuid.uuid4())
    api.event(m1, "point", "aka", 1, eid=eid)
    again = api.event(m1, "point", "aka", 1, eid=eid, expect=200)
    assert again["score"]["aka"] == 3
    assert e_wrong["match"]["status"] == "in_progress"
    # Ganador contrario al marcador -> advertencia
    r = api.raw(
        "POST", f"/matches/{m1}/finish", json={"id": str(uuid.uuid4()), "at": "2026-10-17T11:00:00Z", "winner": "ao"}
    )
    assert r.status_code == 409
    api.finish(m1, "aka")

    # Empate -> hantei
    m2 = r1["R1-2"]["id"]
    api.event(m2, "point", "aka", 1)
    sb = api.event(m2, "point", "ao", 1)
    assert sb["suggestion"]["needs"] is None  # aún no terminó el tiempo
    sb = api.event(m2, "hantei", "ao")
    assert sb["suggestion"]["winner"] == "ao"
    api.finish(m2, "ao", method="hantei")

    # Retiro tras publicar la llave -> walkover
    m3 = r1["R1-3"]
    wd = api.post(f"/registrations/{m3['ao_registration_id']}/withdraw", {"reason": "Lesión"})
    assert "walkover" in wd["options"]
    api.finish(m3["id"], "aka", method="walkover")
    api.finish(r1["R1-4"]["id"], "aka", method="points", override="Marcador en papel")

    # Semifinales y final
    b3 = api.get(f"/categories/{c['id']}/bracket")
    by = {m["code"]: m for m in b3["matches"]}
    assert by["R2-1"]["status"] == "ready"
    api.finish(by["R2-1"]["id"], "aka", override="Resultado de papel")
    api.finish(by["R2-2"]["id"], "ao", override="Resultado de papel")
    by = {m["code"]: m for m in api.get(f"/categories/{c['id']}/bracket")["matches"]}
    api.finish(by["R3-1"]["id"], "aka", override="Resultado de papel")
    final = api.get(f"/categories/{c['id']}/bracket")
    assert final["podium"]["complete"]
    assert [p["place"] for p in final["podium"]["places"]] == [1, 2, 3, 3]
    assert api.get(f"/categories/{c['id']}")["status"] == "finished"

    # Corrección tardía: cambiar el ganador de R1-1 muestra combates afectados
    r = api.raw(
        "POST", f"/matches/{m1}/finish", json={"id": str(uuid.uuid4()), "at": "2026-10-17T12:00:00Z", "winner": "ao"}
    )
    assert r.status_code == 409
    msgs = " ".join(w["message"] for w in r.json()["error"]["details"]["warnings"])
    assert "R2-1" in msgs and "R3-1" in msgs
    res = api.finish(m1, "ao", override="El árbitro corrigió el resultado")
    assert set(res["affected_matches"]) == {"R2-1", "R3-1"}
    by = {m["code"]: m for m in api.get(f"/categories/{c['id']}/bracket")["matches"]}
    assert by["R2-1"]["status"] == "needs_review"
    assert api.get(f"/categories/{c['id']}")["status"] == "in_progress"
    # El organizador decide: volver a cerrar R2-1 y la final
    api.finish(by["R2-1"]["id"], "aka", override="Revisado")
    by = {m["code"]: m for m in api.get(f"/categories/{c['id']}/bracket")["matches"]}
    api.finish(by["R3-1"]["id"], "aka", override="Revisado")
    assert api.get(f"/categories/{c['id']}")["status"] == "finished"

    # Medallero, PDF, Excel
    mt = api.get(f"/tournaments/{tid}/medal-table")
    assert sum(r["gold"] for r in mt["rows"]) == 1 and sum(r["bronze"] for r in mt["rows"]) == 2
    pdf = api.raw("GET", f"/categories/{c['id']}/bracket.pdf")
    assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF")
    assert api.raw("GET", f"/tournaments/{tid}/results.xlsx").status_code == 200
    assert api.raw("GET", f"/tournaments/{tid}/results.pdf").content.startswith(b"%PDF")

    # Shadow Mode: registrar resultado oficial distinto -> diferencia
    api.post(f"/matches/{m2}/official-result", {"official_winner_registration_id": by["R1-2"]["aka_registration_id"]})
    rep = api.get(f"/tournaments/{tid}/comparison-report")
    assert rep["compared"] == 1 and len(rep["differences"]) == 1

    # Cerrar y reabrir el torneo con auditoría
    t = api.get(f"/tournaments/{tid}")
    t = api.patch(f"/tournaments/{tid}/status", {"status": "registration_closed", "version": t["version"]})
    t = api.patch(f"/tournaments/{tid}/status", {"status": "in_progress", "version": t["version"]})
    t = api.patch(f"/tournaments/{tid}/status", {"status": "finished", "version": t["version"]})
    r = api.raw("PATCH", f"/tournaments/{tid}/status", json={"status": "in_progress", "version": t["version"]})
    assert r.json()["error"]["code"] == "REASON_REQUIRED"
    t = api.patch(
        f"/tournaments/{tid}/status", {"status": "in_progress", "version": t["version"], "reason": "Corregir resultado"}
    )
    log = api.get(f"/audit?tournament_id={tid}&entity=tournament")
    assert any(e["action"] == "reopen" and e["reason"] == "Corregir resultado" for e in log)
    # Concurrencia: versión vieja -> conflicto
    r = api.raw("PATCH", f"/tournaments/{tid}", json={"version": 1, "name": "X"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "VERSION_CONFLICT"


def test_category_merge_and_undo(client):
    api = client
    d1, d2 = api.dojo("Uno"), api.dojo("Dos")
    t = setup_tournament(api)
    tid = t["id"]
    c1 = api.post(f"/tournaments/{tid}/categories", {**KUMITE, "code": "C1", "weight_class": "-40"}, expect=201)
    c2 = api.post(f"/tournaments/{tid}/categories", {**KUMITE, "code": "C2", "weight_class": "-45"}, expect=201)
    for i, (cat, w) in enumerate([(c1, "-40"), (c1, "-40"), (c2, "-45"), (c2, "-45")]):
        p = api.person(f"N{i}", f"L{i}", (d1 if i % 2 else d2)["id"])
        register(api, tid, p["id"], cat["id"], weight_class=w)
    merged = api.post(f"/tournaments/{tid}/categories/merge", {"source_ids": [c1["id"], c2["id"]], "reason": "Pocos"})
    assert merged["entrant_count"] == 4 and merged["weight_class"] is None
    assert api.get(f"/categories/{c1['id']}")["status"] == "merged"
    b = api.post(f"/categories/{merged['id']}/bracket", {"seed": 1})
    assert len(b["matches"]) == 3
    api.post(f"/categories/{merged['id']}/unmerge")
    assert api.get(f"/categories/{c1['id']}")["entrant_count"] == 2
    assert api.get(f"/categories/{merged['id']}")["status"] == "cancelled"


def test_round_robin_and_third_place_match(client):
    api = client
    d = [api.dojo(n) for n in "ABC"]
    t = setup_tournament(api)
    tid = t["id"]
    c = api.post(f"/tournaments/{tid}/categories", KUMITE, expect=201)
    for i in range(3):
        p = api.person(f"R{i}", f"R{i}", d[i]["id"])
        register(api, tid, p["id"], c["id"], weight_class="-45")
    b = api.post(f"/categories/{c['id']}/bracket", {"format": "round_robin", "seed": 3})
    assert len(b["matches"]) == 3
    for m in b["matches"]:
        api.finish(m["id"], "aka", override="papel")
    b = api.get(f"/categories/{c['id']}/bracket")
    # aka gana todo: con 3 en círculo puede haber triple empate a 1 victoria
    ranks = [s["rank"] for s in b["standings"]]
    assert sorted(ranks)[0] == 1

    c2 = api.post(f"/tournaments/{tid}/categories", {**KUMITE, "code": "X2"}, expect=201)
    for i in range(4):
        p = api.person(f"T{i}", f"T{i}", d[i % 3]["id"])
        register(api, tid, p["id"], c2["id"], weight_class="-45")
    b = api.post(f"/categories/{c2['id']}/bracket", {"third_place_rule": "third_place_match", "seed": 9})
    assert any(m["kind"] == "third_place" for m in b["matches"])


def test_kata_rounds_with_tie(client):
    api = client
    d = [api.dojo(n) for n in "ABC"]
    t = setup_tournament(api, kata_defaults={"method": "scores", "structure": "rounds", "judges": 5})
    tid = t["id"]
    c = api.post(
        f"/tournaments/{tid}/categories",
        {"code": "KA", "name": "Kata 12-13 M", "modality": "kata", "sex": "M", "age_min": 12, "age_max": 13},
        expect=201,
    )
    regs = []
    for i in range(4):
        p = api.person(f"K{i}", f"K{i}", d[i % 3]["id"])
        regs.append(register(api, tid, p["id"], c["id"]))
    b = api.post(f"/categories/{c['id']}/bracket", {"seed": 5})
    assert b["format"] == "kata_rounds" and len(b["standings"]) == 4
    scores = {
        regs[0]["id"]: ["7.0", "8.0", "8.0", "8.0", "9.0"],
        regs[1]["id"]: ["7.5", "8.0", "8.0", "8.0", "8.5"],
        regs[2]["id"]: ["6.0", "6.5", "6.5", "6.5", "7.0"],
        regs[3]["id"]: ["6.0", "6.0", "6.0", "6.0", "6.0"],
    }
    for rid, sc in scores.items():
        b = api.post(f"/categories/{c['id']}/kata-scores", {"registration_id": rid, "scores": sc})
    places = {p["registration_id"]: p["place"] for p in b["podium"]["places"]}
    # Empate a 24.0: gana quien tiene mayor nota mínima descartada
    assert places[regs[1]["id"]] == 1 and places[regs[0]["id"]] == 2
    assert api.get(f"/categories/{c['id']}")["status"] == "finished"
    r = api.raw(
        "POST", f"/categories/{c['id']}/kata-scores", json={"registration_id": regs[3]["id"], "scores": ["4"] * 5}
    )
    assert r.status_code == 400


def test_kata_flags_bracket(client):
    api = client
    d = [api.dojo(n) for n in "AB"]
    t = setup_tournament(api)
    tid = t["id"]
    c = api.post(
        f"/tournaments/{tid}/categories",
        {"code": "KF", "name": "Kata flags", "modality": "kata", "sex": "X", "kata_method": "flags", "kata_judges": 3},
        expect=201,
    )
    for i in range(2):
        p = api.person(f"F{i}", f"F{i}", d[i]["id"])
        register(api, tid, p["id"], c["id"])
    b = api.post(f"/categories/{c['id']}/bracket", {})
    mid = b["matches"][0]["id"]
    res = api.post(
        f"/matches/{mid}/flags",
        {"votes": ["ao", "ao", "aka"], "event_id": str(uuid.uuid4()), "at": "2026-10-17T10:00:00Z"},
    )
    assert res["winner"] == "ao"
    assert api.get(f"/categories/{c['id']}")["status"] == "finished"


def _xlsx(rows):
    wb = Workbook()
    ws = wb.active
    ws.append(["dojo", "sede", "tipo", "num", "nombres", "apellidos", "nac", "sexo", "grado", "peso", "mod"])
    for r in rows:
        ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def test_excel_import_preview_and_confirm(client):
    api = client
    d = api.dojo("Dojo Norte")
    existing = api.person("Lucía", "Ramírez", d["id"], sex="F", birth="2013-02-02")
    t = setup_tournament(api)
    tid = t["id"]
    c = api.post(
        f"/tournaments/{tid}/categories",
        {**KUMITE, "code": "KF", "sex": "F", "name": "Kumite F -45"},
        expect=201,
    )
    assert api.raw("GET", "/imports/template.xlsx").status_code == 200
    content = _xlsx(
        [
            ["Dojo Norte", "", "DNI", "70000001", "Lucia", "Ramirez", "02/02/2013", "F", "8 kyu", "-45", "kumite"],
            ["Dojo Nuevo", "", "", "", "María", "Quispe", "10/10/2013", "F", "9 kyu", "-45", "kumite"],
            ["Dojo Nuevo", "", "", "", "Error", "", "xx", "Z", "", "", "judo"],
        ]
    )
    batch = api.post(
        f"/tournaments/{tid}/imports",
        files={"file": ("lista.xlsx", content, "application/octet-stream")},
        expect=201,
    )
    st = [r["status"] for r in batch["rows"]]
    assert st == ["duplicate", "new", "error"]
    assert batch["rows"][1]["suggested_category_ids"] == [c["id"]]
    dup_row = batch["rows"][0]
    assert dup_row["duplicates"][0]["person_id"] == existing["id"]
    # Nada se guarda en vista previa
    assert api.get(f"/tournaments/{tid}/registrations") == []
    res = api.post(
        f"/imports/{batch['id']}/confirm",
        {
            "decisions": [
                {
                    "row_id": dup_row["id"],
                    "action": "use_existing",
                    "person_id": existing["id"],
                    "category_ids": [c["id"]],
                }
            ]
        },
    )
    assert res == {"created_people": 1, "registrations": 2, "skipped": 1}
    regs = api.get(f"/tournaments/{tid}/registrations")
    assert {r["person_id"] for r in regs} >= {existing["id"]}
    assert any(dj["name"] == "Dojo Nuevo" for dj in api.get("/dojos"))
