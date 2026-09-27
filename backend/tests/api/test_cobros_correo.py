"""Cobros integrados con cuentas: recibos por correo, avisos de vencimiento,
Competidor Plus por persona (propia o de un menor a cargo) y notas de crédito."""

# ruff: noqa: F811 - las fixtures de test_cobros se importan y se piden por nombre
from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.db.models import Guardianship, Invoice, OutboxEmail, Person, Subscription, User
from app.services import billing_mail, entitlements, mail
from tests.api.test_cobros import (  # noqa: F401 - fixtures
    db_session,
    gw,
    mp,
    mp_notify,
    mp_payment,
    nubefact,
)
from tests.api.test_organizaciones import as_user, org_with_owner
from tests.api.test_permissions import login_as

# Los cobros vienen apagados (HAJIME_PAYMENTS_ENABLED=false): aquí se prueba su código.
pytestmark = pytest.mark.usefixtures("cobros_activos")


@pytest.fixture(autouse=True)
def _limpiar_correo():
    mail.CONSOLE_OUTBOX.clear()
    yield
    mail.CONSOLE_OUTBOX.clear()


def set_email(uid: int, email: str) -> None:
    db = db_session()
    db.get(User, uid).email = email
    db.commit()


def outbox(kind: str | None = None) -> list[OutboxEmail]:
    q = db_session().query(OutboxEmail)
    if kind:
        q = q.filter(OutboxEmail.kind == kind)
    return q.order_by(OutboxEmail.id).all()


def now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def pay_org(api, mp, owner, org, pid: int, period: str = "year", amount: float = 690.0):
    mp.on("POST", "/checkout/preferences", (201, {"id": f"pref-{pid}", "init_point": "https://mp.test/p"}))
    co = owner.post(f"/organizations/{org['id']}/checkout", {"plan_code": "dojo", "period": period})
    ref = mp.called("POST", "/checkout/preferences")[-1]["body"]["external_reference"]
    mp.on("GET", f"/v1/payments/{pid}", (200, mp_payment(pid, ref, amount)))
    mp_notify(api, "payment", str(pid))
    return co, ref


def test_recibo_y_rechazo_por_correo_a_los_duenios(client, mp, nubefact):
    api = client
    org, owner, owner_id = org_with_owner(api, "Liga Correo", "duena_correo")
    set_email(owner_id, "duena@example.com")
    # Un administrador (no dueño) no recibe los avisos de cobro.
    hdr = login_as(api, "admin_liga")
    uid = api.raw("GET", "/auth/me", headers=hdr).json()["id"]
    set_email(uid, "admin@example.com")
    api.post(f"/organizations/{org['id']}/members", {"user_id": uid, "role": "admin"}, expect=201)

    mp.on("POST", "/api/v1/ruta-falsa", (200, {"aceptada_por_sunat": True, "enlace_del_pdf": "https://nf.test/b.pdf"}))
    co, ref = pay_org(api, mp, owner, org, 4401)
    mails = outbox("payment_approved")
    assert [m.to_address for m in mails] == ["duena@example.com"]
    m = mails[0]
    assert "S/ 690.00" in m.text and "Dojo" in m.text and "1 año" in m.text
    assert "BBB1-00000001" in m.text and "https://nf.test/b.pdf" in m.html and "<html" in m.html
    # Aviso repetido: no se manda otro recibo.
    mp_notify(api, "payment", "4401")
    assert len(outbox("payment_approved")) == 1

    # Renovación rechazada: correo de pago no completado con la fecha de gracia.
    mp.on("GET", "/v1/payments/4402", (200, mp_payment(4402, ref, 690.0, status="rejected")))
    mp_notify(api, "payment", "4402")
    rej = outbox("payment_rejected")
    assert len(rej) == 1 and "Mantienes el acceso hasta el" in rej[0].text
    # Sin dueños con correo: va al correo para comprobantes de la organización.
    db = db_session()
    db.get(User, owner_id).email = None
    db.commit()
    ver = owner.get(f"/organizations/{org['id']}")["version"]
    owner.patch(f"/organizations/{org['id']}", {"version": ver, "billing_email": "pagos@liga.test"})
    assert billing_mail.recipients(db_session(), db_session().get(Subscription, co["subscription_id"])) == [
        "pagos@liga.test"
    ]


def test_avisos_de_vencimiento_7_1_y_gracia_sin_repetir(client, gw):
    api = client
    org, owner, owner_id = org_with_owner(api, "Dojo Aviso", "duena_aviso")
    set_email(owner_id, "aviso@example.com")
    db = db_session()
    sub = Subscription(
        organization_id=org["id"],
        plan_code="dojo",
        status="active",
        source="payment",
        current_period_end=now() + timedelta(days=6, hours=2),
    )
    rec = Subscription(
        organization_id=org["id"],
        plan_code="organizador",
        status="active",
        source="payment",
        provider="mercadopago",
        provider_subscription_id="pre-1",
        current_period_end=now() - timedelta(days=1),
    )
    far = Subscription(
        organization_id=org["id"], plan_code="dojo", status="active", current_period_end=now() + timedelta(days=40)
    )
    db.add_all([sub, rec, far])
    db.commit()

    assert billing_mail.send_reminders(db) == 2
    kinds = sorted(m.kind for m in outbox())
    assert kinds == ["billing_d7", "billing_grace"]
    d7 = outbox("billing_d7")[0]
    assert "vence en 7 días" in d7.subject and d7.to_address == "aviso@example.com"
    # Otra vuelta el mismo día (u otro proceso): no se repite.
    assert billing_mail.send_reminders(db) == 0
    # El día anterior al vencimiento: el aviso de 1 día.
    assert billing_mail.send_reminders(db, now() + timedelta(days=5, hours=12)) == 1
    assert "vence mañana" in outbox("billing_d1")[0].subject
    assert billing_mail.send_reminders(db, now() + timedelta(days=5, hours=14)) == 0
    # Renovado: el aviso vuelve a correr para el nuevo periodo.
    db.refresh(sub)
    sub.current_period_end = now() + timedelta(days=3)
    db.commit()
    assert billing_mail.send_reminders(db) == 1


def test_competidor_plus_por_persona_y_tutor(client, mp, nubefact):
    api = client
    d = api.dojo("Plus Familia")
    hijo = api.person("Leo", "Menor", d["id"])
    ajeno = api.person("Otro", "Ajeno", d["id"])
    hdr = login_as(api, "papa_plus")
    papa = as_user(api, hdr)
    uid = api.raw("GET", "/auth/me", headers=hdr).json()["id"]
    set_email(uid, "papa@example.com")
    db = db_session()
    db.add(Guardianship(user_id=uid, person_id=hijo["id"], relation="parent"))
    db.commit()

    body = {"plan_code": "competidor_plus", "period": "year", "person_id": ajeno["id"]}
    assert papa.raw("POST", "/me/checkout", json=body).status_code == 403
    mp.on("POST", "/checkout/preferences", (201, {"id": "pref-h", "init_point": "https://mp.test/h"}))
    co = papa.post("/me/checkout", {**body, "person_id": hijo["id"], "billing_doc": "40404040"})
    sub = db_session().get(Subscription, co["subscription_id"])
    assert sub.person_id == hijo["id"] and sub.user_id is None and sub.created_by_id == uid
    ref = mp.called("POST", "/checkout/preferences")[-1]["body"]["external_reference"]
    mp.on("POST", "/api/v1/ruta-falsa", (200, {"aceptada_por_sunat": True}))
    mp.on("GET", "/v1/payments/5501", (200, mp_payment(5501, ref, 49.0)))
    mp_notify(api, "payment", "5501")

    # Los derechos son de la persona (el hijo), no de la cuenta del padre.
    db = db_session()
    person = db.get(Person, hijo["id"])
    assert entitlements.billing_mode() == "enforced"
    assert entitlements.has(db, person, "plus_insights") and entitlements.has(db, person, "certificates")
    assert not entitlements.has(db, db.get(Person, ajeno["id"]), "plus_insights")
    # El padre ve la suscripción, el pago y el recibo; el comprobante lleva el nombre del hijo.
    assert [s["person_id"] for s in papa.get("/me/subscriptions")] == [hijo["id"]]
    pays = papa.get("/me/payments")
    assert pays[0]["person_name"] == "Leo Menor"
    inv = db.query(Invoice).one()
    assert inv.customer_name == "Leo Menor" and inv.customer_doc == "40404040"
    assert [m.to_address for m in outbox("payment_approved")] == ["papa@example.com"]
    # Puede cancelarlo; otra cuenta no.
    otro = as_user(api, login_as(api, "otro_plus"))
    assert otro.raw("POST", f"/subscriptions/{sub.id}/cancel").status_code == 403
    assert papa.post(f"/subscriptions/{sub.id}/cancel")["cancel_at_period_end"]

    # La propia persona (adulta con cuenta ligada) también puede pagar su Plus.
    adulta = api.person("Ana", "Adulta", d["id"], birth="1990-01-01")
    hdr2 = login_as(api, "ana_adulta", person_id=adulta["id"])
    ana = as_user(api, hdr2)
    mp.on("POST", "/checkout/preferences", (201, {"id": "pref-a", "init_point": "https://mp.test/a"}))
    co2 = ana.post("/me/checkout", {"plan_code": "competidor_plus", "period": "year", "person_id": adulta["id"]})
    assert db_session().get(Subscription, co2["subscription_id"]).person_id == adulta["id"]


def test_nota_de_credito_al_reembolsar(client, mp, nubefact):
    api = client
    org, owner, _ = org_with_owner(api, "Liga Nota", "duena_nota")
    ver = owner.get(f"/organizations/{org['id']}")["version"]
    owner.patch(f"/organizations/{org['id']}", {"version": ver, "tax_id": "20999999991", "legal_name": "LIGA NOTA SAC"})
    mp.on("POST", "/api/v1/ruta-falsa", (200, {"aceptada_por_sunat": True, "enlace_del_pdf": "https://nf.test/f.pdf"}))
    pay_org(api, mp, owner, org, 6601)
    pay = api.get("/payments", params={"q": "Liga Nota"})[0]
    assert pay["invoice"]["doc_type"] == "factura" and pay["credit_note"] is None

    # Nubefact falla con la nota: el reembolso queda hecho y la nota con error y número reservado.
    mp.on("POST", "/v1/payments/6601/refunds", (201, {"id": 1}))
    mp.on("POST", "/api/v1/ruta-falsa", (400, {"errors": "Servicio no disponible"}))
    out = api.post(f"/payments/{pay['id']}/refund", {"reason": "Cobro por error"})
    assert out["status"] == "refunded"
    nc = out["credit_note"]
    assert nc["doc_type"] == "nota_credito" and nc["status"] == "error" and nc["serie"] == "FFF1" and nc["numero"] == 1
    sent = [c for c in mp.calls if c["path"] == "/api/v1/ruta-falsa"][-1]["body"]
    assert sent["tipo_de_comprobante"] == 3 and sent["tipo_de_nota_de_credito"] == 1
    assert sent["documento_que_se_modifica_tipo"] == 1
    assert sent["documento_que_se_modifica_serie"] == "FFF1" and sent["documento_que_se_modifica_numero"] == 1
    assert sent["total"] == 690.0 and sent["cliente_numero_de_documento"] == "20999999991"

    # Reintento del Admin: consulta primero (no existe) y reenvía con el MISMO número.
    answers = iter([(200, {"errors": "No existe"}), (200, {"aceptada_por_sunat": True, "enlace_del_pdf": "nc.pdf"})])
    mp.on("POST", "/api/v1/ruta-falsa", lambda body: next(answers))
    out = api.post(f"/payments/{pay['id']}/invoice")
    assert out["credit_note"]["status"] == "accepted" and out["credit_note"]["numero"] == 1
    calls = [c["body"] for c in mp.calls if c["path"] == "/api/v1/ruta-falsa"][-2:]
    assert calls[0]["operacion"] == "consultar_comprobante" and calls[0]["tipo_de_comprobante"] == 3
    assert calls[1]["numero"] == 1
    db = db_session()
    assert db.query(Invoice).count() == 2
    # Otro reintento no emite nada nuevo.
    api.post(f"/payments/{pay['id']}/invoice")
    assert db_session().query(Invoice).count() == 2

    # Un pago sin comprobante emitido se reembolsa sin nota de crédito.
    org2, owner2, _ = org_with_owner(api, "Liga Sin Nota", "duena_sinnota")
    mp.on("POST", "/api/v1/ruta-falsa", (400, {"errors": "caído"}))
    pay_org(api, mp, owner2, org2, 6602)
    p2 = api.get("/payments", params={"q": "Liga Sin Nota"})[0]
    assert p2["invoice"]["status"] == "error"
    mp.on("POST", "/v1/payments/6602/refunds", (201, {"id": 2}))
    assert api.post(f"/payments/{p2['id']}/refund", {"reason": "Prueba"})["credit_note"] is None
