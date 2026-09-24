import itertools
import uuid
from datetime import UTC, date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

import app.db.models  # noqa: F401
from app.db import base
from app.db.base import Base
from app.db.models import User
from app.main import create_app
from app.security import hash_password


@pytest.fixture()
def client():
    engine = base.init_engine("sqlite://")
    Base.metadata.create_all(engine)
    db = next(base.get_session())
    db.add(User(username="admin", password_hash=hash_password("secret123"), is_admin=True, display_name="Admin"))
    db.commit()
    with TestClient(create_app()) as c:
        tok = c.post("/api/v1/auth/login", json={"username": "admin", "password": "secret123"}).json()["access_token"]
        c.headers["Authorization"] = f"Bearer {tok}"
        yield Api(c)
    engine.dispose()


_clock = itertools.count()
_births = itertools.count()


def now_iso() -> str:
    return (datetime(2026, 10, 17, 10, tzinfo=UTC) + timedelta(seconds=next(_clock))).isoformat()


class Api:
    """Pequeño helper: prefijo /api/v1 y aserción de status."""

    def __init__(self, c: TestClient):
        self.c = c

    def _call(self, method, path, expect, **kw):
        r = self.c.request(method, f"/api/v1{path}", **kw)
        if expect is not None:
            assert r.status_code == expect, f"{method} {path} -> {r.status_code}: {r.text}"
        return r

    def get(self, path, expect=200, **kw):
        return self._call("GET", path, expect, **kw).json()

    def post(self, path, json=None, expect=200, **kw):
        r = self._call("POST", path, expect, json=json, **kw)
        return r.json() if r.content else None

    def patch(self, path, json=None, expect=200):
        return self._call("PATCH", path, expect, json=json).json()

    def raw(self, method, path, **kw):
        return self.c.request(method, f"/api/v1{path}", **kw)

    # --- atajos de dominio ---
    def dojo(self, name):
        return self.post("/dojos", {"name": f"Dojo {name}"}, expect=201)

    def person(self, first, last, dojo_id, sex="M", birth=None, grade="8 kyu", **kw):
        if birth is None:  # fechas distintas para no disparar la detección de duplicados
            birth = (date(2013, 1, 1) + timedelta(days=7 * (next(_births) % 90))).isoformat()
        body = {
            "first_names": first,
            "last_names": last,
            "sex": sex,
            "birth_date": birth,
            "dojo_id": dojo_id,
            "grade": grade,
            **kw,
        }
        return self.post("/persons", body, expect=201)

    def event(self, mid, type_, color=None, value=None, target_id=None, eid=None, expect=201):
        body = {"id": eid or str(uuid.uuid4()), "type": type_, "at": now_iso(), "color": color, "value": value}
        if target_id:
            body["target_id"] = target_id
        return self.post(f"/matches/{mid}/events", body, expect=expect)

    def finish(self, mid, winner, method="points", override=None, expect=200, time_over=True):
        body = {"id": str(uuid.uuid4()), "at": now_iso(), "winner": winner, "method": method, "time_over": time_over}
        if override:
            body["override"] = {"reason": override}
        return self.post(f"/matches/{mid}/finish", body, expect=expect)
