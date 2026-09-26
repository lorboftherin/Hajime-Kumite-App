"""Autoinscripción por dojo: invitación, portal del sensei y aprobación del organizador."""

from datetime import UTC, datetime, timedelta

from tests.api.test_mock_tournament import KUMITE, register, setup_tournament
from tests.api.test_organizaciones import as_user
from tests.api.test_permissions import login_as


def sensei(api, username, dojo_id, first="Kenji"):
    """Cuenta de sensei ligada a una persona del dojo."""
    p = api.person(first, "Sensei", dojo_id, birth="1980-01-01", grade="3 dan")
    return as_user(api, login_as(api, username, person_id=p["id"])), p


def open_tournament(api):
    t = setup_tournament(api, is_test=False)
    c = api.post(f"/tournaments/{t['id']}/categories", KUMITE, expect=201)
    api.c.put(f"/api/v1/tournaments/{t['id']}/self-registration", json={"open": True})
    return t, c


def test_flujo_completo_con_aprobacion(client):
    api = client
    kaze = api.dojo("Kaze")
    otro = api.dojo("Otro")
    t, c = open_tournament(api)
    assert api.get(f"/tournaments/{t['id']}")["self_registration_open"] is True

    # Invitación del dojo: el primer sensei queda como admin del dojo.
    inv = api.post(f"/tournaments/{t['id']}/invitations", {"dojo_id": kaze["id"]}, expect=201)
    assert inv["dojo_name"] == "Dojo Kaze" and len(inv["token"]) > 20
    s1, _ = sensei(api, "sensei1", kaze["id"])
    info = s1.get(f"/invitations/{inv['token']}")
    assert info["dojo_id"] == kaze["id"] and info["already_admin"] is False and info["self_registration_open"]
    assert s1.post(f"/invitations/{inv['token']}/accept", {})["status"] == "granted"
    assert s1.post(f"/invitations/{inv['token']}/accept", {})["status"] == "already_admin"
    me = s1.get("/auth/me")
    assert me["dojo_admin_of"] == [kaze["id"]] and me["can_view_documents"] is False
    assert [d["id"] for d in s1.get("/dojo-portal/dojos")] == [kaze["id"]]

    # Un segundo sensei con el mismo enlace necesita la aprobación del organizador.
    s2, _ = sensei(api, "sensei2", kaze["id"], first="Hiro")
    assert s2.post(f"/invitations/{inv['token']}/accept", {})["status"] == "pending_approval"
    reqs = api.get(f"/tournaments/{t['id']}/registration-requests")
    assert reqs["count"] == 1 and reqs["dojo_admin_requests"][0]["current_admins"] == ["Kenji Sensei"]
    api.post(f"/dojo-admin-requests/{reqs['dojo_admin_requests'][0]['id']}/decide", {"approve": True})
    assert s2.get("/auth/me")["dojo_admin_of"] == [kaze["id"]]

    # «Mis competidores»: solo los del dojo, con documento y fecha de nacimiento.
    alumno = api.person("Diego", "Ramos", kaze["id"], document={"doc_type": "DNI", "number": "71234567"})
    ajeno = api.person("Luis", "Ajeno", otro["id"])
    comps = s1.get(f"/dojo-portal/dojos/{kaze['id']}/competitors")
    names = {p["first_names"] for p in comps}
    assert "Diego" in names and "Luis" not in names
    diego = next(p for p in comps if p["first_names"] == "Diego")
    assert diego["birth_date"] and diego["documents"][0]["number"] == "71234567"
    assert s1.get(f"/persons/{alumno['id']}")["birth_date"] is not None  # ficha de su alumno
    assert s1.raw("GET", f"/persons/{ajeno['id']}").status_code == 403
    assert s1.raw("GET", f"/dojo-portal/dojos/{otro['id']}/competitors").status_code == 403
    assert (
        s1.raw("PATCH", f"/dojo-portal/dojos/{kaze['id']}/competitors/{ajeno['id']}", json={"version": 1}).status_code
        == 403
    )
    # Alta y edición de un competidor del dojo
    nuevo = s1.post(
        f"/dojo-portal/dojos/{kaze['id']}/competitors",
        {"first_names": "Mateo", "last_names": "Huamán", "sex": "M", "birth_date": "2013-06-01", "grade": "8 kyu"},
        expect=201,
    )
    assert nuevo["current_dojo_id"] == kaze["id"]
    edit = s1.patch(
        f"/dojo-portal/dojos/{kaze['id']}/competitors/{nuevo['id']}",
        {"version": nuevo["version"], "last_names": "Huamán Torres"},
    )
    assert edit["last_names"] == "Huamán Torres"

    # «Inscribir en torneo»: torneos abiertos, categorías y sugerencias.
    assert [x["id"] for x in s1.get("/dojo-portal/tournaments")] == [t["id"]]
    cats = s1.get(f"/dojo-portal/dojos/{kaze['id']}/tournaments/{t['id']}/categories")
    assert [x["id"] for x in cats] == [c["id"]]
    sug = s1.get(f"/dojo-portal/dojos/{kaze['id']}/tournaments/{t['id']}/suggestions?person_id={nuevo['id']}")
    assert [x["category_id"] for x in sug] == [c["id"]]
    base = f"/dojo-portal/dojos/{kaze['id']}/tournaments/{t['id']}/registrations"
    # Persona de otro dojo: prohibido
    r = s1.raw("POST", base, json={"items": [{"person_id": ajeno["id"], "category_id": c["id"]}]})
    assert r.status_code == 403
    # Mismas advertencias que el organizador (peso distinto): 409 WARNINGS, luego con motivo.
    items = [
        {"person_id": nuevo["id"], "category_id": c["id"], "weight_class": "-45"},
        {"person_id": alumno["id"], "category_id": c["id"], "weight_class": "-50"},
    ]
    r = s1.raw("POST", base, json={"items": items})
    assert r.status_code == 409 and r.json()["error"]["code"] == "WARNINGS"
    assert "Diego Ramos" in r.json()["error"]["details"]["warnings"][0]["message"]
    created = s1.post(base, {"items": items, "override": {"reason": "El peso se confirma en el pesaje"}}, expect=201)
    assert {x["status"] for x in created} == {"pending"} and created[0]["tournament_name"] == t["name"]
    # Otra vez lo mismo: ya está pendiente
    assert s1.raw("POST", base, json={"items": items[:1]}).status_code == 409

    # Las pendientes no cuentan ni entran a la llave ni a la lista normal.
    assert api.get(f"/categories/{c['id']}")["entrant_count"] == 0
    assert api.get(f"/tournaments/{t['id']}/registrations") == []
    assert len(api.get(f"/tournaments/{t['id']}/registrations?status=pending")) == 2
    assert api.get(f"/tournaments/{t['id']}/registration-requests/count")["count"] == 2

    # El organizador aprueba una y rechaza la otra con motivo.
    ids = {x["person_id"]: x["id"] for x in created}
    out = api.post(
        f"/tournaments/{t['id']}/registration-requests/decide", {"ids": [ids[nuevo["id"]]], "action": "approve"}
    )
    assert out["approved"] == [ids[nuevo["id"]]]
    r = api.raw(
        "POST",
        f"/tournaments/{t['id']}/registration-requests/decide",
        json={"ids": [ids[alumno["id"]]], "action": "reject"},
    )
    assert r.status_code == 409  # rechazar pide motivo
    api.post(
        f"/tournaments/{t['id']}/registration-requests/decide",
        {"ids": [ids[alumno["id"]]], "action": "reject", "reason": "Peso fuera de la categoría"},
    )
    assert api.get(f"/categories/{c['id']}")["entrant_count"] == 1
    mine = {x["person_id"]: x for x in s1.get(f"/dojo-portal/dojos/{kaze['id']}/registrations?tournament_id={t['id']}")}
    assert mine[nuevo["id"]]["status"] == "active"
    assert (
        mine[alumno["id"]]["status"] == "rejected"
        and mine[alumno["id"]]["rejection_reason"] == "Peso fuera de la categoría"
    )
    assert api.get(f"/tournaments/{t['id']}/registration-requests")["count"] == 0

    # Con un segundo inscrito activo la llave usa solo los activos.
    otro_alumno = api.person("Pedro", "Kaze", kaze["id"])
    register(api, t["id"], otro_alumno["id"], c["id"], weight_class="-45")
    b = api.post(f"/categories/{c['id']}/bracket", {"seed": 1})
    assert len([x for x in b["matches"] if x["aka_registration_id"] or x["ao_registration_id"]]) == 1

    # El sensei no ve el torneo como organizador ni aprueba.
    assert s1.raw("GET", f"/tournaments/{t['id']}").status_code == 403
    assert s1.raw("GET", f"/tournaments/{t['id']}/registration-requests").status_code == 403

    # Cierre: ya no se aceptan pedidos.
    api.c.put(f"/api/v1/tournaments/{t['id']}/self-registration", json={"open": False})
    assert s1.get("/dojo-portal/tournaments") == []
    r = s1.raw(
        "POST", base, json={"items": [{"person_id": alumno["id"], "category_id": c["id"], "weight_class": "-45"}]}
    )
    assert r.status_code == 409 and r.json()["error"]["code"] == "SELF_REGISTRATION_CLOSED"


def test_fecha_de_cierre_y_retiro_del_pedido(client):
    api = client
    kaze = api.dojo("Kaze")
    t, c = open_tournament(api)
    s1, _ = sensei(api, "sensei1", kaze["id"])
    inv = api.post(f"/tournaments/{t['id']}/invitations", {"dojo_id": kaze["id"]}, expect=201)
    s1.post(f"/invitations/{inv['token']}/accept", {})
    p = api.person("Ana", "Kaze", kaze["id"], sex="F")
    base = f"/dojo-portal/dojos/{kaze['id']}/tournaments/{t['id']}/registrations"
    body = {
        "items": [{"person_id": p["id"], "category_id": c["id"], "weight_class": "-45"}],
        "override": {"reason": "prueba mixta"},
    }
    reg = s1.post(base, body, expect=201)[0]
    out = s1.post(f"/dojo-portal/dojos/{kaze['id']}/registrations/{reg['id']}/cancel")
    assert out["status"] == "withdrawn"
    # Fecha de cierre vencida
    past = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
    api.c.put(f"/api/v1/tournaments/{t['id']}/self-registration", json={"open": True, "closes_at": past})
    assert s1.raw("POST", base, json=body).json()["error"]["code"] == "SELF_REGISTRATION_CLOSED"
    # Revocar la invitación: el enlace deja de existir
    api.raw("DELETE", f"/invitations/{inv['id']}")
    assert s1.raw("GET", f"/invitations/{inv['token']}").status_code == 404


def test_enlace_general_pide_aprobacion(client):
    api = client
    kaze = api.dojo("Kaze")
    t, _ = open_tournament(api)
    inv = api.post(f"/tournaments/{t['id']}/invitations", {}, expect=201)
    assert inv["dojo_id"] is None
    s1, _ = sensei(api, "sensei1", kaze["id"])
    r = s1.raw("POST", f"/invitations/{inv['token']}/accept", json={})
    assert r.status_code == 409 and r.json()["error"]["code"] == "DOJO_REQUIRED"
    assert s1.post(f"/invitations/{inv['token']}/accept", {"dojo_id": kaze["id"]})["status"] == "pending_approval"
    assert s1.get("/auth/me")["dojo_admin_of"] == []
    req = api.get(f"/tournaments/{t['id']}/registration-requests")["dojo_admin_requests"][0]
    out = api.post(f"/dojo-admin-requests/{req['id']}/decide", {"approve": False})
    assert out["status"] == "rejected" and s1.get("/auth/me")["dojo_admin_of"] == []
    # Cuenta sin persona: no puede ser admin de dojo
    sin = as_user(api, login_as(api, "sinpersona"))
    r = sin.raw("POST", f"/invitations/{inv['token']}/accept", json={"dojo_id": kaze["id"]})
    assert r.json()["error"]["code"] == "PERSON_REQUIRED"
    # Sin rol de dojo no se usa el portal
    assert sin.raw("GET", "/dojo-portal/tournaments").status_code == 403
