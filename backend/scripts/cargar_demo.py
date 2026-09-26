"""Carga datos de DEMOSTRACIÓN (ficticios) en un ambiente de prueba, vía la API.

Crea tres torneos para recorrer la app como en la vida real:

  1. [DEMO] Copa Apertura: terminado hace unas semanas, con todos sus combates
     jugados punto por punto (llaves, kata por banderas y por puntaje, round
     robin, equipos). Alimenta historiales, perfiles, líderes e insignias.
  2. [DEMO] Torneo Primavera: EN CURSO hoy, con dos tatamis, operadores de mesa,
     árbitros asignados, combates por jugar, uno a medio camino y el
     seguimiento en vivo público activado.
  3. [DEMO] Campeonato Clausura: inscripciones abiertas, con las categorías de
     la plantilla base y algunas inscripciones.

Todo es ficticio: dojos, personas y resultados. Solo usa la biblioteca estándar
de Python, así que corre desde Azure Cloud Shell sin instalar nada:

    python3 scripts/cargar_demo.py --url https://hajime.lorboftherin.com

Pide la contraseña del admin (no se muestra). Crea además los usuarios de
prueba mesa1, mesa2 y sensei1, con una contraseña que muestra al final.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import random
import secrets
import sys
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone

UTC = timezone.utc  # noqa: UP017 - sin datetime.UTC: corre también en Python < 3.11

PREFIX = "[DEMO]"
REASON = {"reason": "Datos de demostración"}

DOJOS = [
    ("Shotokan Miraflores", "SHM", "Lima"),
    ("Goju Ryu San Borja", "GSB", "Lima"),
    ("Wado Kai Surco", "WKS", "Lima"),
    ("Shito Ryu Callao", "SRC", "Callao"),
    ("Dojo Kenshin La Molina", "DKM", "Lima"),
    ("Karate Do Arequipa", "KDA", "Arequipa"),
]
NOMBRES_M = [
    "Diego",
    "Mateo",
    "Sebastián",
    "Joaquín",
    "Rodrigo",
    "Adrián",
    "Gabriel",
    "Santiago",
    "Nicolás",
    "Thiago",
    "Álvaro",
    "Renzo",
    "Bruno",
    "Franco",
    "Iker",
    "Luciano",
    "Gonzalo",
    "Piero",
    "Gael",
    "Emilio",
]
NOMBRES_F = [
    "Valeria",
    "Camila",
    "Luciana",
    "Mariana",
    "Daniela",
    "Fernanda",
    "Ariana",
    "Alessandra",
    "Micaela",
    "Ximena",
    "Antonella",
    "Renata",
    "Isabella",
    "Kiara",
    "Nicole",
    "Brenda",
    "Ana Lucía",
    "Fiorella",
]
APELLIDOS = [
    "Quispe",
    "Flores",
    "Rojas",
    "Huamán",
    "Mendoza",
    "Castillo",
    "Vargas",
    "Chávez",
    "Ramos",
    "Torres",
    "Salazar",
    "Paredes",
    "Gutiérrez",
    "Cárdenas",
    "Espinoza",
    "Villanueva",
    "Mamani",
    "Aguilar",
    "Reyes",
    "Palacios",
    "Zevallos",
    "Benavides",
    "Llanos",
    "Tello",
]
KATAS = ["Heian Godan", "Bassai Dai", "Kanku Dai", "Jion", "Enpi", "Seienchin", "Unsu", "Gojushiho Sho", "Kururunfa"]
ARBITROS = [
    ("Rosa", "Medina Salas", "F"),
    ("Luis", "Ortega Pinto", "M"),
    ("Carmen", "Ríos Delgado", "F"),
    ("Jorge", "Lazo Cano", "M"),
]


class Api:
    def __init__(self, base: str):
        self.base = base.rstrip("/") + "/api/v1"
        self.token: str | None = None
        self.calls = 0

    def call(self, method: str, path: str, body=None, ok=(200, 201, 204)):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        if self.token:
            req.add_header("Authorization", f"Bearer {self.token}")
        self.calls += 1
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                status, raw = r.status, r.read()
        except urllib.error.HTTPError as e:
            status, raw = e.code, e.read()
        out = json.loads(raw) if raw else None
        if status not in ok:
            raise ApiError(method, path, status, out)
        return out

    def get(self, path):
        return self.call("GET", path)

    def post(self, path, body=None):
        return self.call("POST", path, body)

    def patch(self, path, body):
        return self.call("PATCH", path, body)

    def put(self, path, body):
        return self.call("PUT", path, body)

    def post_confirm(self, path, body):
        """POST que acepta las advertencias («advierte, no bloquea») con un motivo de demo."""
        try:
            return self.post(path, body)
        except ApiError as e:
            if e.status == 409 and e.code == "WARNINGS":
                return self.post(path, {**body, "override": REASON})
            raise


class ApiError(Exception):
    def __init__(self, method, path, status, body):
        self.status = status
        err = (body or {}).get("error", {}) if isinstance(body, dict) else {}
        self.code = err.get("code")
        super().__init__(f"{method} {path} -> {status}: {json.dumps(body, ensure_ascii=False)[:400]}")


class Demo:
    def __init__(self, api: Api, seed: int):
        self.api = api
        self.rng = random.Random(seed)
        self.used_names: set[str] = set()
        self.lima_today = (datetime.now(UTC) - timedelta(hours=5)).date()

    # --- personas -------------------------------------------------------------
    def name(self, sex: str) -> tuple[str, str]:
        while True:
            first = self.rng.choice(NOMBRES_M if sex == "M" else NOMBRES_F)
            last = f"{self.rng.choice(APELLIDOS)} {self.rng.choice(APELLIDOS)}"
            if f"{first} {last}" not in self.used_names:
                self.used_names.add(f"{first} {last}")
                return first, last

    def person(self, sex, dojo_id=None, age_years=None, grade=None, first=None, last=None):
        if first is None:
            first, last = self.name(sex)
        body = {"first_names": first, "last_names": last, "sex": sex, "dojo_id": dojo_id, "grade": grade}
        if age_years is not None:
            days = int(365.25 * age_years) + self.rng.randint(-120, 120)
            body["birth_date"] = (self.lima_today - timedelta(days=days)).isoformat()
        return self.api.post_confirm("/persons", body)

    # --- torneo ---------------------------------------------------------------
    def tournament(self, name, start, tatamis, **kw):
        t = self.api.post(
            "/tournaments",
            {
                "name": f"{PREFIX} {name}",
                "start_date": start.isoformat(),
                "city": "Lima",
                "tatami_count": tatamis,
                **kw,
            },
        )
        return self.status(t, "registration_open")

    def status(self, t, *steps):
        for st in steps:
            t = self.api.patch(f"/tournaments/{t['id']}/status", {"status": st, "version": t["version"]})
        return t

    def category(self, t, tatami, **fields):
        c = self.api.post(f"/tournaments/{t['id']}/categories", fields)
        if tatami is not None:
            c = self.api.patch(f"/categories/{c['id']}", {"tatami_id": tatami["id"], "version": c["version"]})
        return c

    def register(self, t, c, people, weight=None):
        for p in people:
            body = {"person_id": p["id"], "category_id": c["id"]}
            if weight:
                body["weight_class"] = weight
            self.api.post_confirm(f"/tournaments/{t['id']}/registrations", body)

    def team(self, t, c, dojo, name, members, sub=None):
        body = {
            "category_id": c["id"],
            "dojo_id": dojo["id"],
            "name": name,
            "members": [{"person_id": p["id"]} for p in members]
            + ([{"person_id": sub["id"], "role": "substitute"}] if sub else []),
        }
        return self.api.post_confirm(f"/tournaments/{t['id']}/teams", body)

    def bracket(self, c, **kw):
        return self.api.post(f"/categories/{c['id']}/bracket", {"seed": self.rng.randint(1, 9999), **kw})

    # --- combates -------------------------------------------------------------
    def ev(self, mid, type_, at, color=None, value=None):
        body = {"id": str(uuid.uuid4()), "type": type_, "at": at.isoformat(), "color": color, "value": value}
        return self.api.post(f"/matches/{mid}/events", body)

    def finish(self, mid, at, winner, method="points", time_over=True):
        body = {"id": str(uuid.uuid4()), "at": at.isoformat(), "winner": winner, "method": method}
        body["time_over"] = time_over
        return self.api.post_confirm(f"/matches/{mid}/finish", body)

    def kumite(self, mid, at, duration, strength=0.5, allow_draw=False, stop_at=None):
        """Juega un combate punto por punto y devuelve la hora en que terminó.

        strength: probabilidad de que AKA marque cada punto (el favorito).
        stop_at: segundos de reloj en que se deja el combate a medio camino.
        """
        rng = self.rng
        score = {"aka": 0, "ao": 0}
        clock = 0.0
        self.ev(mid, "start", at)
        n_points = rng.choice([1, 2, 2, 3, 3, 4, 4, 5, 6, 7])
        marks = sorted(rng.uniform(4, duration - 3) for _ in range(n_points))
        for mark in marks:
            if stop_at is not None and mark > stop_at:
                break
            at += timedelta(seconds=mark - clock)
            clock = mark
            color = "aka" if rng.random() < strength else "ao"
            value = rng.choices([1, 2, 3], weights=[6, 3, 1])[0]
            score[color] += value
            self.ev(mid, "point", at, color, value)
            if rng.random() < 0.12:
                self.ev(mid, "sanction", at + timedelta(seconds=3), rng.choice(["aka", "ao"]), 1)
            at += timedelta(seconds=rng.randint(6, 14))
            if abs(score["aka"] - score["ao"]) >= 8:  # diferencia de 8: termina antes
                self.ev(mid, "resume", at)
                return self.finish(mid, at + timedelta(seconds=1), max(score, key=score.get), "point_gap", False) and at
            self.ev(mid, "resume", at)
        if stop_at is not None:
            at += timedelta(seconds=max(1, stop_at - clock))
            self.ev(mid, "pause", at)
            return at
        at += timedelta(seconds=duration - clock)
        if score["aka"] == score["ao"]:
            if allow_draw and rng.random() < 0.6:
                self.finish(mid, at, "draw")
                return at
            winner = "aka" if rng.random() < strength else "ao"
            self.ev(mid, "hantei", at + timedelta(seconds=5), winner)
            self.finish(mid, at + timedelta(seconds=8), winner, "hantei")
        else:
            self.finish(mid, at, max(score, key=score.get), "points")
        return at

    def flags(self, mid, at, judges=5, strength=0.5):
        aka = sum(self.rng.random() < strength for _ in range(judges))
        if aka * 2 == judges:
            aka += 1
        votes = ["aka"] * aka + ["ao"] * (judges - aka)
        self.rng.shuffle(votes)
        body = {"votes": votes, "event_id": str(uuid.uuid4()), "at": at.isoformat()}
        self.api.post(f"/matches/{mid}/flags", body)

    def kata_scores(self, c, regs_by_person):
        for rid in regs_by_person:
            level = self.rng.uniform(6.4, 8.4)
            scores = [round(min(9.8, max(5.0, level + self.rng.uniform(-0.4, 0.4))), 1) for _ in range(5)]
            body = {"registration_id": rid, "scores": scores, "kata_name": self.rng.choice(KATAS)}
            self.api.post(f"/categories/{c['id']}/kata-scores", body)

    def play(self, c, at, kind="kumite", duration=120, max_round=None, limit=None, favorites=None):
        """Juega los combates listos de la categoría hasta terminarla (o hasta max_round/limit)."""
        favorites = favorites or {}
        played = 0
        while True:
            b = self.api.get(f"/categories/{c['id']}/bracket")
            ready = [
                m for m in b["matches"] if m["status"] == "ready" and (max_round is None or m["round"] <= max_round)
            ]
            if not ready or (limit is not None and played >= limit):
                return at
            for m in ready:
                if limit is not None and played >= limit:
                    return at
                s = 0.5 + 0.25 * (
                    favorites.get(m["aka_registration_id"], 0) - favorites.get(m["ao_registration_id"], 0)
                )
                s = min(0.85, max(0.15, s))
                if kind == "kumite":
                    at = self.kumite(m["id"], at, duration, s) + timedelta(seconds=self.rng.randint(60, 150))
                elif kind == "flags":
                    self.flags(m["id"], at, 5, s)
                    at += timedelta(minutes=4)
                elif kind == "team":
                    at = self.team_match(m, at, duration)
                played += 1

    def team_match(self, m, at, duration):
        tm = self.api.get(f"/matches/{m['id']}/team")
        aka = [x["person_id"] for x in tm["aka"]["members"] if x["role"] == "starter"]
        ao = [x["person_id"] for x in tm["ao"]["members"] if x["role"] == "starter"]
        self.rng.shuffle(aka)
        self.rng.shuffle(ao)
        n = min(len(aka), len(ao), tm["settings"]["bouts"])
        pairs = zip(aka[:n], ao[:n])  # noqa: B905 - mismo largo; sin strict= para Python < 3.10
        body = {"bouts": [{"aka_person_id": a, "ao_person_id": o} for a, o in pairs]}
        try:
            tm = self.api.put(f"/matches/{m['id']}/lineup", body)
        except ApiError as e:
            if e.status != 409 or e.code != "WARNINGS":
                raise
            tm = self.api.put(f"/matches/{m['id']}/lineup", {**body, "override": REASON})
        for bout in tm["bouts"]:
            if self.api.get(f"/matches/{m['id']}/team")["match"]["status"] == "finished":
                break  # el enfrentamiento ya se decidió por mayoría
            at = self.kumite(bout["match"]["id"], at, duration, allow_draw=True) + timedelta(seconds=60)
        tm = self.api.get(f"/matches/{m['id']}/team")
        if tm["decision"].get("needs_extra_bout"):
            body = {"bouts": [{"aka_person_id": aka[0], "ao_person_id": ao[0]}], "extra": True}
            extra = self.api.put(f"/matches/{m['id']}/lineup", body)["bouts"][-1]
            at = self.kumite(extra["match"]["id"], at, duration) + timedelta(seconds=60)
        return at + timedelta(minutes=2)

    def regs(self, t, c):
        return [r for r in self.api.get(f"/tournaments/{t['id']}/registrations") if r["category_id"] == c["id"]]

    def user(self, username, password, person, display):
        try:
            self.api.post(
                "/users",
                {"username": username, "password": password, "display_name": display, "person_id": person["id"]},
            )
            return True
        except ApiError as e:
            if e.status == 409:
                print(f"   · el usuario {username} ya existía: no se cambia su contraseña")
                return False
            raise


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", required=True, help="p. ej. https://hajime.lorboftherin.com")
    ap.add_argument("--user", default="admin")
    ap.add_argument("--seed", type=int, default=2026)
    ap.add_argument("--otra-vez", action="store_true", help="cargar aunque ya existan torneos [DEMO]")
    a = ap.parse_args()

    api = Api(a.url)
    password = os.environ.get("HAJIME_DEMO_ADMIN_PASSWORD") or getpass.getpass(f"Contraseña de {a.user}: ")
    try:
        api.token = api.post("/auth/login", {"username": a.user, "password": password})["access_token"]
    except ApiError as e:
        print("No se pudo entrar:", e)
        return 1
    existing = [t["name"] for t in api.get("/tournaments?include_test=true") if t["name"].startswith(PREFIX)]
    if existing and not a.otra_vez:
        print("Ya hay torneos de demostración:", *existing, sep="\n  ")
        print("Usa --otra-vez para cargar otro juego de datos.")
        return 1

    d = Demo(api, a.seed)
    rng = d.rng
    today = d.lima_today
    print("-> Dojos y competidores ficticios…")
    dojos = [api.post("/dojos", {"name": n, "short_name": sn, "city": city}) for n, sn, city in DOJOS]

    def pool(sex, n, age, grades):
        return [d.person(sex, dojos[i % len(dojos)]["id"], age, rng.choice(grades)) for i in range(n)]

    kids_m = pool("M", 10, 12.6, ["8 kyu", "7 kyu", "6 kyu", "5 kyu"])
    kids_f = pool("F", 8, 12.6, ["8 kyu", "7 kyu", "6 kyu", "5 kyu"])
    cadets_m = pool("M", 7, 14.6, ["5 kyu", "4 kyu", "3 kyu", "2 kyu"])
    seniors_f = pool("F", 8, 24, ["2 kyu", "1 kyu", "1 dan", "2 dan"])
    # 12 senior varones de los 4 primeros dojos (3 por dojo) para los equipos.
    seniors_m = [
        d.person("M", dojos[i % 4]["id"], 25, rng.choice(["1 kyu", "1 dan", "2 dan", "3 dan"])) for i in range(12)
    ]
    everyone = kids_m + kids_f + cadets_m + seniors_f + seniors_m
    # Nivel de cada competidor: hace que los resultados tengan sentido entre torneos.
    level = {p["id"]: rng.uniform(-1, 1) for p in everyone}
    print(f"   {len(dojos)} dojos y {len(everyone)} competidores")

    # ------------------------------------------------------------------ 1
    past = today - timedelta(days=35)
    print(f"-> {PREFIX} Copa Apertura ({past:%d/%m/%Y}, terminado)…")
    t1 = d.tournament("Copa Apertura", past, 2, venue="Coliseo Manuel Bonilla, Miraflores")
    tat = t1["tatamis"]
    kumite_kids_m = d.category(
        t1,
        tat[0],
        code="KU-12-13-M",
        name="Kumite 12-13 Masculino",
        modality="kumite",
        sex="M",
        age_min=12,
        age_max=13,
        duration_seconds=90,
    )
    kumite_kids_f = d.category(
        t1,
        tat[0],
        code="KU-12-13-F",
        name="Kumite 12-13 Femenino",
        modality="kumite",
        sex="F",
        age_min=12,
        age_max=13,
        duration_seconds=90,
        format="round_robin",
    )
    kata_kids_m = d.category(
        t1,
        tat[0],
        code="KA-12-13-M",
        name="Kata 12-13 Masculino",
        modality="kata",
        sex="M",
        age_min=12,
        age_max=13,
        kata_method="flags",
        kata_judges=5,
    )
    kumite_sen_m = d.category(
        t1,
        tat[1],
        code="KU-18-M-75",
        name="Kumite Senior Masculino -75 kg",
        modality="kumite",
        sex="M",
        age_min=18,
        weight_class="-75",
        duration_seconds=180,
        third_place_rule="third_place_match",
    )
    kata_sen_f = d.category(
        t1,
        tat[1],
        code="KA-18-F",
        name="Kata Senior Femenino",
        modality="kata",
        sex="F",
        age_min=18,
        kata_method="scores",
        kata_structure="rounds",
        kata_judges=5,
    )
    team_sen_m = d.category(
        t1,
        tat[1],
        code="KU-EQ-18-M",
        name="Kumite por equipos Senior Masculino",
        modality="kumite",
        sex="M",
        age_min=18,
        is_team=True,
        duration_seconds=180,
    )
    d.register(t1, kumite_kids_m, kids_m[:8])
    d.register(t1, kumite_kids_f, kids_f[:5])
    d.register(t1, kata_kids_m, kids_m[2:9])
    d.register(t1, kumite_sen_m, seniors_m[:8], weight="-75")
    d.register(t1, kata_sen_f, seniors_f[:7])
    # seniors_m[i] es del dojo i % 4
    by_dojo = {dj["id"]: seniors_m[k::4] for k, dj in enumerate(dojos[:4])}
    for dj in dojos[:4]:
        d.team(t1, team_sen_m, dj, f"{dj['short_name']} A", by_dojo[dj["id"]][:3])
    t1 = d.status(t1, "registration_closed", "in_progress")

    fav = {}
    for c in (kumite_kids_m, kumite_kids_f, kata_kids_m, kumite_sen_m, kata_sen_f, team_sen_m):
        for r in d.regs(t1, c):
            fav[r["id"]] = level.get(r["person_id"], rng.uniform(-1, 1))
    start = datetime.combine(past, datetime.min.time(), UTC) + timedelta(hours=14)  # 9:00 en Lima
    at0 = start
    for c, kind, dur in ((kumite_kids_m, "kumite", 90), (kumite_kids_f, "kumite", 90), (kata_kids_m, "flags", 0)):
        d.bracket(c)
        at0 = d.play(c, at0, kind, dur, favorites=fav)
    at1 = start
    for c, kind, dur in ((kumite_sen_m, "kumite", 180), (team_sen_m, "team", 180)):
        d.bracket(c)
        at1 = d.play(c, at1, kind, dur, favorites=fav)
    d.bracket(kata_sen_f)
    d.kata_scores(kata_sen_f, [r["id"] for r in d.regs(t1, kata_sen_f)])
    d.status(t1, "finished")
    print("   terminado, con todos sus combates jugados")

    # ------------------------------------------------------------------ 2
    print(f"-> {PREFIX} Torneo Primavera ({today:%d/%m/%Y}, en curso)…")
    t2 = d.tournament("Torneo Primavera", today, 2, venue="Polideportivo de Surco")
    tat = t2["tatamis"]
    c_kids_m = d.category(
        t2,
        tat[0],
        code="KU-12-13-M",
        name="Kumite 12-13 Masculino",
        modality="kumite",
        sex="M",
        age_min=12,
        age_max=13,
        duration_seconds=90,
    )
    c_kata_kids_f = d.category(
        t2,
        tat[0],
        code="KA-12-13-F",
        name="Kata 12-13 Femenino",
        modality="kata",
        sex="F",
        age_min=12,
        age_max=13,
        kata_method="flags",
        kata_judges=5,
    )
    c_cadets = d.category(
        t2,
        tat[0],
        code="KU-14-15-M",
        name="Kumite Cadete 14-15 Masculino",
        modality="kumite",
        sex="M",
        age_min=14,
        age_max=15,
        duration_seconds=120,
    )
    c_sen_m = d.category(
        t2,
        tat[1],
        code="KU-18-M-75",
        name="Kumite Senior Masculino -75 kg",
        modality="kumite",
        sex="M",
        age_min=18,
        weight_class="-75",
        duration_seconds=180,
    )
    c_sen_f = d.category(
        t2,
        tat[1],
        code="KU-18-F",
        name="Kumite Senior Femenino",
        modality="kumite",
        sex="F",
        age_min=18,
        duration_seconds=180,
    )
    c_team = d.category(
        t2,
        tat[1],
        code="KU-EQ-18-M",
        name="Kumite por equipos Senior Masculino",
        modality="kumite",
        sex="M",
        age_min=18,
        is_team=True,
        duration_seconds=180,
    )
    d.register(t2, c_kids_m, kids_m[1:9])
    d.register(t2, c_kata_kids_f, kids_f[:6])
    d.register(t2, c_cadets, cadets_m[:6])
    d.register(t2, c_sen_m, seniors_m[2:10], weight="-75")
    d.register(t2, c_sen_f, seniors_f[:4])
    for dj in dojos[:4]:
        members = by_dojo[dj["id"]]
        d.team(t2, c_team, dj, f"{dj['short_name']} A", members[:3])
    t2 = d.status(t2, "registration_closed", "in_progress")
    fav = {}
    for c in (c_kids_m, c_cadets, c_sen_m, c_sen_f):
        for r in d.regs(t2, c):
            fav[r["id"]] = level.get(r["person_id"], 0)
    now = datetime.now(UTC)
    start = now - timedelta(hours=3)
    for c in (c_kids_m, c_kata_kids_f, c_cadets, c_sen_m, c_sen_f, c_team):
        d.bracket(c)
    # Tatami 1: cadetes terminados, 12-13 M con la primera ronda jugada, kata sin empezar.
    at0 = d.play(c_cadets, start, "kumite", 120, favorites=fav)
    at0 = d.play(c_kids_m, at0, "kumite", 90, max_round=1, favorites=fav)
    # Tatami 2: senior -75 terminado; senior femenino con un combate a medio camino.
    at1 = d.play(c_sen_m, start, "kumite", 180, favorites=fav)
    live = next(m for m in api.get(f"/categories/{c_sen_f['id']}/bracket")["matches"] if m["status"] == "ready")
    d.kumite(live["id"], min(at1, now - timedelta(minutes=5)), 180, stop_at=75)

    # Árbitros, operadores de mesa y un sensei.
    refs = [d.person(sx, None, 40, None, first=f, last=last) for f, last, sx in ARBITROS]
    for p in refs:
        api.post(f"/tournaments/{t2['id']}/referees", {"person_id": p["id"]})
    positions = ["Árbitro central", "Juez 1"]
    for i, p in enumerate(refs):
        body = {"person_id": p["id"], "target_type": "tatami", "target_id": tat[i // 2]["id"]}
        api.post(f"/tournaments/{t2['id']}/referee-assignments", {**body, "position": positions[i % 2]})
    demo_pass = "demo-" + secrets.token_hex(3)
    ops = []
    for i, tt in enumerate(tat, start=1):
        p = d.person("F" if i == 1 else "M", None, 30, None)
        if d.user(f"mesa{i}", demo_pass, p, f"Mesa {i} · {p['first_names']}"):
            api.post(
                f"/persons/{p['id']}/roles", {"role": "table_operator", "scope_type": "tatami", "scope_id": tt["id"]}
            )
        ops.append(f"mesa{i}")
    sensei = d.person("M", dojos[0]["id"], 48, "5 dan", first="Kenji", last="Tamashiro Oshiro")
    if d.user("sensei1", demo_pass, sensei, "Sensei Tamashiro"):
        api.post(f"/persons/{sensei['id']}/roles", {"role": "sensei", "scope_type": "dojo", "scope_id": dojos[0]["id"]})
    t2 = api.get(f"/tournaments/{t2['id']}")
    t2 = api.put(f"/tournaments/{t2['id']}/public", {"enabled": True, "names": "short"})
    print("   en curso: combates jugados, uno a medio camino y otros por jugar")

    # ------------------------------------------------------------------ 3
    future = today + timedelta(days=45)
    print(f"-> {PREFIX} Campeonato Clausura ({future:%d/%m/%Y}, inscripciones abiertas)…")
    templates = api.get("/templates")
    tpl = templates[0]["id"] if templates else None
    t3 = d.tournament("Campeonato Clausura", future, 3, venue="Coliseo Eduardo Dibós", template_id=tpl)
    cats = api.get(f"/tournaments/{t3['id']}/categories")
    if not cats and tpl:
        api.post(f"/tournaments/{t3['id']}/generate-categories", {"template_id": tpl})
        cats = api.get(f"/tournaments/{t3['id']}/categories")
    by_id = {c["id"]: c for c in cats}
    n = 0
    for p in rng.sample(everyone, 30):
        sug = api.get(f"/tournaments/{t3['id']}/suggestions?person_id={p['id']}")
        kata = [s for s in sug if s["modality"] == "kata"]
        kumite = [s for s in sug if s["modality"] == "kumite"]
        for s in kata[:1] + ([rng.choice(kumite)] if kumite else []):
            body = {"person_id": p["id"], "category_id": s["category_id"]}
            if by_id[s["category_id"]].get("weight_class"):
                body["weight_class"] = by_id[s["category_id"]]["weight_class"]
            api.post_confirm(f"/tournaments/{t3['id']}/registrations", body)
            n += 1
    print(f"   {len(cats)} categorías y {n} inscripciones")

    base = a.url.rstrip("/")
    print(
        f"""
================================================================
 Datos de demostración cargados ({api.calls} llamadas a la API).

 Torneos:  {base}/torneos
 En vivo (público, sin cuenta):  {base}/vivo/{t2["public_token"]}

 Usuarios de prueba (contraseña: {demo_pass}):
   mesa1    operador de mesa del Tatami 1 del Torneo Primavera
   mesa2    operador de mesa del Tatami 2
   sensei1  sensei del dojo {dojos[0]["name"]}
 Al entrar la primera vez puede pedir cambiar la contraseña.
================================================================"""
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ApiError as e:
        print("\nError de la API:", e)
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(130)
