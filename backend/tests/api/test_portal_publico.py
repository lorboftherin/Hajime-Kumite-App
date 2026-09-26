"""Portal público: dirección fija, directorio, «¿cuándo pelea?», llave pública,
horarios estimados, pantalla grande y actualización en vivo por SSE."""

import json
import threading
import time
from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from app.db import base
from app.services import public, schedule
from tests.api.test_mock_tournament import KUMITE, register, setup_tournament
from tests.api.test_public_consultas import contar
from tests.api.test_stats import play


def enable(api, tid, **kw):
    r = api.c.put(f"/api/v1/tournaments/{tid}/public", json={"enabled": True, **kw})
    assert r.status_code == 200, r.text
    return r.json()


def cuatro(api, name="Copa Lima Kids", **kw):
    """Torneo con una categoría de 4 en el tatami 1 y su llave."""
    t = setup_tournament(api, is_test=False, name=name, **kw)
    c = api.post(f"/tournaments/{t['id']}/categories", KUMITE, expect=201)
    tat = t["tatamis"][0]["id"]
    api.patch(f"/categories/{c['id']}", {"tatami_id": tat, "version": c["version"]})
    d = [api.dojo("Kaze"), api.dojo("Mizu")]
    nombres = [("Diego Alonso", "Ramos Quispe"), ("Mateo", "Huamán Torres"), ("Luis", "Pérez"), ("Iker", "Soto")]
    for i, (first, last) in enumerate(nombres):
        p = api.person(first, last, d[i % 2]["id"], birth=f"2013-0{i + 1}-11")
        register(api, t["id"], p["id"], c["id"], weight_class="-45")
    b = api.post(f"/categories/{c['id']}/bracket", {"seed": 1})
    return t, c, tat, b


def anon(api):
    return TestClient(api.c.app)


# ---------------------------------------------------------------------------
# Dirección fija y directorio
# ---------------------------------------------------------------------------


def test_slug_fijo_editable_y_el_token_sigue_funcionando(client):
    api = client
    t, *_ = cuatro(api)
    out = enable(api, t["id"])
    assert out["public_slug"] == "copa-lima-kids-2026"
    token, slug = out["public_token"], out["public_slug"]
    a = anon(api)
    por_slug = a.get(f"/api/v1/public/t/{slug}").json()
    assert por_slug == a.get(f"/api/v1/public/{token}").json() | {"server_time": por_slug["server_time"]}
    assert por_slug["tournament"]["slug"] == slug

    # Otro torneo con el mismo nombre recibe otra dirección; editar a una ocupada o inválida: 409.
    t2 = setup_tournament(api, is_test=False, name="Copa Lima Kids")
    assert enable(api, t2["id"])["public_slug"] == "copa-lima-kids-2026-2"
    r = api.c.put(f"/api/v1/tournaments/{t2['id']}/public", json={"enabled": True, "slug": slug})
    assert r.status_code == 409 and r.json()["error"]["code"] == "SLUG_TAKEN"
    r = api.c.put(f"/api/v1/tournaments/{t2['id']}/public", json={"enabled": True, "slug": "Copa Ñandú!"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "INVALID_SLUG"

    # El organizador la cambia; la vieja deja de responder.
    assert enable(api, t["id"], slug="copa-lima")["public_slug"] == "copa-lima"
    assert a.get(f"/api/v1/public/t/{slug}").status_code == 404
    assert a.get("/api/v1/public/t/copa-lima").status_code == 200
    # Desactivar corta la dirección fija pero la conserva para volver a activar.
    api.c.put(f"/api/v1/tournaments/{t['id']}/public", json={"enabled": False})
    assert a.get("/api/v1/public/t/copa-lima").status_code == 404
    assert enable(api, t["id"])["public_slug"] == "copa-lima"
    assert a.get("/api/v1/public/t/copa-lima/people").status_code == 200
    assert public.slugify("Torneo Nacional 2026 – Cusco", 2026) == "torneo-nacional-2026-cusco"


def test_directorio_solo_publicos_y_no_de_prueba(client):
    api = client
    lima = setup_tournament(api, is_test=False, name="Open Lima", city="Lima", start_date="2026-10-17")
    cusco = setup_tournament(api, is_test=False, name="Copa Inti", city="Cusco", start_date="2026-09-20")
    prueba = setup_tournament(api, is_test=True, name="Ensayo", city="Lima", start_date="2026-10-17")
    privado = setup_tournament(api, is_test=False, name="Interno", city="Lima", start_date="2026-10-17")
    for t in (lima, cusco, prueba):
        enable(api, t["id"])
    assert privado  # sin público: no aparece
    db = next(base.get_session())
    try:
        d = public.directory(db, today=datetime(2026, 10, 1).date())["tournaments"]
        assert [x["name"] for x in d["upcoming"]] == ["Open Lima"]
        assert [x["name"] for x in d["recent"]] == ["Copa Inti"] and d["live"] == []
        assert d["upcoming"][0]["slug"] == "open-lima-2026"
        solo_cusco = public.directory(db, "cusco", today=datetime(2026, 10, 1).date())["tournaments"]
        assert [x["name"] for x in solo_cusco["recent"]] == ["Copa Inti"] and not solo_cusco["upcoming"]
    finally:
        db.close()
    r = anon(api).get("/api/v1/public/torneos?q=lima")
    nombres = [x["name"] for grupo in r.json()["tournaments"].values() for x in grupo]
    assert r.status_code == 200 and nombres == ["Open Lima"]
    assert "public_token" not in r.text


# ---------------------------------------------------------------------------
# «¿Cuándo pelea?»
# ---------------------------------------------------------------------------


def test_cuando_pelea_sin_datos_sensibles(client):
    api = client
    t, c, tat, b = cuatro(api)
    token = enable(api, t["id"])["public_token"]
    m1 = b["matches"][0]
    api.event(m1["id"], "start")
    r = anon(api).get(f"/api/v1/public/{token}/people")
    assert r.status_code == 200
    data = r.json()
    text = r.text
    for prohibido in ("Ramos Quispe", "2013-0", "birth", "person_id", "registration_id", "document", "DNI"):
        assert prohibido not in text, prohibido
    comp = {x["name"]: x for x in data["competitors"]}
    assert set(comp) == {"Diego R.", "Mateo H.", "Luis P.", "Iker S."}
    assert all(len(x["key"]) == 12 and x["dojo"].startswith("Dojo ") for x in comp.values())
    estados = sorted(e["state"] for x in comp.values() for e in x["entries"])
    assert estados == ["fighting", "fighting", "scheduled", "scheduled"]
    esperando = next(x for x in comp.values() if x["entries"][0]["state"] == "scheduled")
    nxt = esperando["entries"][0]["next"]
    assert nxt["tatami"] == 1 and nxt["number"] == "T1-002" and nxt["ahead"] == 1
    assert nxt["eta"] is not None  # torneo sin iniciar pero con un combate empezado
    # La clave es estable (favoritos) y no cambia con los puntos.
    api.event(m1["id"], "point", "aka", 1)
    again = {x["name"]: x["key"] for x in anon(api).get(f"/api/v1/public/{token}/people").json()["competitors"]}
    assert again == {n: x["key"] for n, x in comp.items()}

    # Al terminar la categoría: puesto de cada uno.
    for m in api.get(f"/categories/{c['id']}/bracket")["matches"]:
        if m["status"] == "ready":
            play(api, m["id"], [("aka", 1)], "aka")
    q = api.get(f"/tatamis/{tat}/queue")["queue"]
    while q:
        play(api, q[0]["match"]["id"], [("aka", 1)], "aka")
        q = api.get(f"/tatamis/{tat}/queue")["queue"]
    fin = anon(api).get(f"/api/v1/public/{token}/people").json()["competitors"]
    assert sorted(e["place"] for x in fin for e in x["entries"]) == [1, 2, 3, 3]
    assert {e["state"] for x in fin for e in x["entries"]} == {"placed"}


def test_llave_publica_de_una_categoria(client):
    api = client
    t, c, tat, b = cuatro(api)
    out = enable(api, t["id"])
    m1 = b["matches"][0]
    play(api, m1["id"], [("aka", 3), ("ao", 1)], "aka")
    a = anon(api)
    r = a.get(f"/api/v1/public/t/{out['public_slug']}/categories/{c['id']}")
    assert r.status_code == 200
    d = r.json()
    assert d["category"]["name"] == KUMITE["name"] and d["format"] == "single_elimination"
    cerrado = next(m for m in d["matches"] if m["code"] == m1["code"])
    assert cerrado["status"] == "finished" and cerrado["score"] == [3, 1] and cerrado["winner"] == "aka"
    assert cerrado["aka"]["name"].endswith(".") and "Ramos Quispe" not in r.text and "registration" not in r.text
    assert a.get(f"/api/v1/public/{out['public_token']}/categories/999999").status_code == 404
    otro = setup_tournament(api, is_test=False, name="Otro")
    c2 = api.post(f"/tournaments/{otro['id']}/categories", KUMITE, expect=201)
    assert a.get(f"/api/v1/public/{out['public_token']}/categories/{c2['id']}").status_code == 404
    # El vivo enlaza cada categoría por su id.
    live = a.get(f"/api/v1/public/{out['public_token']}").json()
    assert live["categories"][0]["id"] == c["id"]


def test_pantalla_grande_muestra_el_siguiente(client):
    api = client
    t, c, tat, b = cuatro(api)
    token = enable(api, t["id"])["public_token"]
    api.event(b["matches"][0]["id"], "start")
    ov = anon(api).get(f"/api/v1/public/{token}/tatamis/{tat}").json()
    assert ov["match"]["number"] == "T1-001" and ov["match"]["running"] is True
    assert ov["next"]["number"] == "T1-002" and ov["next"]["aka"]["name"].endswith(".")


# ---------------------------------------------------------------------------
# Horarios estimados (reloj fijo)
# ---------------------------------------------------------------------------


def test_horarios_estimados_con_reloj_fijo(client):
    api = client
    t, c, tat, b = cuatro(api)
    r = api.c.patch(f"/api/v1/tournaments/{t['id']}/schedule", json={"match_overhead_seconds": 30})
    assert r.status_code == 200 and r.json()["match_overhead_seconds"] == 30 and r.json()["timezone"] == "America/Lima"
    bad = api.c.patch(f"/api/v1/tournaments/{t['id']}/schedule", json={"timezone": "Marte/Olympus"})
    assert bad.status_code == 409
    tt = api.c.patch(f"/api/v1/tatamis/{tat}", json={"planned_start": "2026-10-17T09:00"}).json()
    assert tt["planned_start"] == "2026-10-17T09:00:00"
    antes = datetime(2026, 10, 17, 13, 0)  # 8:00 en Lima: antes de la hora planificada
    db = next(base.get_session())
    try:
        etas = schedule.estimate(db, t["id"], now=antes)
        codes = {m["id"]: m["code"] for m in b["matches"]}
        horas = sorted((v, codes[k]) for k, v in etas.items())
        # 90 s de combate + 30 s de margen: cada 2 minutos desde las 9:00 (14:00 UTC).
        assert [h for h, _ in horas] == [datetime(2026, 10, 17, 14, m) for m in (0, 2, 4)]
        assert horas[-1][1] == "R2-1"
        # Sin hora planificada, sin actividad y sin iniciar: no se inventa una hora.
        api.c.patch(f"/api/v1/tatamis/{tat}", json={"planned_start": None})
        db.expire_all()
        assert schedule.estimate(db, t["id"], now=antes) == {}
        api.c.patch(f"/api/v1/tatamis/{tat}", json={"planned_start": "2026-10-17T09:00:00-05:00"})
        db.expire_all()
        # Un combate cerrado muy rápido: el ritmo baja (acotado y mezclado con 1 por tener pocos).
        play(api, b["matches"][0]["id"], [("aka", 1)], "aka")
        db.expire_all()
        etas = schedule.estimate(db, t["id"], now=antes)
        horas = sorted(etas.values())
        assert horas[0] == datetime(2026, 10, 17, 14, 0)
        assert horas[1] == datetime(2026, 10, 17, 14, 2)  # 75 s + 30 s = 1:45 → 9:02 redondeado
        # Ya pasada la hora: parte de ahora.
        tarde = datetime(2026, 10, 17, 15, 30, 10)
        assert min(schedule.estimate(db, t["id"], now=tarde).values()) == datetime(2026, 10, 17, 15, 30)
    finally:
        db.close()
    # En la cola del organizador (y «Mi tatami») y en el vivo público, con la zona del torneo.
    q = api.get(f"/tatamis/{tat}/queue")
    assert q["tatami"]["planned_start"] == "2026-10-17T09:00:00"
    assert all(it["eta"] and it["eta"].endswith("-05:00") for it in q["queue"])
    token = enable(api, t["id"])["public_token"]
    live = anon(api).get(f"/api/v1/public/{token}").json()
    assert live["tatamis"][0]["upcoming"][0]["eta"].endswith("-05:00")
    assert live["tournament"]["timezone"] == "America/Lima"


def test_ritmo_del_tatami():
    assert schedule._factor([]) == 1.0
    assert schedule._factor([(180, 90)]) == pytest.approx((2 + 2) / 3)
    assert schedule._factor([(900, 90)] * 5) == 3.0  # acotado
    assert schedule._factor([(45, 90)] * 5) == 0.5


def test_people_y_categoria_con_pocas_consultas(client):
    api = client
    t, c, tat, b = cuatro(api)
    token = enable(api, t["id"])["public_token"]
    db = next(base.get_session())
    try:
        with contar() as sqls:
            public.people(db, token)
        assert len(sqls) <= 8, "\n".join(sqls)
        with contar() as sqls:
            public.category(db, token, c["id"])
        assert len(sqls) <= 12, "\n".join(sqls)
    finally:
        db.close()


# ---------------------------------------------------------------------------
# SSE
# ---------------------------------------------------------------------------


@pytest.fixture()
def sse_client(tmp_path, monkeypatch):
    """Base en archivo (el hilo del sondeo usa su propia conexión) y conexiones cortas."""
    from app.api.routers import public as public_router
    from app.config import get_settings
    from app.db.base import Base
    from app.db.models import User
    from app.main import create_app
    from app.security import hash_password
    from app.services import public_stream
    from tests.api.conftest import Api

    s = get_settings()
    for k, v in {
        "public_cache_seconds": 3.0,
        "public_sse_poll_seconds": 0.1,
        "public_sse_heartbeat_seconds": 0.4,
        "public_sse_max_seconds": 3.0,
    }.items():
        monkeypatch.setattr(s, k, v)
    public_router.clear_cache()
    public_stream.reset()
    engine = base.init_engine(f"sqlite:///{tmp_path / 'sse.db'}")
    Base.metadata.create_all(engine)
    db = next(base.get_session())
    db.add(User(username="admin", password_hash=hash_password("secret123"), is_admin=True, display_name="Admin"))
    db.commit()
    db.close()
    with TestClient(create_app()) as c:
        tok = c.post("/api/v1/auth/login", json={"username": "admin", "password": "secret123"}).json()["access_token"]
        c.headers["Authorization"] = f"Bearer {tok}"
        yield Api(c)
    public_stream.reset()
    engine.dispose()


def eventos(body: str) -> list[tuple[str, dict]]:
    out = []
    for block in body.split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines() if ": " in line and not line.startswith(":"))
        if "event" in lines:
            out.append((lines["event"], json.loads(lines["data"])))
    return out


def test_sse_envia_la_instantanea_y_cada_cambio(sse_client):
    api = sse_client
    t, c, tat, b = cuatro(api)
    out = enable(api, t["id"])
    m = b["matches"][0]
    api.event(m["id"], "start")
    res = {}

    def escuchar():
        with api.c.stream("GET", f"/api/v1/public/t/{out['public_slug']}/stream?people=true&tatami={tat}") as r:
            res["status"], res["headers"], res["body"] = r.status_code, r.headers, r.read().decode()

    th = threading.Thread(target=escuchar)
    th.start()
    time.sleep(1.0)
    api.event(m["id"], "point", "aka", 2)
    th.join(15)
    assert not th.is_alive()
    assert res["status"] == 200, res
    h = res["headers"]
    assert h["content-type"].startswith("text/event-stream")
    assert h["cache-control"].startswith("no-cache") and h["x-accel-buffering"] == "no"
    evs = eventos(res["body"])
    live = [d for e, d in evs if e == "live"]
    assert len(live) >= 2, res["body"][:500]
    assert sorted(live[0]["tatamis"][0]["current"]["score"]) == [0, 0]
    assert sorted(live[-1]["tatamis"][0]["current"]["score"]) == [0, 2]
    assert any(e == "people" for e, _ in evs)
    ov = [d for e, d in evs if e == "overlay"]
    assert ov and sorted(ov[-1]["match"]["score"]) == [0, 2]
    assert ": latido" in res["body"] and res["body"].startswith("retry: ")
    # La reconexión con Last-Event-ID no reenvía lo que el navegador ya tiene.
    last_id = [line for line in res["body"].splitlines() if line.startswith("id: ")][-1][4:]
    with api.c.stream("GET", f"/api/v1/public/{out['public_token']}/stream", headers={"Last-Event-ID": last_id}) as r:
        again = r.read().decode()
    assert [e for e, _ in eventos(again)] == []


def test_sse_limite_de_conexiones_y_enlace_inexistente(sse_client, monkeypatch):
    from app.config import get_settings

    api = sse_client
    t, *_ = cuatro(api)
    token = enable(api, t["id"])["public_token"]
    assert api.c.get("/api/v1/public/inventado/stream").status_code == 404
    monkeypatch.setattr(get_settings(), "public_sse_max_connections", 0)
    r = api.c.get(f"/api/v1/public/{token}/stream")
    assert r.status_code == 503 and r.json()["code"] == "TOO_MANY_STREAMS" and r.headers["retry-after"]
