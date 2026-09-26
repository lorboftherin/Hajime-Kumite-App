"""Avisos Web Push: suscripción con y sin cuenta, «te toca pronto», resultados,
medallas, avisos de cuenta y envío cifrado con VAPID a un servidor push falso."""

import base64
import itertools
import json
import os
import time
from datetime import datetime, timedelta

import http_ece
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient

from app.config import get_settings
from app.db import base
from app.db.models import NotificationOutbox, PushFollow, PushSubscription
from app.services import push, push_eval, webpush
from tests.api.test_autoinscripcion import open_tournament
from tests.api.test_cuentas_integracion import dojo_admin
from tests.api.test_mock_tournament import KUMITE, register, setup_tournament
from tests.api.test_portal_publico import enable
from tests.api.test_stats import play

_n = itertools.count()
# Las pruebas fechan los eventos de la mesa el 17/10/2026 desde las 10:00 UTC (conftest.now_iso).
AHORA = datetime(2026, 10, 17, 10, 0)


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


class Navegador:
    """Un navegador suscrito: su clave P-256, su secreto y su endpoint de FCM (ficticio)."""

    def __init__(self, host="fcm.googleapis.com"):
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.auth = os.urandom(16)
        self.endpoint = f"https://{host}/fcm/send/prueba-{next(_n)}"

    @property
    def keys(self):
        pub = self.key.public_key().public_bytes(
            serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
        )
        return {"p256dh": _b64(pub), "auth": _b64(self.auth)}

    def ref(self, **kw):
        return {"endpoint": self.endpoint, "auth": self.keys["auth"], **kw}

    def descifrar(self, body: bytes) -> dict:
        return json.loads(http_ece.decrypt(body, private_key=self.key, auth_secret=self.auth, version="aes128gcm"))


class ServidorPush:
    """Reemplaza el POST al servicio de push: guarda lo recibido y responde el estado configurado."""

    def __init__(self):
        self.recibidos: list[tuple[str, dict, bytes]] = []
        self.estado: dict[str, int] = {}
        self.caidos: set[str] = set()

    def __call__(self, url, body, headers, timeout):
        if url in self.caidos:
            raise webpush.PushNetworkError("sin red")
        self.recibidos.append((url, headers, body))
        return self.estado.get(url, 201), ""

    def de(self, nav):
        return [(h, nav.descifrar(b)) for u, h, b in self.recibidos if u == nav.endpoint]


@pytest.fixture()
def vapid(monkeypatch):
    public_key, private_key = webpush.generate_vapid_keys()
    s = get_settings()
    monkeypatch.setattr(s, "vapid_public_key", public_key)
    monkeypatch.setattr(s, "vapid_private_key", private_key)
    monkeypatch.setattr(s, "vapid_subject", "mailto:pruebas@example.com")
    servidor = ServidorPush()
    monkeypatch.setattr(webpush, "_post", servidor)
    push_eval.take_pending()
    yield servidor
    push_eval.take_pending()


def anon(api):
    return TestClient(api.c.app)


class Sesion:
    """Cliente con la sesión de otra cuenta (``as_user``) y rutas completas como ``TestClient``."""

    def __init__(self, u):
        self.u = u

    def post(self, url, json=None):
        return self.u.raw("POST", url.removeprefix("/api/v1"), json=json)

    def put(self, url, json=None):
        return self.u.raw("PUT", url.removeprefix("/api/v1"), json=json)


def suscribir(cliente, nav, expect=200, **kw):
    r = cliente.post("/api/v1/push/subscriptions", json={"endpoint": nav.endpoint, "keys": nav.keys, **kw})
    assert r.status_code == expect, r.text
    return r.json()


def recorrer(now=AHORA):
    return push_eval.evaluate_pending(base.session_factory(), now)


def enviar():
    return push.drain(base.session_factory())


def ocho(api, name="Copa Avisos"):
    """Torneo con una categoría de 8 (4 cuartos de final en el tatami 1) y público activo."""
    t = setup_tournament(api, is_test=False, name=name)
    c = api.post(f"/tournaments/{t['id']}/categories", KUMITE, expect=201)
    tat = t["tatamis"][0]["id"]
    api.patch(f"/categories/{c['id']}", {"tatami_id": tat, "version": c["version"]})
    d = [api.dojo("Kaze"), api.dojo("Mizu")]
    for i in range(8):
        p = api.person(f"Nombre{i}", f"Apellido{i} Segundo", d[i % 2]["id"], birth=f"2013-0{i + 1}-11")
        register(api, t["id"], p["id"], c["id"], weight_class="-45")
    api.post(f"/categories/{c['id']}/bracket", {"seed": 1})
    pub = enable(api, t["id"])
    return t, c, tat, pub


def cola(api, tat):
    return [q["match"] for q in api.get(f"/tatamis/{tat}/queue")["queue"]]


def claves(api, token, reg_id):
    """Clave pública (``key``) del competidor de esa inscripción en «¿cuándo pelea?»."""
    from app.db.models import Registration
    from app.services.public import public_key

    db = next(base.get_session())
    try:
        r = db.get(Registration, reg_id)
        return public_key(r.tournament_id, "p", r.person_id), f"{r.person.first_names} {r.person.last_names[0]}."
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Configuración y suscripción
# ---------------------------------------------------------------------------


def test_config_sin_claves_y_con_claves(client, monkeypatch):
    a = anon(client)
    s = get_settings()
    monkeypatch.setattr(s, "vapid_public_key", None)
    monkeypatch.setattr(s, "vapid_private_key", None)
    assert a.get("/api/v1/push/config").json() == {"enabled": False, "public_key": None, "soon_ahead": 3}
    r = suscribir(a, Navegador(), expect=409)
    assert r["error"]["code"] == "PUSH_DISABLED"
    public_key, private_key = webpush.generate_vapid_keys()
    monkeypatch.setattr(s, "vapid_public_key", public_key)
    monkeypatch.setattr(s, "vapid_private_key", private_key)
    cfg = a.get("/api/v1/push/config").json()
    assert cfg["enabled"] is True and cfg["public_key"] == public_key
    assert len(webpush.b64u_decode(public_key)) == 65 and len(webpush.b64u_decode(private_key)) == 32


def test_suscripcion_anonima_validaciones_preferencias_y_baja(client, vapid):
    a = anon(client)
    nav = Navegador()
    # Solo servicios de push conocidos por https: el servidor no hace POST a cualquier URL.
    for endpoint in ("http://fcm.googleapis.com/x", "https://169.254.169.254/latest", "https://evil.com/fcm"):
        r = a.post("/api/v1/push/subscriptions", json={"endpoint": endpoint, "keys": nav.keys})
        assert r.status_code == 409 and r.json()["error"]["code"] == "PUSH_ENDPOINT", endpoint
    malas = {"p256dh": nav.keys["p256dh"][:-4], "auth": nav.keys["auth"]}
    r = a.post("/api/v1/push/subscriptions", json={"endpoint": nav.endpoint, "keys": malas})
    assert r.json()["error"]["code"] == "PUSH_KEYS"
    for host in ("updates.push.services.mozilla.com", "web.push.apple.com", "wns2-par02p.notify.windows.com"):
        assert suscribir(a, Navegador(host))["subscribed"] is True

    out = suscribir(a, nav)
    assert out == {
        "subscribed": True,
        "account": False,
        "preferences": {"turn": True, "results": True, "medals": True, "account": True},
        "keys": [],
        "person_ids": [],
        "dojo_ids": [],
    }
    # Sin el secreto auth nadie más la cambia ni la ve.
    otro = {"endpoint": nav.endpoint, "auth": _b64(os.urandom(16))}
    assert a.post("/api/v1/push/subscriptions/state", json=otro).json()["subscribed"] is False
    assert a.post("/api/v1/push/subscriptions/unsubscribe", json=otro).status_code == 404
    prefs = {"turn": True, "results": False, "medals": True, "account": False}
    r = a.put("/api/v1/push/subscriptions/preferences", json=nav.ref(preferences=prefs))
    assert r.status_code == 200 and r.json()["preferences"] == prefs
    assert suscribir(a, nav)["preferences"] == prefs  # volver a suscribirse no las pierde
    assert a.post("/api/v1/push/subscriptions/unsubscribe", json=nav.ref()).status_code == 204
    assert a.post("/api/v1/push/subscriptions/state", json=nav.ref()).json()["subscribed"] is False


# ---------------------------------------------------------------------------
# «Te toca pronto», resultados y medallas
# ---------------------------------------------------------------------------


def test_te_toca_a_tatami_y_resultado_cifrados_con_vapid(client, vapid):
    api = client
    t, c, tat, pub = ocho(api)
    q = cola(api, tat)
    assert len(q) == 4  # cuartos de final
    a = anon(api)
    nav = Navegador()
    suscribir(a, nav)
    key4, nombre4 = claves(api, pub["public_token"], q[3]["aka_registration_id"])
    key1, nombre1 = claves(api, pub["public_token"], q[0]["aka_registration_id"])
    r = a.put("/api/v1/push/follows", json=nav.ref(tournament=pub["public_slug"], keys=[key4, key1, "ffffffffffff"]))
    assert r.status_code == 200 and sorted(r.json()["keys"]) == sorted([key4, key1])  # la clave inventada no queda
    assert a.post("/api/v1/push/subscriptions/state", json=nav.ref(tournament=pub["public_token"])).json()["keys"]

    # Torneo sin empezar y sin hora planificada: no hay hora estimada, no se avisa.
    recorrer()
    assert enviar() == 0

    # Empieza el primer combate: al del cuarto combate le faltan 3 → «te toca en ~3 combates».
    api.event(q[0]["id"], "start")
    recorrer()
    assert enviar() == 1
    ((h, msg),) = vapid.de(nav)
    n = msg["notification"]
    assert n["title"] == f"{nombre4}: te toca en ~3 combates"
    assert n["body"].startswith("Tatami 1 · T1-004 · Kumite 12-13 Masculino -45 · hacia las ")
    url = f"/t/{pub['public_slug']}?seguir={key4}"
    assert n["data"]["url"] == url
    assert n["data"]["onActionClick"]["default"] == {"operation": "navigateLastFocusedOrOpen", "url": url}
    assert "Segundo" not in json.dumps(msg) and "Apellido" not in n["title"]  # menor: nombre abreviado
    # Cabeceras: cifrado aes128gcm, TTL corto y VAPID válido para el origen del servicio de push.
    assert h["Content-Encoding"] == "aes128gcm" and h["Urgency"] == "high"
    assert 0 < int(h["TTL"]) <= 600 and h["Topic"].startswith("t")
    token, k = h["Authorization"].removeprefix("vapid t=").split(", k=")
    assert k == get_settings().vapid_public_key
    clave = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), webpush.b64u_decode(k))
    claims = jwt.decode(token, clave, algorithms=["ES256"], audience="https://fcm.googleapis.com")
    assert claims["sub"] == "mailto:pruebas@example.com" and claims["exp"] > time.time() + 3600

    # Recorrer otra vez (u otro proceso) no repite el aviso.
    push_eval._on_change({t["id"]})
    recorrer()
    assert enviar() == 0

    # Termina el primero: resultado para quien sigue al de aka (ganó).
    api.event(q[0]["id"], "point", "aka", 2)
    api.event(q[0]["id"], "resume")
    api.finish(q[0]["id"], "aka")
    recorrer()
    # Y como ganó, su semifinal ya está a 3 combates: «te toca» para esa semifinal.
    assert enviar() == 2
    avisos = {n["notification"]["title"]: n["notification"] for _, n in vapid.de(nav)[-2:]}
    res = next(n for title, n in avisos.items() if " ganó contra " in title)
    assert res["title"].startswith(f"{nombre1} ganó contra ") and res["title"].endswith("(2–0)")
    assert res["body"] == f"Kumite 12-13 Masculino -45 · {t['name']}"
    assert f"{nombre1}: te toca en ~3 combates" in avisos

    # Segundo en curso: el cuarto aún no es el siguiente (falta el tercero).
    api.event(q[1]["id"], "start")
    recorrer()
    assert enviar() == 0
    play(api, q[1]["id"], [("ao", 1)], "ao")
    api.event(q[2]["id"], "start")
    recorrer()
    assert enviar() == 1
    n = vapid.de(nav)[-1][1]["notification"]
    assert n["title"] == f"¡A tatami! {nombre4}" and n["requireInteraction"] is True
    assert n["tag"] == f"hajime-{q[3]['id']}"
    # Una sola vez por combate y tipo.
    db = next(base.get_session())
    try:
        kinds = sorted(r.kind for r in db.query(NotificationOutbox).all())
    finally:
        db.close()
    assert kinds == ["next", "result", "soon", "soon"]


def test_medallas_al_cerrar_la_categoria_y_preferencias(client, vapid):
    api = client
    t, c, tat, pub = ocho(api, name="Copa Medallas")
    q = cola(api, tat)
    a = anon(api)
    con_todo, sin_resultados = Navegador(), Navegador()
    suscribir(a, con_todo)
    suscribir(a, sin_resultados, preferences={"turn": False, "results": False, "medals": True, "account": True})
    keys = [
        claves(api, pub["public_token"], m[side])[0]
        for m in q
        for side in ("aka_registration_id", "ao_registration_id")
    ]
    for nav in (con_todo, sin_resultados):
        a.put("/api/v1/push/follows", json=nav.ref(tournament=pub["public_slug"], keys=keys))
    while q := cola(api, tat):
        play(api, q[0]["id"], [("aka", 1)], "aka")
    recorrer(now=None)  # las medallas se fechan con la hora real
    enviar()
    titulos = [n["notification"]["title"] for _, n in vapid.de(sin_resultados)]
    assert sorted(x.split(": medalla de ")[1] for x in titulos) == ["bronce", "bronce", "oro", "plata"]
    todos = [n["notification"]["title"] for _, n in vapid.de(con_todo)]
    assert sum("medalla" in x for x in todos) == 4 and sum(" contra " in x for x in todos) >= 7


def test_favoritos_vencen_y_sin_publico_no_avisa(client, vapid):
    api = client
    t, c, tat, pub = ocho(api, name="Copa Vence")
    q = cola(api, tat)
    a = anon(api)
    nav = Navegador()
    suscribir(a, nav)
    key4, _ = claves(api, pub["public_token"], q[3]["aka_registration_id"])
    a.put("/api/v1/push/follows", json=nav.ref(tournament=pub["public_slug"], keys=[key4]))
    db = next(base.get_session())
    try:
        f = db.query(PushFollow).one()
        assert f.expires_at.date() > f.created_at.date()  # vence al día siguiente del torneo
        f.expires_at = f.created_at - timedelta(minutes=1)
        db.commit()
    finally:
        db.close()
    api.event(q[0]["id"], "start")
    recorrer()
    assert enviar() == 0
    db = next(base.get_session())
    try:
        push.cleanup(db)
        assert db.query(PushFollow).count() == 0
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Envío: 404/410, reintentos y vencimiento
# ---------------------------------------------------------------------------


def _encolar(nav_sub_id, kind="result", ttl=3600, ref=None):
    db = next(base.get_session())
    try:
        row = NotificationOutbox(
            **push.outbox_row(nav_sub_id, kind, ref or f"x{next(_n)}", "Título", "Cuerpo", "/", ttl=ttl)
        )
        db.add(row)
        db.commit()
        return row.id
    finally:
        db.close()


def _sub_id(nav):
    db = next(base.get_session())
    try:
        return db.query(PushSubscription).filter_by(endpoint=nav.endpoint).one().id
    finally:
        db.close()


def test_410_borra_la_suscripcion_y_5xx_se_reintenta(client, vapid):
    a = anon(client)
    ida, vuelta, caido = Navegador(), Navegador(), Navegador()
    for nav in (ida, vuelta, caido):
        suscribir(a, nav)
    vapid.estado[ida.endpoint] = 410
    vapid.estado[vuelta.endpoint] = 503
    vapid.caidos.add(caido.endpoint)
    ids = [_encolar(_sub_id(nav)) for nav in (ida, vuelta, caido)]
    assert enviar() == 0
    db = next(base.get_session())
    try:
        assert db.query(PushSubscription).filter_by(endpoint=ida.endpoint).count() == 0
        assert db.get(NotificationOutbox, ids[0]) is None
        for i in ids[1:]:
            row = db.get(NotificationOutbox, i)
            assert row.status == "pending" and row.attempts == 1 and row.last_error
            assert row.next_attempt_at > row.created_at
        # Pasado el tiempo de espera se reintenta; el 503 se recupera.
        for i in ids[1:]:
            db.get(NotificationOutbox, i).next_attempt_at = row.created_at
        db.commit()
    finally:
        db.close()
    vapid.estado[vuelta.endpoint] = 201
    assert enviar() == 1
    db = next(base.get_session())
    try:
        assert db.get(NotificationOutbox, ids[1]).status == "sent"
        assert db.query(PushSubscription).filter_by(endpoint=vuelta.endpoint).one().last_success_at is not None
    finally:
        db.close()


def test_aviso_de_turno_vencido_no_se_envia(client, vapid):
    a = anon(client)
    nav = Navegador()
    suscribir(a, nav)
    rid = _encolar(_sub_id(nav), kind="soon", ttl=600)
    db = next(base.get_session())
    try:
        row = db.get(NotificationOutbox, rid)
        row.expires_at = row.created_at - timedelta(seconds=1)
        db.commit()
    finally:
        db.close()
    assert enviar() == 0 and not vapid.recibidos
    db = next(base.get_session())
    try:
        assert db.get(NotificationOutbox, rid).status == "expired"
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Cuentas: seguir perfiles y dojos, inscripciones y reclamos
# ---------------------------------------------------------------------------


def test_cuenta_sensei_sigue_a_su_dojo_y_recibe_la_decision(client, vapid):
    api = client
    kaze, mizu = api.dojo("Kaze"), api.dojo("Mizu")
    t, c = open_tournament(api)
    s1 = dojo_admin(api, "senseipush", kaze["id"])
    alumno = api.person("Mateo", "Huaman", kaze["id"])
    ajeno = api.person("Luis", "Ajeno", mizu["id"])
    nav = Navegador()
    out = suscribir(Sesion(s1), nav)
    assert out["account"] is True
    r = Sesion(s1).put("/api/v1/me/push/follows", json=nav.ref(person_id=ajeno["id"]))
    assert r.status_code == 403
    r = Sesion(s1).put("/api/v1/me/push/follows", json=nav.ref(dojo_id=mizu["id"]))
    assert r.status_code == 403
    assert Sesion(s1).put("/api/v1/me/push/follows", json=nav.ref(person_id=alumno["id"])).json()["person_ids"] == [
        alumno["id"]
    ]
    assert Sesion(s1).put("/api/v1/me/push/follows", json=nav.ref(dojo_id=kaze["id"])).json()["dojo_ids"] == [
        kaze["id"]
    ]
    # Sin sesión no se sigue un perfil.
    assert anon(api).put("/api/v1/me/push/follows", json=nav.ref(person_id=alumno["id"])).status_code == 401

    base_url = f"/dojo-portal/dojos/{kaze['id']}/tournaments/{t['id']}/registrations"
    created = s1.post(
        base_url, {"items": [{"person_id": alumno["id"], "category_id": c["id"], "weight_class": "-45"}]}, expect=201
    )
    api.post(f"/tournaments/{t['id']}/registration-requests/decide", {"ids": [created[0]["id"]], "action": "approve"})
    enviar()
    ((_, msg),) = vapid.de(nav)
    assert msg["notification"]["title"] == f"Inscripciones revisadas · {t['name']}"
    assert msg["notification"]["body"] == "1 aprobada, 0 no aprobadas"
    assert msg["notification"]["data"]["url"] == "/mis-competidores"

    # Dejar de seguir.
    r = Sesion(s1).put("/api/v1/me/push/follows", json=nav.ref(person_id=alumno["id"], follow=False))
    assert r.json()["person_ids"] == []


def test_reclamo_aprobado_avisa_a_la_cuenta(client, vapid):
    from tests.api.test_reclamos_perfil import cuenta, public_id

    api = client
    get_settings().open_signup = True
    try:
        kaze = api.dojo("Kaze")
        adulto = api.person("Rosa", "Quispe", kaze["id"], sex="F", birth="1990-05-05")
        headers = cuenta(api, "rosa@example.com")
        a = TestClient(api.c.app, headers=headers)
        nav = Navegador()
        assert suscribir(a, nav)["account"] is True
        # Antes de aprobar no puede seguir ese perfil.
        assert a.put("/api/v1/me/push/follows", json=nav.ref(person_id=adulto["id"])).status_code == 403
        cl = a.post("/api/v1/profile-claims", json={"public_id": public_id(adulto["id"]), "relationship": "self"})
        assert cl.status_code == 201, cl.text
        api.post(f"/profile-claims/{cl.json()['id']}/review", {"approve": True})
        enviar()
        ((_, msg),) = vapid.de(nav)
        assert msg["notification"]["title"] == "Perfil aprobado"
        assert msg["notification"]["data"]["url"] == "/mis-perfiles"
        assert a.put("/api/v1/me/push/follows", json=nav.ref(person_id=adulto["id"])).status_code == 200
    finally:
        get_settings().open_signup = False


def test_cuenta_sigue_su_perfil_y_recibe_el_turno(client, vapid):
    api = client
    t, c, tat, pub = ocho(api, name="Copa Cuenta")
    q = cola(api, tat)
    db = next(base.get_session())
    try:
        from app.db.models import Registration

        pid = db.get(Registration, q[3]["ao_registration_id"]).person_id
    finally:
        db.close()
    api.post("/users", {"username": "competidor", "password": "secret123", "person_id": pid}, expect=201)
    tok = api.raw("POST", "/auth/login", json={"username": "competidor", "password": "secret123"}).json()
    u = TestClient(api.c.app, headers={"Authorization": f"Bearer {tok['access_token']}"})
    nav = Navegador()
    suscribir(u, nav)
    assert u.put("/api/v1/me/push/follows", json=nav.ref(person_id=pid)).status_code == 200
    api.event(q[0]["id"], "start")
    recorrer()
    assert enviar() == 1
    n = vapid.de(nav)[0][1]["notification"]
    assert "te toca en ~3 combates" in n["title"] and n["data"]["url"].startswith(f"/t/{pub['public_slug']}?seguir=")


# ---------------------------------------------------------------------------
# Carga: 500 suscripciones siguiendo un torneo
# ---------------------------------------------------------------------------


def test_carga_500_suscripciones_un_recorrido(client, vapid):
    api = client
    t, c, tat, pub = ocho(api, name="Copa Carga")
    q = cola(api, tat)
    key4, _ = claves(api, pub["public_token"], q[3]["aka_registration_id"])
    key3, _ = claves(api, pub["public_token"], q[2]["ao_registration_id"])
    db = next(base.get_session())
    try:
        nav = Navegador()
        for i in range(500):
            sub = PushSubscription(endpoint=f"{nav.endpoint}-{i}", p256dh=nav.keys["p256dh"], auth=nav.keys["auth"])
            db.add(sub)
            db.flush()
            db.add(PushFollow(subscription_id=sub.id, tournament_id=t["id"], person_key=key4))
            db.add(PushFollow(subscription_id=sub.id, tournament_id=t["id"], person_key=key3))
        db.commit()
    finally:
        db.close()
    api.event(q[0]["id"], "start")
    push_eval.take_pending()
    db = next(base.get_session())
    try:
        inicio = time.perf_counter()
        n = push_eval.evaluate(db, t["id"], AHORA)
        ms = (time.perf_counter() - inicio) * 1000
        # Un segundo recorrido (sin nada nuevo) solo deduplica.
        inicio = time.perf_counter()
        assert push_eval.evaluate(db, t["id"], AHORA) == 0
        ms2 = (time.perf_counter() - inicio) * 1000
    finally:
        db.close()
    assert n == 1000  # «~2» del tercero y «~3» del cuarto, para cada una de las 500
    print(f"\n500 suscripciones: encolar {n} avisos {ms:.0f} ms; recorrido sin cambios {ms2:.0f} ms")
    assert ms < 2000 and ms2 < 1000


def test_hilo_de_avisos_y_trabajador(client, vapid, monkeypatch):
    """El hilo de cada proceso (``PushService.tick``) recorre lo anotado por el commit y envía;
    ``python -m app.push_worker`` envía lo pendiente de otra forma (una pasada)."""
    from app import push_worker

    api = client
    t, c, tat, pub = ocho(api, name="Copa Hilo")
    q = cola(api, tat)
    a = anon(api)
    nav = Navegador()
    suscribir(a, nav)
    key4, _ = claves(api, pub["public_token"], q[3]["aka_registration_id"])
    a.put("/api/v1/push/follows", json=nav.ref(tournament=pub["public_slug"], keys=[key4]))
    real = push_eval.evaluate
    monkeypatch.setattr(push_eval, "evaluate", lambda db, tid, now=None: real(db, tid, now or AHORA))
    api.event(q[0]["id"], "start")
    assert push_eval.has_pending()
    servicio = push.PushService(base.session_factory(), get_settings())
    servicio.tick()
    assert not push_eval.has_pending() and len(vapid.de(nav)) == 1
    _encolar(_sub_id(nav))
    assert push_worker.run_once(base.session_factory(), get_settings()) == 1
    assert len(vapid.de(nav)) == 2
