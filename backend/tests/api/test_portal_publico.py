"""Portal público: dirección fija, directorio, «¿cuándo pelea?», llave pública,
horarios estimados, pantalla grande y actualización en vivo por SSE."""

import json
import threading
import time
from datetime import datetime, timedelta

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


# ---------------------------------------------------------------------------
# Formatos nuevos: grupos + eliminación, kata por rondas y ausentes
# ---------------------------------------------------------------------------


def _cargar(db, tid):
    from sqlalchemy import select

    from app.db.models import Category, Match
    from app.services.brackets import SCHEDULED

    cats = list(db.scalars(select(Category).where(Category.tournament_id == tid, Category.status.in_(SCHEDULED))))
    matches = list(
        db.scalars(
            select(Match).where(
                Match.category_id.in_([c.id for c in cats]), Match.is_current, Match.parent_match_id.is_(None)
            )
        )
    )
    return cats, matches


def test_horarios_con_grupos_kata_por_rondas_y_ausentes(client):
    """Grupos + eliminación y kata por rondas en tatamis distintos; los
    ausentes no aparecen en «¿cuándo pelea?» y su turno no ocupa tiempo."""
    from tests.api.test_reglas import fill, kata_cat, kata_people, kumite_cat

    api = client
    dojos = [api.dojo(n) for n in ("Uno", "Dos", "Tres")]
    t = setup_tournament(
        api,
        is_test=False,
        tatami_count=2,
        competition_rules={"groups": 2, "group_qualifiers": 2},
        kata_defaults={"method": "scores", "structure": "rounds", "judges": 3},
    )
    t1, t2 = (x["id"] for x in t["tatamis"])
    g = kumite_cat(api, t["id"], format="groups_knockout")
    greg = fill(api, t["id"], g["id"], dojos, 6)
    k = kata_cat(api, t["id"], kata_rules={"rounds": [3], "performance_seconds": 150})
    kreg = kata_people(api, t["id"], k["id"], 5, dojos)
    for cat, tat in ((g, t1), (k, t2)):
        cur = api.get(f"/categories/{cat['id']}")
        api.patch(f"/categories/{cat['id']}", {"tatami_id": tat, "version": cur["version"]})
        api.post(f"/categories/{cat['id']}/bracket", {"seed": 3})
        api.c.patch(f"/api/v1/tatamis/{tat}", json={"planned_start": "2026-10-17T09:00"})
    api.c.patch(f"/api/v1/tournaments/{t['id']}/schedule", json={"match_overhead_seconds": 30})
    ausentes = {kreg[4]["id"], greg[5]["id"]}
    out = api.c.post(
        f"/api/v1/tournaments/{t['id']}/checkin", json={"registration_ids": sorted(ausentes), "status": "absent"}
    )
    assert out.status_code == 200, out.text

    db = next(base.get_session())
    try:
        # Con el reloj fijo antes de la hora planificada (9:00 en Lima = 14:00 UTC).
        antes = datetime(2026, 10, 17, 13, 0)
        etas = schedule.estimate(db, t["id"], now=antes)
        from app.db.models import Tournament

        tour = db.get(Tournament, t["id"])
        cats, matches = _cargar(db, t["id"])
        kata_rows = schedule.load_kata(db, cats)
        lines = schedule.timeline(tour, tour.tatamis, cats, matches, now=antes, absent=ausentes, kata=kata_rows)
    finally:
        db.close()
    grupos = lines[t1]
    # 6 combates de grupos y 3 de la llave (semifinales y final), los grupos primero.
    assert len(grupos) == 9 and all(s.match.kind == "group" for s in grupos[:6])
    assert grupos[0].eta == datetime(2026, 10, 17, 14, 0)
    # 90 s + 30 s por combate; los del ausente son walkover y no ocupan tiempo.
    ocupan = [s for s in grupos if not (ausentes & set(s.registrations))]
    assert grupos[-1].eta == datetime(2026, 10, 17, 14, 0) + (len(ocupan) - 1) * timedelta(minutes=2)
    kata = lines[t2]
    # El ausente no sale: 4 turnos de 150 s + 30 s de margen (3 minutos entre turnos).
    assert all(s.number.startswith("T2 · ronda 1, turno ") for s in kata)
    assert len(kata) == 4 and ausentes.isdisjoint(s.registrations[0] for s in kata)
    assert [s.eta.minute for s in kata] == [0, 3, 6, 9]
    assert {f"k{s.performance.id}" for s in kata} <= set(etas)

    token = enable(api, t["id"])["public_token"]
    people = anon(api).get(f"/api/v1/public/{token}/people").json()["competitors"]
    assert len(people) == 9  # 11 inscritos menos 2 ausentes
    kata_entry = next(e for c in people for e in c["entries"] if e["category_id"] == k["id"])
    assert kata_entry["next"]["kata_round"] == 1 and kata_entry["next"]["eta"].endswith("-05:00")
    assert all(c["public_id"] for c in people)
    grupo = next(e for c in people for e in c["entries"] if e["category_id"] == g["id"])
    assert grupo["next"]["number"].startswith("T1-")
    # La llave pública funciona con los dos formatos y enlaza a los perfiles.
    for cat in (g, k):
        r = anon(api).get(f"/api/v1/public/{token}/categories/{cat['id']}")
        assert r.status_code == 200, r.text
    llave = anon(api).get(f"/api/v1/public/{token}/categories/{g['id']}").json()
    assert all(m["aka"]["public_id"] for m in llave["matches"] if m["aka"])


# ---------------------------------------------------------------------------
# Vista previa al compartir (index.html con las etiquetas del torneo)
# ---------------------------------------------------------------------------


def test_vista_previa_al_compartir(client, tmp_path, monkeypatch):
    """Los robots de WhatsApp o Facebook no ejecutan JavaScript: el backend
    sirve el index.html con el título, la descripción, la URL y la imagen de
    lo que se comparte, escapados; el resto de rutas sigue igual (modo SPA)."""
    from pathlib import Path

    from app.config import get_settings
    from app.main import create_app
    from app.services import share_preview

    api = client
    t, c, tat, b = cuatro(api, name='Copa "Lima" <Kids>', venue="Coliseo Dibós", city="Lima")
    out = enable(api, t["id"])
    person = api.get(f"/tournaments/{t['id']}/registrations")[0]["person_id"]
    public_id = next(
        x["public_id"] for x in anon(api).get(f"/api/v1/public/{out['public_token']}/people").json()["competitors"]
    )
    assert person and public_id

    front = Path(__file__).resolve().parents[3] / "frontend" / "src" / "index.html"
    (tmp_path / "index.html").write_text(front.read_text(encoding="utf-8"), encoding="utf-8")
    (tmp_path / "ngsw.json").write_text("{}", encoding="utf-8")
    monkeypatch.setattr(get_settings(), "static_dir", str(tmp_path))
    share_preview.clear()
    with TestClient(create_app()) as web:
        r = web.get(f"/t/{out['public_slug']}")
        assert r.status_code == 200 and r.headers["cache-control"] == "public, max-age=60"
        doc = r.text
        assert "<title>Copa &quot;Lima&quot; &lt;Kids&gt; · Hajime</title>" in doc
        assert '<meta property="og:title" content="Copa &quot;Lima&quot; &lt;Kids&gt;" />' in doc
        assert "17 de octubre de 2026 · Coliseo Dibós, Lima" in doc
        assert f'<meta property="og:url" content="http://testserver/t/{out["public_slug"]}" />' in doc
        assert '<meta property="og:image" content="http://testserver/icons/icon-512x512.png" />' in doc
        assert doc.count('property="og:title"') == 1 and doc.count('name="description"') == 1
        assert "<app-root></app-root>" in doc  # la aplicación sigue arrancando igual

        cat = web.get(f"/t/{out['public_slug']}/categoria/{c['id']}").text
        assert f"<title>{KUMITE['name']} · Copa" in cat
        perfil = web.get(f"/competidor/{public_id}").text
        assert '<meta property="og:title" content="' in perfil and "Dojo " in perfil
        assert "Ramos Quispe" not in perfil  # menores: nombre abreviado, como el perfil público

        # Rutas que no son públicas o que no existen: el index.html de siempre.
        plain = (tmp_path / "index.html").read_text(encoding="utf-8")
        assert web.get("/t/no-existe").text == plain
        assert web.get("/torneos/1").text == plain
        assert web.get("/competidor/inventado").text == plain
        # El index que usa el service worker no cambia.
        assert web.get("/index.html").text == plain
        # Desactivar el público corta también la vista previa.
        api.c.put(f"/api/v1/tournaments/{t['id']}/public", json={"enabled": False})
        assert web.get(f"/t/{out['public_slug']}").text == plain


def test_vista_previa_del_ranking_solo_si_es_publico(client):
    from app.services import share_preview
    from tests.api.test_ranking import season

    s = season(client, name="Liga <Lima>")
    db = next(base.get_session())
    try:
        assert share_preview.meta_for(db, f"ranking/{s['slug']}") is None
        client.patch(f"/ranking/seasons/{s['id']}", {"version": s["version"], "is_public": True})
        db.expire_all()
        assert share_preview.meta_for(db, f"ranking/{s['slug']}")["title"] == "Ranking Liga <Lima>"
        assert share_preview.meta_for(db, "torneos/1") is None
    finally:
        db.close()
    doc = share_preview.inject(
        '<html><head><title>x</title>\n<meta name="description" content="y" />\n</head></html>',
        {"title": "A <b>", "description": 'd "e"'},
        "https://h/ranking/x",
        "https://h/i.png",
    )
    assert "<title>A &lt;b&gt; · Hajime</title>" in doc and 'content="d &quot;e&quot;"' in doc


def test_duracion_de_kata_configurable_por_categoria():
    from types import SimpleNamespace

    c = SimpleNamespace(modality="kata", kata_rules=None, kata_method=None, kata_structure=None, kata_judges=None)
    t = SimpleNamespace(kata_defaults={})
    assert schedule.kata_seconds(c, t) == 180
    c.kata_rules = {"performance_seconds": 90}
    assert schedule.kata_seconds(c, t) == 90
    assert schedule.nominal_seconds(c, t) == 180  # banderas: dos ejecuciones por combate
