"""Prueba de carga contra un servidor real (p. ej. el ambiente de pruebas en Azure).

Responde «¿cuántos usuarios aguanta a la vez?» con números: crea un torneo de
prueba con N tatamis, un operador de mesa por tatami, y los hace operar todos
sus combates EN PARALELO (puntos, pausas, cierres, reenvíos por red inestable)
mientras M espectadores refrescan el seguimiento en vivo público cada 5 s,
como hace la página «en vivo».

Al final muestra peticiones por segundo, latencias (mediana y p95) por tipo de
uso y errores. Solo usa la biblioteca estándar de Python: corre desde Azure
Cloud Shell sin instalar nada.

    python3 scripts/prueba_carga.py --url https://hajime.lorboftherin.com \\
        --tatamis 8 --espectadores 200

Pide la contraseña del admin (no se muestra). El torneo queda marcado como de
prueba, con nombre «[CARGA] …», y no afecta historiales.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import random
import statistics
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone

UTC = timezone.utc  # noqa: UP017 - sin datetime.UTC: corre también en Python < 3.11
REFRESCO_VIVO = 5.0  # segundos entre refrescos de la página «en vivo»
KUMITE = {"modality": "kumite", "sex": "M", "age_min": 10, "age_max": 17, "duration_seconds": 90}


class Client:
    def __init__(self, base: str, token: str | None = None, label: str = ""):
        self.base = base.rstrip("/") + "/api/v1"
        self.token = token
        self.label = label
        self.lat: list[float] = []
        self.errors: list[str] = []

    def call(self, method: str, path: str, body=None, expect=(200, 201, 204)):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        if self.token:
            req.add_header("Authorization", f"Bearer {self.token}")
        t0 = time.perf_counter()
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                status, raw = r.status, r.read()
        except urllib.error.HTTPError as e:
            status, raw = e.code, e.read()
        except Exception as e:  # noqa: BLE001 - se cuenta como error de red
            self.lat.append(time.perf_counter() - t0)
            self.errors.append(f"{method} {path} -> {type(e).__name__}: {e}")
            return None
        self.lat.append(time.perf_counter() - t0)
        try:
            out = json.loads(raw) if raw else None
        except ValueError:  # página de error del gateway (HTML), no JSON
            self.errors.append(f"{method} {path} -> {status}: {raw[:200].decode(errors='replace')!r}")
            return None
        if status not in expect:
            self.errors.append(f"{method} {path} -> {status}: {json.dumps(out, ensure_ascii=False)[:200]}")
            return None
        return out

    def get(self, path):
        return self.call("GET", path)

    def post(self, path, body=None, expect=(200, 201, 204)):
        return self.call("POST", path, body if body is not None else {}, expect)


def login(base: str, user: str, password: str) -> str:
    c = Client(base)
    r = c.post("/auth/login", {"username": user, "password": password})
    if not r or "access_token" not in r:
        raise SystemExit("No se pudo entrar: " + "; ".join(c.errors[-1:]))
    return r["access_token"]


def setup(admin: Client, tatamis: int, per_category: int, cats_per_tatami: int):
    stamp = datetime.now().strftime("%d%m-%H%M%S")
    t = admin.post(
        "/tournaments",
        {"name": f"[CARGA] Prueba {stamp}", "start_date": "2026-10-17", "is_test": True, "tatami_count": tatamis},
    )
    t = admin.call("PATCH", f"/tournaments/{t['id']}/status", {"status": "registration_open", "version": t["version"]})
    dojos = [admin.post("/dojos", {"name": f"Dojo Carga {stamp}-{i}"}) for i in range(6)]
    n = 0
    for ti, tat in enumerate(t["tatamis"]):
        for ci in range(cats_per_tatami):
            code = f"CARGA-{ti}-{ci}"
            c = admin.post(f"/tournaments/{t['id']}/categories", {**KUMITE, "code": code, "name": f"Kumite {code}"})
            c = admin.call("PATCH", f"/categories/{c['id']}", {"tatami_id": tat["id"], "version": c["version"]})
            for k in range(per_category):
                n += 1
                body = {
                    "first_names": f"Carga{n}",
                    "last_names": f"Competidor {stamp}",
                    "sex": "M",
                    "birth_date": (datetime(2012, 1, 1) + timedelta(days=11 * n)).date().isoformat(),
                    "dojo_id": dojos[k % len(dojos)]["id"],
                    "grade": "6 kyu",
                    "override": {"reason": "prueba de carga"},
                }
                p = admin.post("/persons", body)
                reg = {"person_id": p["id"], "category_id": c["id"], "override": {"reason": "prueba de carga"}}
                admin.post(f"/tournaments/{t['id']}/registrations", reg)
            admin.post(f"/categories/{c['id']}/bracket", {"seed": ti * 100 + ci})
    ops = []
    clave = "carga-" + uuid.uuid4().hex[:8]
    for tat in t["tatamis"]:
        uname = f"carga{stamp.replace('-', '')}t{tat['number']}"
        p = admin.post("/persons", {"first_names": "Mesa", "last_names": uname, "sex": "F"})
        admin.post("/users", {"username": uname, "password": clave, "person_id": p["id"]})
        admin.post(
            f"/persons/{p['id']}/roles", {"role": "table_operator", "scope_type": "tatami", "scope_id": tat["id"]}
        )
        ops.append({"tatami": tat, "username": uname, "password": clave})
    t = admin.call("PUT", f"/tournaments/{t['id']}/public", {"enabled": True, "names": "short"})
    return t, ops


def operate_tatami(base: str, op: dict, rng: random.Random, results: dict, stop: threading.Event) -> None:
    """Una tablet: toma el siguiente combate de la cola de su tatami hasta vaciarla."""
    cli = Client(base, login(base, op["username"], op["password"]), "mesa")
    device = f"carga-{op['tatami']['number']}-{uuid.uuid4().hex[:6]}"
    clock = datetime(2026, 10, 17, 10, tzinfo=UTC) + timedelta(hours=op["tatami"]["number"])
    done = 0

    def ev(mid: int, type_: str, **kw):
        nonlocal clock
        clock += timedelta(seconds=rng.randint(3, 20))
        body = {"id": str(uuid.uuid4()), "type": type_, "at": clock.isoformat(), **kw}
        cli.post(f"/matches/{mid}/events", body)
        if rng.random() < 0.08:  # red inestable: la tablet reenvía el mismo evento
            cli.post(f"/matches/{mid}/events", body)
        time.sleep(rng.uniform(0.2, 0.8))  # ritmo humano entre toques

    fallos = 0
    while not stop.is_set():
        q = cli.get(f"/tatamis/{op['tatami']['id']}/queue")
        if not q:  # como una tablet real: reintenta un par de veces antes de rendirse
            fallos += 1
            if fallos >= 3:
                break
            time.sleep(2)
            continue
        fallos = 0
        pending = [it for it in q["queue"] if it["match"]["status"] in ("ready", "in_progress")]
        if not pending:
            break
        m = pending[0]["match"]
        cli.post(f"/matches/{m['id']}/presence", {"device_id": device})
        ev(m["id"], "start")
        for _ in range(rng.randint(1, 6)):
            ev(m["id"], "point", color=rng.choice(["aka", "ao"]), value=rng.choice([1, 1, 2, 3]))
            ev(m["id"], "resume")
        sb = cli.get(f"/matches/{m['id']}")
        if not sb:
            break
        sug = sb["suggestion_at_time_end"]
        winner, method = sug.get("winner"), sug.get("method") or "points"
        if winner is None:
            winner, method = rng.choice(["aka", "ao"]), "hantei"
        clock += timedelta(seconds=5)
        body = {"id": str(uuid.uuid4()), "at": clock.isoformat(), "winner": winner, "method": method, "time_over": True}
        cli.post(f"/matches/{m['id']}/finish", body)
        cli.call("DELETE", f"/matches/{m['id']}/presence?device_id={device}", expect=(204,))
        done += 1
    results[f"mesa-{op['tatami']['number']}"] = {"matches": done, "lat": cli.lat, "errors": cli.errors}


HILOS_VIVO = 25  # hilos que reparten a los espectadores (cada uno hace las peticiones de varios)


def spectate(base: str, token: str, i: int, personas: int, results: dict, stop: threading.Event) -> None:
    """Varios espectadores en un hilo: entre todos refrescan el vivo cada 5 s, como la página «en vivo»."""
    cli = Client(base, None, "vivo")
    paso = REFRESCO_VIVO / max(1, personas)
    time.sleep(random.uniform(0, paso))  # no todos entran a la vez
    while not stop.is_set():
        t0 = time.perf_counter()
        cli.get(f"/public/{token}")
        time.sleep(max(0.0, paso - (time.perf_counter() - t0)))
    results[f"vivo-{i}"] = {"matches": 0, "lat": cli.lat, "errors": cli.errors}


def resumen(nombre: str, lat: list[float], errors: list[str], segundos: float) -> str:
    if not lat:
        return f"  {nombre}: sin peticiones"
    p95 = statistics.quantiles(lat, n=20)[-1] if len(lat) >= 20 else max(lat)
    return (
        f"  {nombre}: {len(lat)} peticiones ({len(lat) / segundos:.1f}/s)"
        f" · mediana {statistics.median(lat) * 1000:.0f} ms · p95 {p95 * 1000:.0f} ms"
        f" · máx {max(lat) * 1000:.0f} ms · errores {len(errors)}"
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", required=True, help="p. ej. https://hajime.lorboftherin.com")
    ap.add_argument("--user", default="admin")
    ap.add_argument("--tatamis", type=int, default=8, help="mesas operando a la vez")
    ap.add_argument("--espectadores", type=int, default=200, help="personas mirando el vivo a la vez")
    ap.add_argument("--categorias", type=int, default=1, help="categorías por tatami")
    ap.add_argument("--por-categoria", type=int, default=8, help="competidores por categoría")
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()

    password = os.environ.get("HAJIME_CARGA_ADMIN_PASSWORD") or getpass.getpass(f"Contraseña de {a.user}: ")
    admin = Client(a.url, login(a.url, a.user, password), "admin")
    admin.get("/tournaments")  # despierta la app y la base si estaban en pausa
    print(f"-> Preparando {a.tatamis} tatamis × {a.categorias} categorías × {a.por_categoria} competidores…")
    t0 = time.perf_counter()
    t, ops = setup(admin, a.tatamis, a.por_categoria, a.categorias)
    print(f"   listo en {time.perf_counter() - t0:.0f} s (torneo #{t['id']}, {len(admin.lat)} peticiones)")
    if admin.errors:
        print("Errores al preparar:", *admin.errors[:10], sep="\n  ")
        return 1

    stop = threading.Event()
    results: dict = {}
    threads = [
        threading.Thread(target=operate_tatami, args=(a.url, op, random.Random(a.seed + i), results, stop), daemon=True)
        for i, op in enumerate(ops)
    ]
    hilos = min(HILOS_VIVO, a.espectadores)
    reparto = [a.espectadores // hilos + (1 if i < a.espectadores % hilos else 0) for i in range(hilos)]
    threads += [
        threading.Thread(target=spectate, args=(a.url, t["public_token"], i, n, results, stop), daemon=True)
        for i, n in enumerate(reparto)
    ]
    print(f"-> {a.tatamis} mesas operando y {a.espectadores} espectadores mirando el vivo, a la vez…")
    t1 = time.perf_counter()
    for th in threads:
        th.start()
    for th in threads[: len(ops)]:
        th.join()
    stop.set()  # las mesas terminaron: los espectadores paran
    for th in threads[len(ops) :]:
        th.join(timeout=REFRESCO_VIVO + 5)
    segundos = time.perf_counter() - t1

    mesas = [v for k, v in results.items() if k.startswith("mesa-")]
    vivo = [v for k, v in results.items() if k.startswith("vivo-")]
    lat_m = [x for r in mesas for x in r["lat"]]
    err_m = [e for r in mesas for e in r["errors"]]
    lat_v = [x for r in vivo for x in r["lat"]]
    err_v = [e for r in vivo for e in r["errors"]]
    total = sum(r["matches"] for r in mesas)
    print(f"\nTorneo #{t['id']}: {total} combates en {len(mesas)} tatamis a la vez, {segundos:.0f} s")
    print(f"En total: {(len(lat_m) + len(lat_v)) / segundos:.1f} peticiones por segundo al servidor")
    print(resumen("Mesas (puntos, pausas, cierres)", lat_m, err_m, segundos))
    print(resumen(f"Vivo ({a.espectadores} espectadores)", lat_v, err_v, segundos))
    for e in (err_m + err_v)[:8]:
        print("  error:", e)
    peor = max([statistics.quantiles(lat_m, n=20)[-1] if len(lat_m) >= 20 else 0.0] + [0.0])
    ok = not err_m and not err_v and total > 0
    print(
        "\nRESULTADO:",
        "OK" if ok else f"{len(err_m) + len(err_v)} errores",
        "· la mesa respondió en menos de medio segundo el 95 % de las veces" if peor and peor < 0.5 else "",
    )
    print("Para más carga, sube --espectadores o --tatamis y repite; el torneo de prueba queda como de prueba.")
    return 0 if ok else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
