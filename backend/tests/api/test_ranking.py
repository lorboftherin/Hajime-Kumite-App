"""Ranking por temporada: puntos, categorías equivalentes, dojos, caché y vista pública."""

from sqlalchemy import event

from app.db import base
from tests.api.test_certificates import category_with, play_out
from tests.api.test_mock_tournament import register, setup_tournament


def season(api, **kw):
    body = {"name": "Liga Lima", "year": 2026, **kw}
    return api.post("/ranking/seasons", body, expect=201)


def podium(api, cid):
    b = api.get(f"/categories/{cid}/bracket")
    return {k: v for k, v in b["podium"].items()}


def _places(api, tid, cid):
    res = next(c for c in api.get(f"/tournaments/{tid}/results") if c["category_id"] == cid)
    return {p["registration_id"]: p["place"] for p in res["places"]}


def test_points_equivalent_categories_and_dojos(client):
    api = client
    dojos = [api.dojo("Kaze"), api.dojo("Mizu")]
    t1 = setup_tournament(api, is_test=False, name="Apertura")
    t2 = setup_tournament(api, is_test=False, name="Nacional", start_date="2026-11-20")
    # Misma categoría con otro nombre y código en el segundo torneo.
    c1, regs1 = category_with(api, t1["id"], 2, code="A45", dojos=dojos)
    c2 = api.post(
        f"/tournaments/{t2['id']}/categories",
        {
            **{k: c1[k] for k in ("modality", "sex", "age_min", "age_max", "grade_min", "grade_max", "weight_class")},
            "code": "NAC-45",
            "name": "Nacional Kumite -45",
        },
        expect=201,
    )
    regs2 = [register(api, t2["id"], r["person_id"], c2["id"], weight_class="-45") for r in regs1]
    play_out(api, c1["id"])
    play_out(api, c2["id"])
    s = season(api, multipliers={str(t2["id"]): 2})
    detail = api.get(f"/ranking/seasons/{s['id']}")
    assert [t["id"] for t in detail["season"]["tournaments"]] == [t1["id"], t2["id"]]
    assert len(detail["groups"]) == 1  # las dos categorías son equivalentes
    rows = detail["persons"][0]["rows"]
    p1 = _places(api, t1["id"], c1["id"])
    p2 = _places(api, t2["id"], c2["id"])
    pts = {1: 10, 2: 7}
    expected = {r1["person_id"]: pts[p1[r1["id"]]] + 2 * pts[p2[r2["id"]]] for r1, r2 in zip(regs1, regs2, strict=True)}
    assert {r["person_id"]: r["points"] for r in rows} == expected
    assert rows[0]["rank"] == 1 and rows[0]["points"] == max(expected.values())
    assert all(r["tournaments"] == 2 for r in rows)
    # Dojos: suma de sus competidores.
    dojo_pts = {r["dojo_id"]: r["points"] for r in detail["dojos"]}
    assert sum(dojo_pts.values()) == sum(expected.values())
    # Perfil de la persona: su puesto.
    pos = api.get(f"/persons/{rows[0]['person_id']}/ranking")
    assert pos[0]["rank"] == 1 and pos[0]["of"] == 2 and pos[0]["season_id"] == s["id"]


def test_test_tournaments_and_date_range(client):
    api = client
    t_test = setup_tournament(api, is_test=True)
    t_old = setup_tournament(api, is_test=False, start_date="2025-05-01")
    for t in (t_test, t_old):
        c, _ = category_with(api, t["id"], 2, code=f"C{t['id']}", age_min=None, age_max=None)
        play_out(api, c["id"])
    s = season(api)
    assert api.get(f"/ranking/seasons/{s['id']}")["persons"] == []
    # Con lista explícita cuenta lo listado.
    s2 = season(api, name="Solo prueba", tournament_ids=[t_test["id"]])
    assert len(api.get(f"/ranking/seasons/{s2['id']}")["persons"]) == 1


def test_walkover_gold_needs_min_entrants(client):
    api = client
    t = setup_tournament(api, is_test=False)
    c, regs = category_with(api, t["id"], 2)
    api.post(f"/categories/{c['id']}/bracket", {"seed": 1})
    final = api.get(f"/categories/{c['id']}/bracket")["matches"][0]
    api.finish(final["id"], "aka", method="walkover", override="No se presentó")
    s = season(api, min_entrants_walkover_gold=3)
    rows = api.get(f"/ranking/seasons/{s['id']}")["persons"][0]["rows"]
    # Oro sin combate en una categoría de 2: solo participación (1 punto).
    assert sorted(r["points"] for r in rows) == [1, 1]
    s = api.patch(f"/ranking/seasons/{s['id']}", {"version": s["version"], "min_entrants_walkover_gold": 2})
    rows = api.get(f"/ranking/seasons/{s['id']}")["persons"][0]["rows"]
    assert sorted(r["points"] for r in rows) == [7, 10]


def test_ranking_is_cached_and_recomputed_when_results_change(client):
    api = client
    t = setup_tournament(api, is_test=False)
    c, regs = category_with(api, t["id"], 2)
    play_out(api, c["id"])
    s = season(api)
    api.get(f"/ranking/seasons/{s['id']}")

    engine = base.get_engine()
    statements: list[str] = []

    def count(conn, cursor, statement, *a):
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", count)
    try:
        api.get(f"/ranking/seasons/{s['id']}")
    finally:
        event.remove(engine, "before_cursor_execute", count)
    assert not any("DELETE FROM ranking_entries" in x for x in statements)  # nada que recalcular
    assert len(statements) < 25

    # Reabrir la categoría cambia los resultados: se recalcula al leer.
    api.post(f"/categories/{c['id']}/reopen", {"reason": "Corrección de acta"})
    assert api.get(f"/ranking/seasons/{s['id']}")["persons"] == []
    out = api.post(f"/ranking/seasons/{s['id']}/recompute")
    assert out["entries"] == 0


def test_public_ranking_abbreviates_minors(client):
    api = client
    t = setup_tournament(api, is_test=False)
    c, regs = category_with(api, t["id"], 2)
    play_out(api, c["id"])
    s = season(api, name="Liga Abierta")
    assert api.raw("GET", f"/public/ranking/{s['slug']}", headers={"Authorization": ""}).status_code == 404
    api.patch(f"/ranking/seasons/{s['id']}", {"version": s["version"], "is_public": True})
    r = api.raw("GET", f"/public/ranking/{s['slug']}", headers={"Authorization": ""})
    assert r.status_code == 200
    body = r.json()
    names = [row["name"] for g in body["persons"] for row in g["rows"]]
    assert names and all(n.endswith(".") for n in names)  # menores: «Nombre A.»
    assert "multipliers" not in body["season"]
    # El staff ve nombres completos.
    full = [row["name"] for g in api.get(f"/ranking/seasons/{s['id']}")["persons"] for row in g["rows"]]
    assert all(not n.endswith(".") for n in full)


def test_season_permissions_and_validation(client):
    api = client
    assert (
        api.raw(
            "POST",
            "/ranking/seasons",
            json={"name": "Mala", "year": 2026, "date_from": "2026-12-01", "date_to": "2026-01-01"},
        ).status_code
        == 409
    )
    s = season(api)
    s_dup = season(api)
    assert s_dup["slug"] != s["slug"]
    api.post("/users", {"username": "lector", "password": "secret123"}, expect=201)
    tok = api.c.post("/api/v1/auth/login", json={"username": "lector", "password": "secret123"}).json()["access_token"]
    h = {"Authorization": f"Bearer {tok}"}
    assert api.raw("GET", f"/ranking/seasons/{s['id']}", headers=h).status_code == 200
    assert api.raw("POST", "/ranking/seasons", json={"name": "Xyz", "year": 2026}, headers=h).status_code == 403
    assert api.raw("DELETE", f"/ranking/seasons/{s['id']}", headers=h).status_code == 403
    assert api.raw("DELETE", f"/ranking/seasons/{s['id']}").status_code == 204
