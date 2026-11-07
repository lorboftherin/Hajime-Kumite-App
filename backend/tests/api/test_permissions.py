"""Roles por ámbito y protección de datos (secciones 7 y 11)."""

import itertools
import uuid

from tests.api.test_mock_tournament import KUMITE, register, setup_tournament


def login_as(api, username, password="secret123", **user):
    api.post("/users", {"username": username, "password": password, **user}, expect=201)
    tok = api.raw("POST", "/auth/login", json={"username": username, "password": password}).json()["access_token"]
    return {"Authorization": f"Bearer {tok}"}


_doc = itertools.count(1)


def ready_match(api):
    """Torneo con una categoría de dos inscritos y su combate listo."""
    d = api.dojo("Perm")
    t = setup_tournament(api)
    c = api.post(f"/tournaments/{t['id']}/categories", KUMITE, expect=201)
    for i in range(2):
        p = api.person(f"P{i}", f"P{i}", d["id"], document={"doc_type": "DNI", "number": f"7{next(_doc):07d}"})
        register(api, t["id"], p["id"], c["id"], weight_class="-45")
    b = api.post(f"/categories/{c['id']}/bracket", {"seed": 1})
    return t, c, b["matches"][0], p


def test_plain_user_cannot_operate_nor_see_documents(client):
    api = client
    t, c, m, person = ready_match(api)
    hdr = login_as(api, "consulta")
    r = api.raw(
        "POST",
        f"/matches/{m['id']}/events",
        json={"id": str(uuid.uuid4()), "type": "start", "at": "2026-10-17T10:00:00Z"},
        headers=hdr,
    )
    assert r.status_code == 403
    assert api.raw("POST", "/dojos", json={"name": "Dojo X"}, headers=hdr).status_code == 403
    assert (
        api.raw("PATCH", f"/persons/{person['id']}", json={"version": 1, "first_names": "X"}, headers=hdr).status_code
        == 403
    )
    me = api.raw("GET", "/auth/me", headers=hdr).json()
    assert me["can_view_documents"] is False
    # Sin rol no ve fichas ajenas ni puede buscar personas (tampoco por DNI)
    assert api.raw("GET", f"/persons/{person['id']}", headers=hdr).status_code == 403
    assert api.raw("GET", "/persons?q=70000001", headers=hdr).status_code == 403
    assert api.raw("GET", "/persons?q=70000001").json()[0]["documents"][0]["number"] == "70000001"
    assert api.raw("GET", "/persons/duplicates?first_names=a&last_names=b", headers=hdr).status_code == 403


def test_table_operator_scoped_to_tournament(client):
    api = client
    t, c, m, _ = ready_match(api)
    d = api.dojo("Op")
    op_person = api.person("Mesa", "Operadora", d["id"], sex="F")
    hdr = login_as(api, "mesa1", person_id=op_person["id"])
    api.post(
        f"/persons/{op_person['id']}/roles",
        {"role": "table_operator", "scope_type": "tournament", "scope_id": t["id"]},
        expect=201,
    )
    ev = {"id": str(uuid.uuid4()), "type": "start", "at": "2026-10-17T10:00:00Z"}
    assert api.raw("POST", f"/matches/{m['id']}/events", json=ev, headers=hdr).status_code == 201
    # No puede generar llaves ni ver documentos
    assert api.raw("POST", f"/categories/{c['id']}/bracket", json={}, headers=hdr).status_code == 403
    assert api.raw("GET", f"/persons/{op_person['id']}", headers=hdr).json()["documents"] == []
    # Otro torneo: prohibido
    t2, c2, m2, _ = ready_match(api)
    ev2 = {"id": str(uuid.uuid4()), "type": "start", "at": "2026-10-17T10:00:00Z"}
    assert api.raw("POST", f"/matches/{m2['id']}/events", json=ev2, headers=hdr).status_code == 403
    # Rol por torneo sin scope_id se rechaza
    r = api.raw("POST", f"/persons/{op_person['id']}/roles", json={"role": "organizer", "scope_type": "tournament"})
    assert r.status_code == 409


def test_organizer_scope_and_is_test_flag(client):
    api = client
    t, c, m, _ = ready_match(api)
    d = api.dojo("Org")
    org = api.person("Orga", "Nizador", d["id"])
    hdr = login_as(api, "org1", person_id=org["id"])
    api.post(
        f"/persons/{org['id']}/roles",
        {"role": "organizer", "scope_type": "tournament", "scope_id": t["id"]},
        expect=201,
    )
    assert api.raw("GET", f"/persons/{org['id']}", headers=hdr).json()["birth_date"] is not None
    assert (
        api.raw(
            "POST", f"/categories/{c['id']}/bracket", json={"override": {"reason": "regenerar"}}, headers=hdr
        ).status_code
        == 200
    )
    # No puede crear torneos (requiere ámbito global) ni cambiar es_prueba
    r = api.raw("POST", "/tournaments", json={"name": "Otro torneo", "start_date": "2026-11-01"}, headers=hdr)
    assert r.status_code == 403
    cur = api.get(f"/tournaments/{t['id']}")
    r = api.raw("PATCH", f"/tournaments/{t['id']}", json={"version": cur["version"], "is_test": False}, headers=hdr)
    assert r.status_code == 403
    assert (
        api.raw(
            "PATCH", f"/tournaments/{t['id']}", json={"version": cur["version"], "name": "Ok"}, headers=hdr
        ).status_code
        == 200
    )


def test_anonymize_keeps_matches(client):
    api = client
    t, c, m, person = ready_match(api)
    api.finish(m["id"], "aka", override="papel")
    api.post(
        f"/persons/{person['id']}/consents",
        {"given_by": "Madre", "relationship_to_person": "madre", "given_on": "2026-09-01"},
        expect=201,
    )
    assert len(api.get(f"/persons/{person['id']}")["consents"]) == 1
    out = api.post(f"/persons/{person['id']}/anonymize", {"reason": "Solicitud ARCO"})
    assert out["anonymized_at"] and out["documents"] == [] and out["birth_date"] is None
    assert "anonimizado" in out["last_names"]
    assert api.get("/persons?q=70000001") == []
    # El combate sigue existiendo con su resultado
    b = api.get(f"/categories/{c['id']}/bracket")
    assert b["matches"][0]["winner_registration_id"] is not None
    log = api.get(f"/audit?entity=person&entity_id={person['id']}")
    assert all(e["before"] in (None, {"redacted": True}) for e in log)
    assert any(e["action"] == "anonymize" for e in log)


# --- Lecturas con ámbito ------------------------------------------------------


def with_role(api, username, role, scope_type="global", scope_id=None):
    """Cuenta ligada a una persona con un rol; devuelve (cabeceras, persona)."""
    d = api.dojo(f"Rol {username}")
    p = api.person("Cuenta", username, d["id"])
    hdr = login_as(api, username, person_id=p["id"])
    if role:
        body = {"role": role, "scope_type": scope_type, "scope_id": scope_id}
        api.post(f"/persons/{p['id']}/roles", body, expect=201)
    return hdr, p


def scoped_setup(api):
    """Torneo A (tatami con la categoría, combate finalizado) y torneo B aparte."""
    t, c, m, person = ready_match(api)
    t = api.get(f"/tournaments/{t['id']}")
    tat = t["tatamis"][0]
    c = api.get(f"/categories/{c['id']}")
    api.patch(f"/categories/{c['id']}", {"tatami_id": tat["id"], "version": c["version"]})
    api.finish(m["id"], "aka", override="papel")
    reg = api.get(f"/tournaments/{t['id']}/registrations")[0]
    t2, _, _, _ = ready_match(api)
    t2 = api.get(f"/tournaments/{t2['id']}")
    return {"t": t, "c": c, "m": m, "tat": tat, "person": person, "reg": reg, "t2": t2, "tat2": t2["tatamis"][0]}


def tournament_reads(x):
    """Todas las lecturas (GET) de un torneo que exigen ámbito."""
    tid, cid, mid, tat = x["t"]["id"], x["c"]["id"], x["m"]["id"], x["tat"]["id"]
    return [
        f"/tournaments/{tid}",
        f"/tatamis/{tat}/queue",
        f"/tatamis/{tat}/scoresheet.pdf",
        f"/tournaments/{tid}/categories",
        f"/categories/{cid}",
        f"/tournaments/{tid}/registrations",
        f"/tournaments/{tid}/suggestions?person_id={x['person']['id']}",
        f"/tournaments/{tid}/referees",
        f"/categories/{cid}/bracket",
        f"/categories/{cid}/bracket/versions",
        f"/categories/{cid}/bracket.pdf",
        f"/matches/{mid}",
        f"/matches/{mid}/team",
        f"/matches/{mid}/referees",
        f"/categories/{cid}/referees",
        f"/tournaments/{tid}/results",
        f"/tournaments/{tid}/medal-table",
        f"/tournaments/{tid}/comparison-report",
        f"/tournaments/{tid}/results.xlsx",
        f"/tournaments/{tid}/results.pdf",
        f"/tournaments/{tid}/leaders",
        f"/matches/{mid}/summary",
    ]


def status_of(api, path, hdr):
    return api.raw("GET", path, headers=hdr).status_code


def test_reads_are_scoped_to_the_tournament(client):
    api = client
    x = scoped_setup(api)
    tid, tid2, mid = x["t"]["id"], x["t2"]["id"], x["m"]["id"]
    outsiders = {
        "sin roles": with_role(api, "nadie", None)[0],
        "operador de tatami de otro torneo": with_role(api, "optb", "table_operator", "tatami", x["tat2"]["id"])[0],
        "organizador de otro torneo": with_role(api, "orgb", "organizer", "tournament", tid2)[0],
        "árbitro de otro torneo": with_role(api, "refb", "referee", "tournament", tid2)[0],
        "sensei (sin permisos de torneo)": with_role(api, "senb", "sensei", "global")[0],
    }
    for who, hdr in outsiders.items():
        for path in tournament_reads(x):
            assert status_of(api, path, hdr) == 403, f"{who}: GET {path}"
        # La lista de torneos no falla: solo trae los suyos.
        assert tid not in {t["id"] for t in api.raw("GET", "/tournaments", headers=hdr).json()}, who
        assert status_of(api, f"/audit?tournament_id={tid}", hdr) == 403, who
        assert status_of(api, "/audit", hdr) == 403, who
        assert status_of(api, f"/overrides?entity=registration&entity_id={x['reg']['id']}", hdr) == 403, who
        if who != "organizador de otro torneo":  # el staff ve historiales de cualquier persona
            assert status_of(api, f"/persons/{x['person']['id']}/history", hdr) == 403, who
        # Latido de mesa: solo el operador del combate.
        r = api.raw("POST", f"/matches/{mid}/presence", json={"device_id": "tablet-x"}, headers=hdr)
        assert r.status_code == 403, who
        r = api.raw("DELETE", f"/matches/{mid}/presence?device_id=tablet-x", headers=hdr)
        assert r.status_code == 403, who
    # Los del otro torneo sí ven el suyo.
    for who in ("operador de tatami de otro torneo", "organizador de otro torneo", "árbitro de otro torneo"):
        hdr = outsiders[who]
        assert [t["id"] for t in api.raw("GET", "/tournaments", headers=hdr).json()] == [tid2], who
        assert status_of(api, f"/tournaments/{tid2}/results", hdr) == 200, who
    assert api.raw("GET", "/tournaments", headers=outsiders["sin roles"]).json() == []


def test_scoped_roles_read_their_tournament(client):
    api = client
    x = scoped_setup(api)
    tid, mid = x["t"]["id"], x["m"]["id"]
    insiders = {
        "operador de su tatami": with_role(api, "opa", "table_operator", "tatami", x["tat"]["id"])[0],
        "operador del torneo": with_role(api, "opt", "table_operator", "tournament", tid)[0],
        "árbitro del torneo": with_role(api, "refa", "referee", "tournament", tid)[0],
        "organizador del torneo": with_role(api, "orga", "organizer", "tournament", tid)[0],
        "operador global": with_role(api, "opg", "table_operator", "global")[0],
    }
    for who, hdr in insiders.items():
        for path in tournament_reads(x):
            assert status_of(api, path, hdr) == 200, f"{who}: GET {path}"
        assert tid in {t["id"] for t in api.raw("GET", "/tournaments", headers=hdr).json()}, who
    # Mesa: el operador de su tatami marca presencia; el árbitro no opera.
    hdr = insiders["operador de su tatami"]
    assert api.raw("POST", f"/matches/{mid}/presence", json={"device_id": "tablet-a"}, headers=hdr).status_code == 200
    assert api.raw("DELETE", f"/matches/{mid}/presence?device_id=tablet-a", headers=hdr).status_code == 204
    hdr = insiders["árbitro del torneo"]
    assert api.raw("POST", f"/matches/{mid}/presence", json={"device_id": "tablet-r"}, headers=hdr).status_code == 403
    # Personas: solo el organizador (staff) lista y ve historiales ajenos.
    org = insiders["organizador del torneo"]
    assert status_of(api, "/persons", insiders["operador del torneo"]) == 403
    assert status_of(api, "/persons", org) == 200
    assert status_of(api, f"/persons/{x['person']['id']}/history", org) == 200
    assert status_of(api, f"/persons/{x['person']['id']}/stats", insiders["operador del torneo"]) == 403
    assert status_of(api, "/leaders", insiders["operador global"]) == 403
    assert status_of(api, "/leaders", org) == 200
    # Auditoría del torneo: su organizador, con los datos personales redactados.
    log = api.raw("GET", f"/audit?tournament_id={tid}", headers=org).json()
    regs = [e for e in log if e["entity"] == "registration"]
    assert regs and all(e["after"] in (None, {"redacted": True}) for e in regs)
    assert not any(e["entity"] == "person" for e in log)
    full = api.get(f"/audit?tournament_id={tid}")  # el Admin ve el contenido
    assert any(e["entity"] == "registration" and e["after"] not in (None, {"redacted": True}) for e in full)
    assert status_of(api, f"/overrides?entity=registration&entity_id={x['reg']['id']}", org) == 200
    assert status_of(api, "/audit", org) == 403


def test_own_history_and_dojo_reads(client):
    api = client
    d = api.dojo("Propio")
    me = api.person("Yo", "Mismo", d["id"])
    other = api.person("Otro", "Alguien", d["id"])
    hdr = login_as(api, "yomismo", person_id=me["id"])
    assert status_of(api, f"/persons/{me['id']}/history", hdr) == 200
    assert status_of(api, f"/persons/{me['id']}/stats", hdr) == 200
    assert status_of(api, f"/persons/{me['id']}", hdr) == 200
    assert status_of(api, f"/persons/{other['id']}/history", hdr) == 403
    assert status_of(api, f"/persons/{other['id']}", hdr) == 403
    # Dojos: la lista no es dato personal; el historial es de sus miembros y del staff.
    assert status_of(api, "/dojos", hdr) == 200
    assert status_of(api, f"/dojos/{d['id']}/history", hdr) == 200
    ajeno = api.dojo("Ajeno")
    assert status_of(api, f"/dojos/{ajeno['id']}/history", hdr) == 403


def test_role_scope_must_exist(client):
    api = client
    d = api.dojo("Scope")
    p = api.person("Sin", "Ambito", d["id"])
    for scope_type, role in (("tournament", "organizer"), ("dojo", "sensei"), ("tatami", "table_operator")):
        body = {"role": role, "scope_type": scope_type, "scope_id": 9999}
        assert api.raw("POST", f"/persons/{p['id']}/roles", json=body).status_code == 404, scope_type


def test_roles_are_read_once_per_request(client):
    """/auth/me consultaba los roles hasta tres veces; ahora una sola."""
    from sqlalchemy import event

    from app.db import base

    api = client
    hdr, _ = with_role(api, "cache", "organizer", "global")
    seen = []

    def count(conn, cursor, statement, *args):
        if "FROM person_roles" in statement:
            seen.append(statement)

    engine = base.get_engine()
    event.listen(engine, "before_cursor_execute", count)
    try:
        assert api.raw("GET", "/auth/me", headers=hdr).json()["can_view_documents"] is True
    finally:
        event.remove(engine, "before_cursor_execute", count)
    assert len(seen) == 1
