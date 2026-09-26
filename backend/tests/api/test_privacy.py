"""Protección de datos (Ley 29733): anonimización completa, purga de
importaciones y registro de accesos a datos sensibles."""

from datetime import timedelta

from app.db import base
from app.db.models import AuditEntry, ImportBatch, ImportRow, RuleOverride
from tests.api.test_mock_tournament import KUMITE, _xlsx, register, setup_tournament
from tests.api.test_permissions import login_as


def _db():
    return next(base.get_session())


def test_anonymize_redacts_every_trace(client):
    api = client
    t = setup_tournament(api)
    tid = t["id"]
    d = api.dojo("Privado")
    c = api.post(f"/tournaments/{tid}/categories", KUMITE, expect=201)
    p = api.person(
        "Lucía", "Rivas Paz", d["id"], birth="2013-05-05", document={"doc_type": "DNI", "number": "71112223"}
    )
    reg = register(api, tid, p["id"], c["id"], override="Categoría distinta", weight_class="-45")
    # Advertencia aceptada que la nombra y asignación como árbitro (con su nombre en la auditoría).
    db = _db()
    db.add(
        RuleOverride(
            entity="registration", entity_id=reg["id"], code="X", message="Revisar a Lucía Rivas Paz", reason="ok"
        )
    )
    db.commit()
    db.close()
    api.post(f"/tournaments/{tid}/referees", {"person_id": p["id"]})
    tat = api.get(f"/tournaments/{tid}")["tatamis"][0]
    api.post(
        f"/tournaments/{tid}/referee-assignments",
        {"person_id": p["id"], "target_type": "tatami", "target_id": tat["id"]},
    )
    # Una importación en vista previa la menciona como posible duplicado.
    content = _xlsx([["Dojo Privado", "", "", "", "Lucía", "Rivas Paz", "05/05/2013", "F", "8 kyu", "-45", "kumite"]])
    batch = api.post(
        f"/tournaments/{tid}/imports", files={"file": ("x.xlsx", content, "application/octet-stream")}, expect=201
    )
    assert any(dup.get("person_id") == p["id"] for dup in batch["rows"][0]["duplicates"])

    api.post(f"/persons/{p['id']}/anonymize", {"reason": "Solicitud ARCO"})

    db = _db()
    try:
        for e in db.query(AuditEntry).filter(
            AuditEntry.entity == "registration", AuditEntry.entity_id == str(reg["id"])
        ):
            assert e.after in (None, {"redacted": True}) and e.before in (None, {"redacted": True})
        ref = db.query(AuditEntry).filter(AuditEntry.entity == "referee_assignment").all()
        assert ref and all(e.after in (None, {"redacted": True}) for e in ref)
        for ov in db.query(RuleOverride).all():
            assert "Lucía" not in ov.message and "Rivas" not in ov.message
        row = db.query(ImportRow).filter(ImportRow.batch_id == batch["id"]).one()
        dup = next(x for x in row.duplicates if x.get("person_id") == p["id"])
        assert "Rivas" not in dup["full_name"] and dup["birth_date"] is None
    finally:
        db.close()
    # Nada con su nombre en lo que ve el Admin.
    assert "Rivas" not in str(api.get(f"/audit?tournament_id={tid}"))


def test_import_rows_are_purged_on_confirm_cancel_and_age(client):
    api = client
    t = setup_tournament(api)
    tid = t["id"]
    api.post(f"/tournaments/{tid}/categories", KUMITE, expect=201)
    row = ["Dojo Purga", "", "DNI", "76543210", "Rosa", "Purga", "01/02/2013", "F", "8 kyu", "-45", "kumite"]
    files = {"file": ("p.xlsx", _xlsx([row]), "application/octet-stream")}
    b1 = api.post(f"/tournaments/{tid}/imports", files=files, expect=201)
    assert b1["rows"][0]["data"]["numero_documento"] == "76543210"
    api.post(f"/imports/{b1['id']}/confirm", {"override": {"reason": "confirmado"}})
    data = api.get(f"/imports/{b1['id']}")["rows"][0]["data"]
    assert "numero_documento" not in data and "fecha_nacimiento" not in data and data["nombres"] == "Rosa"
    # La persona sí conserva su documento (lo ve el Admin en la ficha).
    b2 = api.post(f"/tournaments/{tid}/imports", files=files, expect=201)
    assert all("birth_date" in d for d in b2["rows"][0]["duplicates"] if "person_id" in d)
    api.raw("POST", f"/imports/{b2['id']}/cancel").raise_for_status()
    r2 = api.get(f"/imports/{b2['id']}")["rows"][0]
    assert "numero_documento" not in r2["data"] and all("birth_date" not in d for d in r2["duplicates"])
    # Lotes de más de 30 días: se borran sus filas (bajo demanda o con el comando).
    b3 = api.post(f"/tournaments/{tid}/imports", files=files, expect=201)
    db = _db()
    db.get(ImportBatch, b3["id"]).created_at -= timedelta(days=31)
    db.commit()
    db.close()
    res = api.post("/imports/purge")
    assert res == {"batches": 1, "rows": 1, "expired_previews": 1}
    assert api.get(f"/imports/{b3['id']}")["rows"] == []
    assert api.get(f"/imports/{b3['id']}")["status"] == "cancelled"
    assert api.get(f"/imports/{b1['id']}")["rows"]  # los recientes no se tocan
    hdr = login_as(api, "nopurga")
    assert api.raw("POST", "/imports/purge", headers=hdr).status_code == 403


def test_purge_command(client, capsys):
    from app.seed import cmd_purge_imports

    cmd_purge_imports(30)
    assert "0 lotes" in capsys.readouterr().out


def test_sensitive_views_are_logged(client):
    api = client
    d = api.dojo("Vista")
    with_doc = api.person("Con", "Documento", d["id"], document={"doc_type": "DNI", "number": "70001234"})
    api.get(f"/persons/{with_doc['id']}")
    api.get(f"/persons/{with_doc['id']}")  # la segunda vez no duplica el registro
    views = [e for e in api.get(f"/audit?entity=person&entity_id={with_doc['id']}") if e["action"] == "view_sensitive"]
    assert len(views) == 1 and views[0]["user"] == "admin"
    # Sin documentos que mostrar (usuario sin privilegios viendo su propia ficha) no se registra.
    me = api.person("Sin", "Privilegio", d["id"])
    hdr = login_as(api, "sinpriv", person_id=me["id"])
    assert api.raw("GET", f"/persons/{me['id']}", headers=hdr).json()["birth_date"] is None
    views = [e for e in api.get(f"/audit?entity=person&entity_id={me['id']}") if e["action"] == "view_sensitive"]
    assert views == []
    # La lista no registra accesos (no es la ficha individual).
    api.get("/persons?q=Documento")
    views = [e for e in api.get(f"/audit?entity=person&entity_id={with_doc['id']}") if e["action"] == "view_sensitive"]
    assert len(views) == 1
