"""Genera docs/openapi.json (contrato de la API) a partir de la app.

    python scripts/exportar_openapi.py            # reescribe docs/openapi.json
    python scripts/exportar_openapi.py --check    # falla si el archivo no está al día (CI)

No arranca el servidor ni toca la base: solo arma la app y pide su esquema.
"""

import json
import os
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parents[2] / "docs" / "openapi.json"


def generar() -> str:
    # Sin frontend compilado: el esquema no depende de él y así no hace falta `ng build`.
    os.environ["HAJIME_STATIC_DIR"] = ""
    from app.main import create_app

    esquema = create_app().openapi()
    return json.dumps(esquema, indent=1, ensure_ascii=False) + "\n"


def main() -> int:
    nuevo = generar()
    if "--check" in sys.argv:
        actual = OUT.read_text(encoding="utf-8") if OUT.exists() else ""
        if actual != nuevo:
            print(f"{OUT} no está al día: ejecuta `python scripts/exportar_openapi.py` y súbelo.")
            return 1
        print(f"{OUT} al día")
        return 0
    OUT.write_text(nuevo, encoding="utf-8")
    print(f"Escrito {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
