"""Seguimiento en vivo público y overlay: opcional, sin sesión y con datos mínimos."""

from datetime import timedelta

from tests.api.test_mock_tournament import KUMITE, register, setup_tournament
from tests.api.test_stats import play
from tests.api.test_teams import first_team_match, lineup
from tests.api.test_teams import setup as team_setup


def enable(api, tid, **kw):
    return api.c.put(f"/api/v1/tournaments/{tid}/public", json={"enabled": True, **kw}).json()


def test_public_live_is_opt_in_minimal_and_revocable(client):
    api = client
    t = setup_tournament(api, is_test=False)
    c = api.post(f"/tournaments/{t['id']}/categories", KUMITE, expect=201)
    api.patch(f"/categories/{c['id']}", {"tatami_id": t["tatamis"][0]["id"], "version": c["version"]})
    d = api.dojo("Kaze")
    ps = [api.person("Diego Alonso", "Ramos Quispe", d["id"]), api.person("Mateo", "Huamán Torres", d["id"])]
    for p in ps:
        register(api, t["id"], p["id"], c["id"], weight_class="-45")
    m = api.post(f"/categories/{c['id']}/bracket", {"seed": 1})["matches"][0]
    assert api.get(f"/tournaments/{t['id']}")["public_token"] is None

    out = enable(api, t["id"])
    token = out["public_token"]
    assert token and out["public_names"] == "short"
    anon = api.c.__class__(api.c.app)  # cliente sin encabezado de sesión
    api.event(m["id"], "start")
    api.event(m["id"], "point", "aka", 2)

    live = anon.get(f"/api/v1/public/{token}").json()
    assert live["tournament"]["name"] == t["name"]
    cur = live["tatamis"][0]["current"]
    assert {cur["aka"]["name"], cur["ao"]["name"]} == {"Diego R.", "Mateo H."} and sorted(cur["score"]) == [0, 2]
    text = str(live)
    assert "Ramos Quispe" not in text and "birth" not in text and "person_id" not in text

    tid = t["tatamis"][0]["id"]
    ov = anon.get(f"/api/v1/public/{token}/tatamis/{tid}").json()["match"]
    assert sorted(ov["score"]) == [0, 2] and ov["running"] is False and ov["duration"] == 90

    # Nombres completos si el organizador lo decide; revocar corta el enlace.
    enable(api, t["id"], names="full")
    assert "Diego Alonso Ramos Quispe" in str(anon.get(f"/api/v1/public/{token}").json())
    api.c.put(f"/api/v1/tournaments/{t['id']}/public", json={"enabled": False})
    assert anon.get(f"/api/v1/public/{token}").status_code == 404
    assert anon.get("/api/v1/public/inventado").status_code == 404


def test_overlay_follows_the_live_bout_of_a_team_match(client):
    api = client
    t, c, dojos, members, sub, regs = team_setup(api)
    tat = api.get(f"/tournaments/{t['id']}")["tatamis"][0]["id"]
    cat = api.get(f"/categories/{c['id']}")
    api.patch(f"/categories/{c['id']}", {"tatami_id": tat, "version": cat["version"]})
    _, m = first_team_match(api, c)
    tm = api.get(f"/matches/{m['id']}/team")
    aka = [x["person_id"] for x in tm["aka"]["members"] if x["role"] == "starter"]
    ao = [x["person_id"] for x in tm["ao"]["members"] if x["role"] == "starter"]
    bouts = [x["match"] for x in lineup(api, m["id"], list(zip(aka, ao, strict=True)))["bouts"]]
    play(api, bouts[0]["id"], [("aka", 3)], "aka")
    api.event(bouts[1]["id"], "start")
    api.event(bouts[1]["id"], "point", "ao", 1)
    token = enable(api, t["id"])["public_token"]
    ov = api.c.get(f"/api/v1/public/{token}/tatamis/{tat}").json()["match"]
    assert ov["team"] == {"aka": tm["aka"]["name"], "ao": tm["ao"]["name"], "wins": [1, 0], "bout": 2, "extra": False}
    assert ov["score"] == [0, 1] and ov["aka"]["dojo"] == tm["aka"]["name"] and ov["running"] is False


def small_live(api):
    t = setup_tournament(api, is_test=False)
    c = api.post(f"/tournaments/{t['id']}/categories", KUMITE, expect=201)
    tat = t["tatamis"][0]["id"]
    api.patch(f"/categories/{c['id']}", {"tatami_id": tat, "version": c["version"]})
    d = api.dojo("Kaze")
    for first in ("Diego", "Mateo"):
        register(api, t["id"], api.person(first, "Ramos", d["id"])["id"], c["id"], weight_class="-45")
    m = api.post(f"/categories/{c['id']}/bracket", {"seed": 1})["matches"][0]
    return t, m, tat, enable(api, t["id"])["public_token"]


def counting(monkeypatch, name):
    from app.services import public as public_svc

    calls = []
    original = getattr(public_svc, name)
    monkeypatch.setattr(public_svc, name, lambda *a: calls.append(a[1:]) or original(*a))
    return calls


def test_public_live_is_shared_between_spectators(client, monkeypatch):
    """Cientos de espectadores no deben costar cientos de cálculos: una
    instantánea compartida por todos los procesos, que solo se recalcula
    cuando una escritura la invalida; el navegador la revalida con ETag (304)."""
    from app.api.routers import public as public_router
    from app.config import get_settings
    from app.db import base
    from app.db.models import PublicSnapshot

    api = client
    t, m, _, token = small_live(api)
    monkeypatch.setattr(get_settings(), "public_cache_seconds", 60)
    calls = counting(monkeypatch, "live")
    anon = api.c.__class__(api.c.app)
    url = f"/api/v1/public/{token}"

    first = anon.get(url)
    assert first.status_code == 200 and first.headers["cache-control"] == "public, max-age=60"
    etag = first.headers["etag"]
    for _ in range(30):
        assert anon.get(url).json() == first.json()
    assert len(calls) == 1
    # Otro proceso (sin caché en memoria) usa la instantánea guardada, sin recalcular.
    public_router.clear_cache()
    assert anon.get(url).headers["etag"] == etag and len(calls) == 1
    # El navegador pregunta si cambió: 304 sin cuerpo.
    r = anon.get(url, headers={"If-None-Match": etag})
    assert r.status_code == 304 and not r.content

    # Un punto en la mesa invalida la instantánea en su misma transacción.
    api.event(m["id"], "start")
    api.event(m["id"], "point", "aka", 2)
    r = anon.get(url, headers={"If-None-Match": etag})
    assert r.status_code == 200 and r.headers["etag"] != etag and len(calls) == 2
    assert sorted(r.json()["tatamis"][0]["current"]["score"]) == [0, 2]

    # Mientras otro proceso la recalcula (turno tomado), se sirve la anterior sin esperar.
    db = next(base.get_session())
    row = db.get(PublicSnapshot, (t["id"], "live"))
    row.dirty, row.lease_until = True, base.utcnow() + timedelta(seconds=5)
    db.commit()
    public_router.clear_cache()
    assert anon.get(url).headers["etag"] == r.headers["etag"] and len(calls) == 2
    # Turno vencido (el otro proceso se cayó): este lo toma y recalcula.
    row.lease_until = base.utcnow() - timedelta(seconds=1)
    db.commit()
    db.close()
    public_router.clear_cache()
    anon.get(url)
    assert len(calls) == 3

    # Revocar el enlace corta el acceso aunque haya instantánea.
    api.c.put(f"/api/v1/tournaments/{t['id']}/public", json={"enabled": False})
    public_router.clear_cache()
    assert anon.get(url).status_code == 404
    assert anon.get("/api/v1/public/inventado").status_code == 404

    # Sin caché (public_cache_seconds = 0) se calcula en cada petición.
    token = enable(api, t["id"])["public_token"]
    monkeypatch.setattr(get_settings(), "public_cache_seconds", 0)
    anon.get(f"/api/v1/public/{token}")
    anon.get(f"/api/v1/public/{token}")
    assert len(calls) == 5


def test_overlay_snapshot_keeps_the_clock_running(client, monkeypatch):
    """El overlay se comparte igual, pero su reloj no se congela: se adelanta
    el tiempo transcurrido desde el cálculo y el navegador no lo guarda."""
    from app.config import get_settings
    from app.services import public_snapshots

    api = client
    _, m, tat, token = small_live(api)
    monkeypatch.setattr(get_settings(), "public_cache_seconds", 60)
    calls = counting(monkeypatch, "overlay")
    url = f"/api/v1/public/{token}/tatamis/{tat}"
    api.event(m["id"], "start")
    r = api.c.get(url)
    assert r.headers["cache-control"] == "no-store" and r.json()["match"]["running"] is True
    for _ in range(10):
        api.c.get(url)
    assert len(calls) == 1
    assert api.c.get(f"/api/v1/public/{token}/tatamis/999999").status_code == 404

    data = {"match": {"running": True, "elapsed": 10.0}, "server_time": ""}
    aged = public_snapshots.age_overlay(data, public_snapshots.utcnow() - timedelta(seconds=4))
    assert 13.9 <= aged["match"]["elapsed"] <= 15
    still = public_snapshots.age_overlay({"match": {"running": False, "elapsed": 10.0}}, public_snapshots.utcnow())
    assert still["match"]["elapsed"] == 10.0


def test_overlay_gives_sanction_ladder_and_kata_flags(client):
    """La pantalla grande dibuja las faltas como casilleros (escalera completa y
    nivel alcanzado) y, en kata por banderas, el voto de cada juez."""
    import uuid
    from datetime import UTC, datetime

    api = client
    t, m, tat, token = small_live(api)
    api.event(m["id"], "start")
    api.event(m["id"], "sanction", "aka", 2)
    ov = api.c.get(f"/api/v1/public/{token}/tatamis/{tat}").json()["match"]
    assert ov["modality"] == "kumite" and ov["flags"] is None
    assert ov["sanction_levels"][:2] == ["Chui 1", "Chui 2"] and ov["sanction_index"] == [2, 0]
    assert ov["sanction"] == ["Chui 2", None]

    # Kata por banderas en el mismo tatami, después del kumite.
    k = api.post(
        f"/tournaments/{t['id']}/categories",
        {
            "code": "KF",
            "name": "Kata banderas",
            "modality": "kata",
            "sex": "X",
            "kata_method": "flags",
            "kata_judges": 3,
        },
        expect=201,
    )
    api.patch(f"/categories/{k['id']}", {"tatami_id": tat, "version": k["version"]})
    d = api.dojo("Sora")
    for first in ("Ana", "Lía"):
        register(api, t["id"], api.person(first, "Vega", d["id"])["id"], k["id"])
    km = api.post(f"/categories/{k['id']}/bracket", {"seed": 1})["matches"][0]
    play(api, m["id"], [("aka", 3)], "aka")
    ov = api.c.get(f"/api/v1/public/{token}/tatamis/{tat}").json()["match"]
    assert ov["modality"] == "kata" and ov["flags"] == {"judges": 3, "votes": []}
    api.post(
        f"/matches/{km['id']}/flags",
        {"votes": ["ao", "ao", "aka"], "at": datetime.now(UTC).isoformat(), "event_id": str(uuid.uuid4())},
    )
    ov = api.c.get(f"/api/v1/public/{token}/tatamis/{tat}").json()["match"]
    assert ov["flags"]["votes"] == ["ao", "ao", "aka"] and ov["winner"] == "ao"
