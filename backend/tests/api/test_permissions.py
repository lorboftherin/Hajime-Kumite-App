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
    p = api.raw("GET", f"/persons/{person['id']}", headers=hdr).json()
    assert p["birth_date"] is None and p["documents"] == []
    # Buscar por DNI no encuentra nada sin privilegios
    assert api.raw("GET", "/persons?q=70000001", headers=hdr).json() == []
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
