"""Acreditación (check-in), pesaje y credenciales."""

from decimal import Decimal

import pytest

from app.services.checkin import normalize_code, parse_weight_class, weigh_in_result
from tests.api.test_mock_tournament import KUMITE, register, setup_tournament


def _category(api, tid, code, **kw):
    return api.post(
        f"/tournaments/{tid}/categories", {**KUMITE, "code": code, "name": f"Kumite {code}", **kw}, expect=201
    )


def _setup(api, n=3, **tkw):
    t = setup_tournament(api, **tkw)
    c = _category(api, t["id"], "M45")
    d = api.dojo("Acred")
    persons = [api.person(f"P{i}", f"Acred{i}", d["id"]) for i in range(n)]
    regs = [register(api, t["id"], p["id"], c["id"], weight_class="-45") for p in persons]
    return t, c, d, persons, regs


@pytest.mark.parametrize(
    ("label", "expected"),
    [
        ("-45", (None, Decimal("45"))),
        ("-45 kg", (None, Decimal("45"))),
        ("+68", (Decimal("68"), None)),
        ("45-50", (Decimal("45"), Decimal("50"))),
        ("−52,5", (None, Decimal("52.5"))),
        ("45–50 kg", (Decimal("45"), Decimal("50"))),
        ("Libre", (None, None)),
        (None, (None, None)),
    ],
)
def test_parse_weight_class(label, expected):
    assert parse_weight_class(label) == expected


def test_weigh_in_result_with_tolerance():
    rng = (None, Decimal("45"))
    assert weigh_in_result(Decimal("45.00"), rng, Decimal("0")) == "ok"
    assert weigh_in_result(Decimal("45.30"), rng, Decimal("0")) == "over"
    assert weigh_in_result(Decimal("45.30"), rng, Decimal("0.5")) == "ok"
    assert weigh_in_result(Decimal("60"), (Decimal("68"), None), Decimal("0")) == "under"


def test_normalize_code():
    assert normalize_code(" hj:abc 23x ") == "ABC23X"
    assert normalize_code("abc-234") == "ABC234"


def test_checkin_marks_person_everywhere_and_is_idempotent(client):
    api = client
    t, c, d, persons, regs = _setup(api)
    kata = api.post(
        f"/tournaments/{t['id']}/categories",
        {"code": "KATA", "name": "Kata 12-13", "modality": "kata", "sex": "M", "age_min": 12, "age_max": 13},
        expect=201,
    )
    kata_reg = register(api, t["id"], persons[0]["id"], kata["id"])

    out = api.post(f"/registrations/{regs[0]['id']}/checkin", {"status": "present"})
    assert set(out["changed"]) == {regs[0]["id"], kata_reg["id"]}
    assert all(r["checkin_status"] == "present" for r in out["registrations"])
    # Repetir el toque (red mala, reintento) no cambia nada ni duplica auditoría.
    again = api.post(f"/registrations/{regs[0]['id']}/checkin", {"status": "present"})
    assert again["changed"] == []
    audits = api.get("/audit", params={"tournament_id": t["id"], "entity": "registration"})
    assert sum(1 for a in audits if a["action"] == "checkin") == 2

    # En lote y solo esa inscripción.
    out = api.post(
        f"/tournaments/{t['id']}/checkin",
        {"registration_ids": [regs[1]["id"], regs[2]["id"]], "status": "absent", "whole_person": False},
    )
    assert set(out["changed"]) == {regs[1]["id"], regs[2]["id"]}
    lst = api.get(f"/tournaments/{t['id']}/checkin")
    assert lst["totals"] == {"total": 4, "present": 2, "absent": 2, "pending": 0}
    by_cat = {x["category_id"]: x for x in lst["categories"]}
    assert by_cat[c["id"]]["present"] == 1 and by_cat[c["id"]]["absent"] == 2
    assert {
        r["registration_id"] for r in api.get(f"/tournaments/{t['id']}/checkin", params={"status": "absent"})["rows"]
    } == {
        regs[1]["id"],
        regs[2]["id"],
    }
    assert len(api.get(f"/tournaments/{t['id']}/checkin", params={"q": "p0 acred0"})["rows"]) == 2
    assert api.get(f"/tournaments/{t['id']}/checkin", params={"dojo_id": d["id"] + 999})["rows"] == []

    # Otro torneo: 409.
    other = setup_tournament(api)
    r = api.raw("POST", f"/tournaments/{other['id']}/checkin", json={"registration_ids": [regs[0]["id"]]})
    assert r.status_code == 409


def test_scan_code_and_credentials_pdf(client):
    api = client
    t, c, d, persons, regs = _setup(api, n=2)
    rows = api.get(f"/tournaments/{t['id']}/checkin")["rows"]
    codes = {r["registration_id"]: r["code"] for r in rows}
    assert all(codes.values()) and len(set(codes.values())) == 2
    creds = api.get(f"/tournaments/{t['id']}/credentials")
    assert {x["code"] for x in creds} == set(codes.values())
    assert creds[0]["categories"] == [c["name"]]

    code = codes[regs[1]["id"]]
    out = api.post(f"/tournaments/{t['id']}/checkin/scan", {"code": f"  {code.lower()} "})
    assert out["changed"] == [regs[1]["id"]] and out["name"].startswith("P1")
    assert api.raw("POST", f"/tournaments/{t['id']}/checkin/scan", json={"code": "ZZZZZZ"}).status_code == 404

    pdf = api.raw("GET", f"/tournaments/{t['id']}/credentials.pdf")
    assert pdf.status_code == 200 and pdf.content[:4] == b"%PDF"
    assert api.raw("GET", f"/tournaments/{t['id']}/credentials.pdf", params={"dojo_id": d["id"]}).status_code == 200


def test_weigh_in_out_of_range_warns_and_resolves(client):
    api = client
    t, c, d, persons, regs = _setup(api, n=2)
    heavier = _category(api, t["id"], "M50", name="Kumite 12-13 Masculino -50", weight_class="-50")
    api.patch(f"/tournaments/{t['id']}", {"version": t["version"], "weigh_in_tolerance_kg": "0.2"})

    ok = api.post(f"/registrations/{regs[0]['id']}/weigh-in", {"weight_kg": 45.1})
    assert ok["results"][0]["result"] == "ok"  # dentro de la tolerancia
    out = api.post(f"/registrations/{regs[1]['id']}/weigh-in", {"weight_kg": 47.5})
    res = out["results"][0]
    assert res["result"] == "over" and res["warnings"][0]["code"] == "WEIGHT_OVER"
    assert [x["category_id"] for x in res["suggestions"]] == [heavier["id"]]
    # Pesarse acredita.
    reg = api.get(f"/tournaments/{t['id']}/registrations", params={"person_id": persons[1]["id"]})[0]
    assert reg["checkin_status"] == "present" and reg["weight_kg"] == 47.5 and reg["weigh_in_result"] == "over"

    ready = api.get(f"/tournaments/{t['id']}/readiness")
    assert "WEIGHT_OUT_OF_RANGE" in {i["code"] for i in ready["issues"]}
    assert len(api.get(f"/tournaments/{t['id']}/checkin", params={"out_of_weight": True})["rows"]) == 1

    moved = api.post(
        f"/registrations/{regs[1]['id']}/weigh-in/move",
        {"category_id": heavier["id"], "reason": "Pesó 47,5 kg en la balanza oficial"},
    )
    assert moved["category_id"] == heavier["id"] and moved["weigh_in_result"] == "ok"
    ready = api.get(f"/tournaments/{t['id']}/readiness")
    assert "WEIGHT_OUT_OF_RANGE" not in {i["code"] for i in ready["issues"]}
    audits = api.get("/audit", params={"tournament_id": t["id"], "entity": "registration"})
    assert any(a["action"] == "weigh_in_move" for a in audits)


def test_weigh_in_accept_with_override(client):
    api = client
    t, c, d, persons, regs = _setup(api, n=1)
    api.post(f"/registrations/{regs[0]['id']}/weigh-in", {"weight_kg": 46})
    assert api.raw("POST", f"/registrations/{regs[0]['id']}/weigh-in/accept", json={"reason": "x"}).status_code == 422
    api.post(f"/registrations/{regs[0]['id']}/weigh-in/accept", {"reason": "Acuerdo con los senseis"})
    overrides = api.get("/overrides", params={"entity": "registration", "entity_id": regs[0]["id"]})
    assert [o["code"] for o in overrides] == ["WEIGH_IN_OUT_OF_RANGE"]
    row = api.get(f"/tournaments/{t['id']}/checkin")["rows"][0]
    assert row["weigh_in_resolved"] is True
    assert "WEIGHT_OUT_OF_RANGE" not in {i["code"] for i in api.get(f"/tournaments/{t['id']}/readiness")["issues"]}
    # Dentro de rango no hay nada que aceptar.
    api.post(f"/registrations/{regs[0]['id']}/weigh-in", {"weight_kg": 44})
    assert api.raw("POST", f"/registrations/{regs[0]['id']}/weigh-in/accept", json={"reason": "abc"}).status_code == 409


def test_absent_warns_at_bracket_and_can_be_excluded(client):
    api = client
    t, c, d, persons, regs = _setup(api, n=3)
    api.post(f"/tournaments/{t['id']}/checkin", {"registration_ids": [regs[2]["id"]], "status": "absent"})
    r = api.raw("POST", f"/categories/{c['id']}/bracket", json={"seed": 1})
    assert r.status_code == 409
    assert [w["code"] for w in r.json()["error"]["details"]["warnings"]] == ["ABSENT_ENTRANTS"]
    b = api.post(f"/categories/{c['id']}/bracket", {"seed": 1, "exclude_absent": True})
    in_bracket = {x for x in b["slots"] if x}
    assert in_bracket == {regs[0]["id"], regs[1]["id"]}
    absent = api.get(f"/tournaments/{t['id']}/registrations", params={"person_id": persons[2]["id"]})[0]
    assert absent["status"] == "withdrawn" and absent["withdrawn_reason"] == "No se presentó"


def test_absent_with_existing_bracket_gets_walkover(client):
    api = client
    t, c, d, persons, regs = _setup(api, n=2)
    b = api.post(f"/categories/{c['id']}/bracket", {"seed": 1})
    out = api.post(f"/tournaments/{t['id']}/checkin", {"registration_ids": [regs[0]["id"]], "status": "absent"})
    assert out["absent_with_bracket"][0]["options"] == ["walkover"]
    wo = api.post(f"/registrations/{regs[0]['id']}/no-show")
    assert len(wo["walkover_matches"]) == 1
    final = b["matches"][0]
    sb = api.get(f"/matches/{final['id']}")
    assert sb["method"] == "walkover" and sb["match"]["winner_registration_id"] == regs[1]["id"]


def test_checkin_required_in_readiness_and_bracket(client):
    api = client
    t, c, d, persons, regs = _setup(api, n=2)
    assert "NOT_CHECKED_IN" not in {i["code"] for i in api.get(f"/tournaments/{t['id']}/readiness")["issues"]}
    t = api.get(f"/tournaments/{t['id']}")
    t = api.patch(f"/tournaments/{t['id']}", {"version": t["version"], "checkin_required": True})
    assert t["checkin_required"] is True
    issues = {i["code"]: i for i in api.get(f"/tournaments/{t['id']}/readiness")["issues"]}
    assert set(issues["NOT_CHECKED_IN"]["registration_ids"]) == {regs[0]["id"], regs[1]["id"]}
    r = api.raw("POST", f"/categories/{c['id']}/bracket", json={"seed": 1})
    assert [w["code"] for w in r.json()["error"]["details"]["warnings"]] == ["NOT_CHECKED_IN"]
    api.post(f"/tournaments/{t['id']}/checkin", {"registration_ids": [x["id"] for x in regs]})
    api.post(f"/categories/{c['id']}/bracket", {"seed": 1})


def test_checkin_requires_organizer(client):
    api = client
    t, c, d, persons, regs = _setup(api, n=1)
    api.post("/users", {"username": "mirón", "password": "secret123"}, expect=201)
    tok = api.c.post("/api/v1/auth/login", json={"username": "mirón", "password": "secret123"}).json()
    h = {"Authorization": f"Bearer {tok['access_token']}"}
    assert api.raw("GET", f"/tournaments/{t['id']}/checkin", headers=h).status_code == 403
    assert api.raw("POST", f"/registrations/{regs[0]['id']}/checkin", json={}, headers=h).status_code == 403
    assert api.raw("GET", f"/tournaments/{t['id']}/credentials.pdf", headers=h).status_code == 403
