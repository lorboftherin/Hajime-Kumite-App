"""Varios procesos arrancando a la vez sobre una base vacía no chocan.

Antes cada proceso de uvicorn migraba al iniciar: con `--workers 2` sobre una
base nueva, uno moría con «table users already exists». Estas pruebas levantan
procesos de verdad (tardan unos segundos).
"""

import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _env(tmp_path: Path, **extra) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("HAJIME_")}
    env.update(
        HAJIME_ENVIRONMENT="test",
        HAJIME_DATABASE_URL=f"sqlite:///{tmp_path / 'vacia.db'}",
        HAJIME_SECRET_FILE=str(tmp_path / "jwt_secret"),
        HAJIME_ADMIN_PASSWORD="clave-de-prueba",
        HAJIME_PASSWORD_ITERATIONS="1000",
        HAJIME_LOG_LEVEL="WARNING",
        **extra,
    )
    return env


def _get(url: str) -> tuple[int, dict]:
    try:
        with urllib.request.urlopen(url, timeout=2) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, {}


def _wait_ready(port: int, proc: subprocess.Popen, deadline: float) -> None:
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            out = proc.stdout.read().decode(errors="replace") if proc.stdout else ""
            pytest.fail(f"El proceso del puerto {port} murió al arrancar:\n{out[-3000:]}")
        try:
            if _get(f"http://127.0.0.1:{port}/health/ready")[0] == 200:
                return
        except OSError:
            pass
        time.sleep(0.1)
    pytest.fail(f"El puerto {port} no quedó listo a tiempo")


def test_two_uvicorn_processes_on_empty_sqlite(tmp_path):
    env = _env(tmp_path)
    ports = [_free_port(), _free_port()]
    procs = [
        subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(p)],
            cwd=BACKEND,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        for p in ports
    ]
    try:
        deadline = time.monotonic() + 15
        for port, proc in zip(ports, procs, strict=True):
            _wait_ready(port, proc, deadline)
        for port in ports:
            assert _get(f"http://127.0.0.1:{port}/health")[0] == 200
        # Un solo admin, creado por uno de los dos.
        req = urllib.request.Request(
            f"http://127.0.0.1:{ports[1]}/api/v1/auth/login",
            data=json.dumps({"username": "admin", "password": "clave-de-prueba"}).encode(),
            headers={"content-type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=5) as r:
            assert r.status == 200
    finally:
        for proc in procs:
            proc.terminate()
        for proc in procs:
            proc.wait(timeout=10)


def test_prepare_runs_concurrently_and_is_idempotent(tmp_path):
    env = _env(tmp_path)
    cmd = [sys.executable, "-m", "app.prepare"]
    pipes = {"stdout": subprocess.PIPE, "stderr": subprocess.STDOUT}
    procs = [subprocess.Popen(cmd, cwd=BACKEND, env=env, **pipes) for _ in "ab"]
    for proc in procs:
        out, _ = proc.communicate(timeout=60)
        assert proc.returncode == 0, out.decode(errors="replace")[-3000:]
    # Una tercera vez, con todo ya hecho, tampoco falla.
    again = subprocess.run(cmd, cwd=BACKEND, env=env, capture_output=True, timeout=60)
    assert again.returncode == 0, again.stdout.decode(errors="replace")[-3000:]
