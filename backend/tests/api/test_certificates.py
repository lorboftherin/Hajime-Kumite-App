"""Diplomas de podio y certificados de participación."""

from datetime import date

from app.services.certificates import date_text
from tests.api.test_mock_tournament import KUMITE, register, setup_tournament


def play_out(api, cid):
    """Genera la llave y cierra cada combate listo a favor de aka hasta terminar."""
    api.post(f"/categories/{cid}/bracket", {"seed": 7})
    for _ in range(20):
        ready = [m for m in api.get(f"/categories/{cid}/bracket")["matches"] if m["status"] == "ready"]
        if not ready:
            break
        for m in ready:
            api.finish(m["id"], "aka", override="Resultado de papel")
    return api.get(f"/categories/{cid}")


def category_with(api, tid, n, code="M45", dojos=None, **kw):
    c = api.post(f"/tournaments/{tid}/categories", {**KUMITE, "code": code, "name": f"Kumite {code}", **kw}, expect=201)
    dojos = dojos or [api.dojo(f"{code}-A"), api.dojo(f"{code}-B")]
    regs = []
    for i in range(n):
        d = dojos[i % len(dojos)]
        p = api.person(f"{code}n{i}", f"Apellido{code}{i}", d["id"])
        regs.append(register(api, tid, p["id"], c["id"], weight_class=c["weight_class"]))
    return c, regs


def test_date_text():
    assert date_text(date(2026, 10, 17)) == "17 de octubre de 2026"
    assert date_text(date(2026, 10, 17), date(2026, 10, 18)) == "del 17 al 18 de octubre de 2026"


def test_category_diplomas_need_finished_category(client):
    api = client
    t = setup_tournament(api, city="Arequipa")
    c, regs = category_with(api, t["id"], 4)
    assert api.raw("GET", f"/categories/{c['id']}/diplomas.pdf").status_code == 409
    assert play_out(api, c["id"])["status"] == "finished"
    for kind in ("podium", "participation", "all"):
        r = api.raw("GET", f"/categories/{c['id']}/diplomas.pdf", params={"kind": kind})
        assert r.status_code == 200 and r.content[:4] == b"%PDF", kind


def test_diploma_selection(client):
    from app.db.base import get_session
    from app.services import certificates as svc

    api = client
    t = setup_tournament(api, city="Lima")
    c, regs = category_with(api, t["id"], 5)
    play_out(api, c["id"])
    db = next(get_session())
    _, podium = svc.category_diplomas(db, c["id"], "podium")
    _, rest = svc.category_diplomas(db, c["id"], "participation")
    _, both = svc.category_diplomas(db, c["id"], "all")
    assert sorted(d.place for d in podium) == [1, 2, 3, 3]
    assert len(rest) == 1 and rest[0].place is None
    assert len(both) == 5
    # Por dojo y por persona.
    dojo_id = regs[0]["dojo_id"]
    _, by_dojo = svc.tournament_diplomas(db, t["id"], "all", dojo_id=dojo_id)
    assert len(by_dojo) == sum(1 for r in regs if r["dojo_id"] == dojo_id)
    _, mine = svc.tournament_diplomas(db, t["id"], "all", person_id=regs[1]["person_id"])
    assert len(mine) == 1
    db.close()


def test_no_show_gets_no_certificate(client):
    from app.db.base import get_session
    from app.services import certificates as svc

    api = client
    t = setup_tournament(api)
    c, regs = category_with(api, t["id"], 3)
    api.post(f"/tournaments/{t['id']}/checkin", {"registration_ids": [regs[2]["id"]], "status": "absent"})
    api.post(f"/categories/{c['id']}/bracket", {"seed": 1, "exclude_absent": True})
    play_out_ready = [m for m in api.get(f"/categories/{c['id']}/bracket")["matches"] if m["status"] == "ready"]
    for m in play_out_ready:
        api.finish(m["id"], "aka", override="Resultado de papel")
    assert api.get(f"/categories/{c['id']}")["status"] == "finished"
    db = next(get_session())
    _, items = svc.category_diplomas(db, c["id"], "all")
    assert len(items) == 2
    db.close()


def test_person_and_dojo_downloads_and_permissions(client):
    api = client
    t = setup_tournament(api)
    c, regs = category_with(api, t["id"], 2)
    play_out(api, c["id"])
    pid = regs[0]["person_id"]
    assert api.raw("GET", f"/tournaments/{t['id']}/persons/{pid}/diplomas.pdf").status_code == 200
    assert (
        api.raw("GET", f"/tournaments/{t['id']}/diplomas.pdf", params={"dojo_id": regs[0]["dojo_id"]}).status_code
        == 200
    )
    certs = api.get(f"/persons/{pid}/certificates")
    assert certs[0]["tournament_id"] == t["id"] and certs[0]["items"][0]["place"] in (1, 2)

    # La propia persona descarga sus diplomas, no los de otros ni los de la categoría.
    api.post("/users", {"username": "compe", "password": "secret123", "person_id": pid}, expect=201)
    tok = api.c.post("/api/v1/auth/login", json={"username": "compe", "password": "secret123"}).json()["access_token"]
    h = {"Authorization": f"Bearer {tok}"}
    assert api.raw("GET", f"/tournaments/{t['id']}/persons/{pid}/diplomas.pdf", headers=h).status_code == 200
    other = regs[1]["person_id"]
    assert api.raw("GET", f"/tournaments/{t['id']}/persons/{other}/diplomas.pdf", headers=h).status_code == 403
    assert api.raw("GET", f"/categories/{c['id']}/diplomas.pdf", headers=h).status_code == 403
    assert api.raw("GET", f"/persons/{pid}/certificates", headers=h).status_code == 200
    assert api.raw("GET", f"/persons/{other}/certificates", headers=h).status_code == 403

    # El sensei del dojo descarga los de su dojo.
    dojo_id = regs[1]["dojo_id"]
    s = api.person("Sensei", "Del Dojo", dojo_id)
    api.post(f"/persons/{s['id']}/roles", {"role": "sensei", "scope_type": "dojo", "scope_id": dojo_id}, expect=201)
    api.post("/users", {"username": "sensei", "password": "secret123", "person_id": s["id"]}, expect=201)
    tok = api.c.post("/api/v1/auth/login", json={"username": "sensei", "password": "secret123"}).json()["access_token"]
    hs = {"Authorization": f"Bearer {tok}"}
    url = f"/tournaments/{t['id']}/diplomas.pdf"
    assert api.raw("GET", url, params={"dojo_id": dojo_id}, headers=hs).status_code == 200
    assert api.raw("GET", url, params={"dojo_id": regs[0]["dojo_id"]}, headers=hs).status_code == 403
    assert api.raw("GET", url, headers=hs).status_code == 403


def test_signer_texts_are_editable(client):
    api = client
    t = setup_tournament(api)
    t = api.patch(
        f"/tournaments/{t['id']}",
        {
            "version": t["version"],
            "certificate_organizer": "Liga de Karate de Lima",
            "certificate_signer_name": "Rosa Quispe",
            "certificate_signer_title": "Presidenta",
        },
    )
    assert (t["certificate_organizer"], t["certificate_signer_name"], t["certificate_signer_title"]) == (
        "Liga de Karate de Lima",
        "Rosa Quispe",
        "Presidenta",
    )
