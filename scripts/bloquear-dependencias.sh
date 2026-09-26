#!/usr/bin/env bash
# Regenera los lockfiles del backend a partir de backend/pyproject.toml.
#
#   bash scripts/bloquear-dependencias.sh            # respeta las versiones ya fijadas si siguen siendo válidas
#   bash scripts/bloquear-dependencias.sh --upgrade  # sube todo a lo último que permita pyproject.toml
#
# Genera (con hashes, válidos en Linux, macOS y Windows):
#   backend/requirements.lock        dependencias de la app (lo que va en la imagen)
#   backend/requirements-mssql.lock  + driver de SQL Server (imagen para Azure)
#   backend/requirements-dev.lock    + herramientas de desarrollo (pytest, ruff…)
# Los dos últimos se resuelven con el primero como restricción: comparten versiones.
# Requiere uv (https://docs.astral.sh/uv/): pip install uv
set -euo pipefail
cd "$(dirname "$0")/../backend"

EXTRA=()
if [ "${1:-}" = "--upgrade" ]; then EXTRA=(--upgrade); fi
COMUN=(--universal --python-version 3.11 --generate-hashes --quiet
  --custom-compile-command "bash scripts/bloquear-dependencias.sh" "${EXTRA[@]}")

uv pip compile pyproject.toml "${COMUN[@]}" -o requirements.lock
uv pip compile pyproject.toml --extra mssql -c requirements.lock "${COMUN[@]}" -o requirements-mssql.lock
uv pip compile pyproject.toml --extra dev -c requirements.lock "${COMUN[@]}" -o requirements-dev.lock
echo "Listo: backend/requirements*.lock"
