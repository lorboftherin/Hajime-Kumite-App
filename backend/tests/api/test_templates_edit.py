"""Plantillas de categorías: edición, duplicado, borrado/archivo, filas y Excel."""

import io

from openpyxl import load_workbook

ITEM = {"code": "K1", "name": "Kumite 10-11 M -35", "modality": "kumite", "sex": "M", "age_min": 10, "age_max": 11}


def _tpl(api, name="Base", items=None):
    return api.post("/templates", {"name": name, "items": items if items is not None else [ITEM]}, expect=201)


def _login(api, username):
    api.post("/users", {"username": username, "password": "secret123"}, expect=201)
    tok = api.c.post("/api/v1/auth/login", json={"username": username, "password": "secret123"}).json()
    return {"Authorization": f"Bearer {tok['access_token']}"}


def test_edit_name_description_and_version(client):
    api = client
    t = _tpl(api)
    assert t["can_edit"] is True and t["in_use"] is False
    t2 = api.patch(f"/templates/{t['id']}", {"version": t["version"], "name": "Nacional", "description": "2026"})
    assert (t2["name"], t2["description"], t2["version"]) == ("Nacional", "2026", t["version"] + 1)
    stale = api.raw("PATCH", f"/templates/{t['id']}", json={"version": t["version"], "name": "Otra"})
    assert stale.status_code == 409 and stale.json()["error"]["code"] == "VERSION_CONFLICT"


def test_item_crud_and_duplicate_codes(client):
    api = client
    t = _tpl(api)
    it = api.post(f"/templates/{t['id']}/items", {**ITEM, "code": "K2", "name": "Kumite 12-13"}, expect=201)
    assert it["sort_order"] == 1
    dup = api.raw("POST", f"/templates/{t['id']}/items", json={**ITEM})
    assert dup.status_code == 409 and dup.json()["error"]["code"] == "DUPLICATE_CODE"
    upd = api.patch(f"/templates/{t['id']}/items/{it['id']}", {"weight_class": "-40", "age_max": 13})
    assert (upd["weight_class"], upd["age_max"]) == ("-40", 13)
    assert api.raw("PATCH", f"/templates/{t['id']}/items/{it['id']}", json={"code": "K1"}).status_code == 409
    assert api.raw("PATCH", f"/templates/{t['id']}/items/{it['id']}", json={"name": None}).status_code == 409
    api.raw("DELETE", f"/templates/{t['id']}/items/{it['id']}")
    t = api.get(f"/templates/{t['id']}")
    assert [i["code"] for i in t["items"]] == ["K1"]
    # Una fila de otra plantilla no se toca desde esta.
    other = _tpl(api, "Otra")
    assert api.raw("DELETE", f"/templates/{other['id']}/items/{t['items'][0]['id']}").status_code == 404


def test_replace_items_as_table(client):
    api = client
    t = _tpl(api, items=[ITEM, {**ITEM, "code": "K2", "name": "B"}])
    k1, k2 = t["items"]
    rows = [
        {**{k: v for k, v in k2.items()}, "name": "B editada"},
        {**ITEM, "code": "K3", "name": "Nueva"},
    ]
    out = api.c.put(f"/api/v1/templates/{t['id']}/items", json={"version": t["version"], "items": rows})
    assert out.status_code == 200, out.text
    out = out.json()
    assert [(i["code"], i["name"], i["sort_order"]) for i in out["items"]] == [
        ("K2", "B editada", 0),
        ("K3", "Nueva", 1),
    ]
    assert out["items"][0]["id"] == k2["id"]
    # Códigos repetidos: nada cambia.
    bad = api.c.put(
        f"/api/v1/templates/{t['id']}/items", json={"version": out["version"], "items": [{**ITEM}, {**ITEM}]}
    )
    assert bad.status_code == 409
    assert len(api.get(f"/templates/{t['id']}")["items"]) == 2
    assert k1["id"] not in {i["id"] for i in out["items"]}


def test_duplicate_template(client):
    api = client
    t = _tpl(api, items=[ITEM, {**ITEM, "code": "K2", "name": "B"}])
    copy = api.post(f"/templates/{t['id']}/duplicate", {}, expect=201)
    assert copy["name"] == "Base (copia)" and [i["code"] for i in copy["items"]] == ["K1", "K2"]
    assert {i["id"] for i in copy["items"]}.isdisjoint({i["id"] for i in t["items"]})
    named = api.post(f"/templates/{t['id']}/duplicate", {"name": "Regional"}, expect=201)
    assert named["name"] == "Regional"


def test_delete_unused_and_archive_used(client):
    api = client
    free = _tpl(api, "Libre")
    assert api.c.delete(f"/api/v1/templates/{free['id']}").json() == {
        "id": free["id"],
        "deleted": True,
        "archived": False,
    }
    assert api.raw("GET", f"/templates/{free['id']}").status_code == 404

    used = _tpl(api, "Usada")
    api.post(
        "/tournaments", {"name": "Con plantilla", "start_date": "2026-10-17", "template_id": used["id"]}, expect=201
    )
    assert api.get(f"/templates/{used['id']}")["in_use"] is True
    out = api.c.delete(f"/api/v1/templates/{used['id']}").json()
    assert out == {"id": used["id"], "deleted": False, "archived": True}
    assert used["id"] not in {t["id"] for t in api.get("/templates")}
    assert used["id"] in {t["id"] for t in api.get("/templates", params={"include_archived": True})}
    tpl = api.get(f"/templates/{used['id']}")
    restored = api.patch(f"/templates/{used['id']}", {"version": tpl["version"], "is_archived": False})
    assert restored["is_archived"] is False


def test_excel_export_import_roundtrip(client):
    api = client
    items = [
        {**ITEM, "grade_min": 1, "grade_max": 4, "weight_class": "-35", "duration_seconds": 90},
        {
            "code": "KT1",
            "name": "Kata equipos",
            "modality": "kata",
            "sex": "X",
            "is_team": True,
            "kata_method": "flags",
        },
    ]
    t = _tpl(api, "Exportable", items)
    r = api.raw("GET", f"/templates/{t['id']}/export.xlsx")
    assert r.status_code == 200
    ws = load_workbook(io.BytesIO(r.content))["Categorías"]
    assert ws.cell(row=2, column=8).value == "10 kyu" and ws.cell(row=2, column=9).value == "7 kyu"

    files = {"file": ("nueva.xlsx", r.content, "application/octet-stream")}
    new = api.raw("POST", "/templates/import", files=files)
    assert new.status_code == 201, new.text
    new = new.json()
    assert new["name"] == "Exportable"
    fields = ("code", "modality", "sex", "is_team", "grade_min", "grade_max", "weight_class", "duration_seconds")
    assert [{k: i[k] for k in fields} for i in new["items"]] == [{k: i[k] for k in fields} for i in t["items"]]

    # Reemplazar las filas de una plantilla existente.
    target = _tpl(api, "Destino")
    rep = api.raw("POST", "/templates/import", params={"template_id": target["id"]}, files=files)
    assert rep.status_code == 201 and [i["code"] for i in rep.json()["items"]] == ["K1", "KT1"]

    bad = api.raw("POST", "/templates/import", files={"file": ("x.xlsx", b"no es excel", "application/octet-stream")})
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "INVALID_FILE"


def test_excel_import_reports_row_errors(client):
    from openpyxl import Workbook

    from app.services.templates import EXCEL_COLUMNS

    api = client
    wb = Workbook()
    ws = wb.active
    ws.title = "Categorías"
    ws.append([label for _, label in EXCEL_COLUMNS])
    ws.append(["A1", "Sin modalidad", "", "no", "M"])
    ws.append(["A2", "Grado raro", "kumite", "no", "F", "", "", "12 kyu"])
    buf = io.BytesIO()
    wb.save(buf)
    r = api.raw("POST", "/templates/import", files={"file": ("e.xlsx", buf.getvalue(), "application/octet-stream")})
    assert r.status_code == 400
    errors = r.json()["error"]["details"]["errors"]
    assert any("Fila 2" in e for e in errors) and any("Fila 3" in e for e in errors)


def test_permissions(client):
    api = client
    t = _tpl(api)
    h = _login(api, "lector")
    assert api.raw("GET", "/templates", headers=h).status_code == 200
    assert api.raw("GET", "/templates", headers=h).json()[0]["can_edit"] is False
    assert api.raw("POST", "/templates", json={"name": "X"}, headers=h).status_code == 403
    assert api.raw("PATCH", f"/templates/{t['id']}", json={"version": 1, "name": "Y"}, headers=h).status_code == 403
    assert api.raw("POST", f"/templates/{t['id']}/duplicate", json={}, headers=h).status_code == 403
    assert api.raw("DELETE", f"/templates/{t['id']}", headers=h).status_code == 403
    # Plantillas globales: solo el Admin. Un organizador con rol global no las edita.
    p = api.person("Orga", "Nizadora", api.dojo("Org")["id"])
    api.post(f"/persons/{p['id']}/roles", {"role": "organizer", "scope_type": "global"}, expect=201)
    api.post("/users", {"username": "orga", "password": "secret123", "person_id": p["id"]}, expect=201)
    tok = api.c.post("/api/v1/auth/login", json={"username": "orga", "password": "secret123"}).json()["access_token"]
    ho = {"Authorization": f"Bearer {tok}"}
    assert api.raw("PATCH", f"/templates/{t['id']}", json={"version": 1, "name": "Y"}, headers=ho).status_code == 403
    assert api.raw("POST", "/templates", json={"name": "Global"}, headers=ho).status_code == 403


def test_templates_by_organization(client):
    from tests.api.test_organizaciones import org_with_owner

    api = client
    glob = _tpl(api, "Global")
    org_a, owner_a, _ = org_with_owner(api, "Liga de Lima", "duena_a")
    org_b, owner_b, _ = org_with_owner(api, "Liga del Callao", "duena_b")
    # Sin indicar organización, la plantilla es de la suya.
    mine = owner_a.post("/templates", {"name": "Liga Lima 2026", "items": [ITEM]}, expect=201)
    assert mine["organization_id"] == org_a["id"] and mine["can_edit"] is True
    assert owner_a.raw("POST", "/templates", json={"name": "Ajena", "organization_id": org_b["id"]}).status_code == 403
    # Cada organización ve las globales y las suyas.
    seen_a = {t["id"] for t in owner_a.get("/templates")}
    seen_b = {t["id"] for t in owner_b.get("/templates")}
    assert {glob["id"], mine["id"]} <= seen_a
    assert glob["id"] in seen_b and mine["id"] not in seen_b
    assert owner_b.raw("GET", f"/templates/{mine['id']}").status_code == 404
    assert owner_b.raw("PATCH", f"/templates/{mine['id']}", json={"version": 1, "name": "X"}).status_code == 404
    # La global no la edita, pero la duplica en su organización.
    g = next(t for t in owner_a.get("/templates") if t["id"] == glob["id"])
    assert g["can_edit"] is False
    assert owner_a.raw("PATCH", f"/templates/{glob['id']}", json={"version": 1, "name": "X"}).status_code == 403
    copy = owner_a.post(f"/templates/{glob['id']}/duplicate", {}, expect=201)
    assert copy["organization_id"] == org_a["id"] and copy["can_edit"] is True
    upd = owner_a.patch(f"/templates/{mine['id']}", {"version": mine["version"], "description": "Oficial"})
    assert upd["description"] == "Oficial"
    # El Admin ve todas.
    assert {glob["id"], mine["id"], copy["id"]} <= {t["id"] for t in api.get("/templates")}
