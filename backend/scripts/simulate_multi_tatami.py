"""Simulación de un torneo con varios tatamis operados a la vez (MVP-3).

Ensayo del criterio de salida «torneo real multi-tatami»: contra un servidor
en marcha, crea un torneo de prueba con N tatamis, un operador de mesa por
tatami (rol limitado a su tatami) y los hace operar todos sus combates EN
PARALELO, como tablets reales: puntos, pausas, reenvíos del mismo evento
(red inestable) y cierre con el ganador que sugiere el marcador.

Al final verifica que no hubo errores del servidor, que cada categoría quedó
finalizada con podio y que el marcador de cada combate coincide con sus
eventos.

    python scripts/simulate_multi_tatami.py --url http://localhost:8000 \\
        --user admin --password ... --tatamis 4 --per-category 8
"""

from __future__ import annotations

import argparse
import random
import statistics
import sys
import threading
import time
import uuid
from datetime import UTC, datetime, timedelta

import httpx

KUMITE = {
    "modality": "kumite",
    "sex": "M",
    "age_min": 10,
    "age_max": 17,
    "duration_seconds": 90,
}


class Client:
    def __init__(self, base: str, token: str | None = None):
        self.c = httpx.Client(base_url=f"{base}/api/v1", timeout=30)
        if token:
            self.c.headers["Authorization"] = f"Bearer {token}"
        self.latencies: list[float] = []
        self.errors: list[str] = []

    def call(self, method: str, path: str, expect: tuple[int, ...] = (200, 201), **kw):
        t0 = time.perf_counter()
        r = self.c.request(method, path, **kw)
        self.latencies.append(time.perf_counter() - t0)
        if r.status_code not in expect:
            self.errors.append(f"{method} {path} -> {r.status_code}: {r.text[:200]}")
        return r


def login(base: str, user: str, password: str) -> str:
    r = httpx.post(f"{base}/api/v1/auth/login", json={"username": user, "password": password}, timeout=30)
    r.raise_for_status()
    return r.json()["access_token"]


def setup(admin: Client, tatamis: int, per_category: int, cats_per_tatami: int) -> tuple[dict, list[dict]]:
    stamp = datetime.now().strftime("%H%M%S")
    t = admin.call(
        "POST",
        "/tournaments",
        json={
            "name": f"Simulación multi-tatami {stamp}",
            "start_date": "2026-10-17",
            "is_test": True,
            "tatami_count": tatamis,
        },
    ).json()
    t = admin.call(
        "PATCH", f"/tournaments/{t['id']}/status", json={"status": "registration_open", "version": t["version"]}
    ).json()
    dojos = [admin.call("POST", "/dojos", json={"name": f"Dojo Sim {stamp}-{i}"}).json() for i in range(6)]
    n = 0
    for ti, tat in enumerate(t["tatamis"]):
        for ci in range(cats_per_tatami):
            code = f"SIM-{ti}-{ci}"
            c = admin.call(
                "POST", f"/tournaments/{t['id']}/categories", json={**KUMITE, "code": code, "name": f"Kumite {code}"}
            ).json()
            c = admin.call(
                "PATCH", f"/categories/{c['id']}", json={"tatami_id": tat["id"], "version": c["version"]}
            ).json()
            for k in range(per_category):
                n += 1
                body = {
                    "first_names": f"Sim{n}",
                    "last_names": f"Competidor {stamp}",
                    "sex": "M",
                    "birth_date": (datetime(2012, 1, 1) + timedelta(days=11 * n)).date().isoformat(),
                    "dojo_id": dojos[k % len(dojos)]["id"],
                    "grade": "6 kyu",
                }
                r = admin.call("POST", "/persons", json=body, expect=(201, 409))
                if r.status_code == 409:
                    r = admin.call("POST", "/persons", json={**body, "override": {"reason": "simulación"}})
                p = r.json()
                reg = {"person_id": p["id"], "category_id": c["id"], "override": {"reason": "simulación"}}
                admin.call("POST", f"/tournaments/{t['id']}/registrations", json=reg, expect=(201,))
            admin.call("POST", f"/categories/{c['id']}/bracket", json={"seed": ti * 100 + ci})
    ops = []
    for tat in t["tatamis"]:
        uname = f"sim{stamp}t{tat['number']}"
        p = admin.call("POST", "/persons", json={"first_names": "Mesa", "last_names": uname, "sex": "F"}).json()
        admin.call("POST", "/users", json={"username": uname, "password": "simulacion-123", "person_id": p["id"]})
        admin.call(
            "POST",
            f"/persons/{p['id']}/roles",
            json={"role": "table_operator", "scope_type": "tatami", "scope_id": tat["id"]},
        )
        ops.append({"tatami": tat, "username": uname})
    return t, ops


def operate_tatami(base: str, op: dict, rng: random.Random, results: dict) -> None:
    """Una tablet: toma el siguiente combate de la cola de su tatami hasta vaciarla."""
    token = login(base, op["username"], "simulacion-123")
    cli = Client(base, token)
    device = f"sim-{op['tatami']['number']}-{uuid.uuid4().hex[:6]}"
    clock = datetime(2026, 10, 17, 10, tzinfo=UTC) + timedelta(hours=op["tatami"]["number"])
    done = 0

    def ev(mid: int, type_: str, **kw):
        nonlocal clock
        clock += timedelta(seconds=rng.randint(3, 20))
        body = {"id": str(uuid.uuid4()), "type": type_, "at": clock.isoformat(), **kw}
        cli.call("POST", f"/matches/{mid}/events", json=body)
        if rng.random() < 0.08:  # red inestable: la tablet reenvía el mismo evento
            cli.call("POST", f"/matches/{mid}/events", json=body)

    while True:
        q = cli.call("GET", f"/tatamis/{op['tatami']['id']}/queue").json()
        pending = [it for it in q["queue"] if it["match"]["status"] in ("ready", "in_progress")]
        if not pending:
            break
        m = pending[0]["match"]
        cli.call("POST", f"/matches/{m['id']}/presence", json={"device_id": device})
        ev(m["id"], "start")
        for _ in range(rng.randint(1, 6)):
            ev(m["id"], "point", color=rng.choice(["aka", "ao"]), value=rng.choice([1, 1, 2, 3]))
            ev(m["id"], "resume")
        sb = cli.call("GET", f"/matches/{m['id']}").json()
        sug = sb["suggestion_at_time_end"]
        winner = sug.get("winner")
        method = sug.get("method") or "points"
        if winner is None:  # empate: decisión de jueces
            winner, method = rng.choice(["aka", "ao"]), "hantei"
        clock += timedelta(seconds=5)
        body = {"id": str(uuid.uuid4()), "at": clock.isoformat(), "winner": winner, "method": method, "time_over": True}
        cli.call("POST", f"/matches/{m['id']}/finish", json=body)
        cli.call("DELETE", f"/matches/{m['id']}/presence?device_id={device}", expect=(204,))
        done += 1
    results[op["tatami"]["number"]] = {"matches": done, "latencies": cli.latencies, "errors": cli.errors}


def verify(admin: Client, t: dict) -> list[str]:
    problems = []
    for c in admin.call("GET", f"/tournaments/{t['id']}/categories").json():
        if c["status"] != "finished":
            problems.append(f"Categoría {c['name']} quedó en estado {c['status']}")
            continue
        b = admin.call("GET", f"/categories/{c['id']}/bracket").json()
        if not b["podium"]["places"]:
            problems.append(f"Categoría {c['name']} sin podio")
        for m in b["matches"]:
            if m["status"] != "finished" or m["method"] == "bye":
                continue
            sb = admin.call("GET", f"/matches/{m['id']}").json()
            if (m["aka_score"], m["ao_score"]) != (sb["score"]["aka"], sb["score"]["ao"]):
                problems.append(f"{c['name']} {m['code']}: marcador guardado distinto de sus eventos")
    return problems


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default="http://localhost:8000")
    ap.add_argument("--user", default="admin")
    ap.add_argument("--password", required=True)
    ap.add_argument("--tatamis", type=int, default=4)
    ap.add_argument("--categories", type=int, default=2, help="categorías por tatami")
    ap.add_argument("--per-category", type=int, default=8)
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()

    admin = Client(a.url, login(a.url, a.user, a.password))
    print(f"Preparando {a.tatamis} tatamis × {a.categories} categorías × {a.per_category} competidores…")
    t, ops = setup(admin, a.tatamis, a.per_category, a.categories)
    if admin.errors:
        print("Errores al preparar:", *admin.errors[:10], sep="\n  ")
        return 1
    results: dict = {}
    threads = [
        threading.Thread(target=operate_tatami, args=(a.url, op, random.Random(a.seed + i), results))
        for i, op in enumerate(ops)
    ]
    t0 = time.perf_counter()
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    elapsed = time.perf_counter() - t0
    lat = [x for r in results.values() for x in r["latencies"]]
    errors = [e for r in results.values() for e in r["errors"]]
    problems = verify(admin, t)
    total = sum(r["matches"] for r in results.values())
    print(f"Torneo #{t['id']}: {total} combates en {len(ops)} tatamis a la vez, {elapsed:.1f} s")
    if lat:
        p95 = statistics.quantiles(lat, n=20)[-1]
        print(f"Peticiones: {len(lat)} · mediana {statistics.median(lat) * 1000:.0f} ms · p95 {p95 * 1000:.0f} ms")
    for e in errors[:10]:
        print("  error:", e)
    for p in problems[:10]:
        print("  problema:", p)
    ok = not errors and not problems and total > 0
    print("RESULTADO:", "OK" if ok else f"{len(errors)} errores, {len(problems)} problemas")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
