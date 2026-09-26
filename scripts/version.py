"""Versión única de Hajime: el archivo VERSION de la raíz.

    python scripts/version.py              # muestra la versión
    python scripts/version.py 0.3.0        # cambia VERSION y la copia a los demás archivos
    python scripts/version.py --sync       # copia VERSION a los demás archivos
    python scripts/version.py --check      # falla si alguno no coincide (CI)

Archivos que llevan la versión (además de VERSION):
  backend/pyproject.toml           -> la API la lee con importlib.metadata (FastAPI y /docs)
  frontend/package.json            -> "version"
  frontend/package-lock.json       -> "version" de la raíz del lock
La app de Android la lee directamente de VERSION (frontend/android/app/build.gradle)
y CI nombra el APK con ella.
"""

import json
import re
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
VERSION = RAIZ / "VERSION"
PYPROJECT = RAIZ / "backend" / "pyproject.toml"
PACKAGE = RAIZ / "frontend" / "package.json"
LOCK = RAIZ / "frontend" / "package-lock.json"
SEMVER = re.compile(r"^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$")
PY_VERSION = re.compile(r'^version = "([^"]*)"$', re.M)


def leer() -> str:
    v = VERSION.read_text(encoding="utf-8").strip()
    if not SEMVER.match(v):
        sys.exit(f"VERSION no es semver (x.y.z): {v!r}")
    return v


def actuales() -> dict[str, str]:
    lock = json.loads(LOCK.read_text(encoding="utf-8"))
    return {
        str(PYPROJECT.relative_to(RAIZ)): PY_VERSION.search(PYPROJECT.read_text(encoding="utf-8")).group(1),
        str(PACKAGE.relative_to(RAIZ)): json.loads(PACKAGE.read_text(encoding="utf-8"))["version"],
        str(LOCK.relative_to(RAIZ)): lock["version"],
        str(LOCK.relative_to(RAIZ)) + ' (packages."")': lock["packages"][""]["version"],
    }


def _json_version(path: Path, v: str, lock: bool) -> None:
    # Se reemplaza solo el texto para no reformatear el archivo.
    texto = path.read_text(encoding="utf-8")
    patron = re.compile(r'^(  "version": ")[^"]*(")', re.M)
    texto = patron.sub(rf"\g<1>{v}\g<2>", texto, count=1)
    if lock:
        texto = re.compile(r'(\n    "": \{\n(?:      .*\n)*?      "version": ")[^"]*(")').sub(
            rf"\g<1>{v}\g<2>", texto, count=1
        )
    path.write_text(texto, encoding="utf-8")


def sincronizar(v: str) -> None:
    PYPROJECT.write_text(PY_VERSION.sub(f'version = "{v}"', PYPROJECT.read_text(encoding="utf-8"), 1), encoding="utf-8")
    _json_version(PACKAGE, v, lock=False)
    _json_version(LOCK, v, lock=True)


def main(args: list[str]) -> int:
    if not args:
        print(leer())
        return 0
    if args[0] == "--check":
        v = leer()
        malos = {k: x for k, x in actuales().items() if x != v}
        for k, x in malos.items():
            print(f"{k}: {x} (VERSION dice {v})")
        if malos:
            print("Corrige con: python scripts/version.py --sync")
            return 1
        print(f"Versión {v} coherente en todos los archivos")
        return 0
    if args[0] != "--sync":
        if not SEMVER.match(args[0]):
            sys.exit(f"Versión inválida: {args[0]!r} (usa x.y.z)")
        VERSION.write_text(args[0] + "\n", encoding="utf-8")
    sincronizar(leer())
    return main(["--check"])


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
