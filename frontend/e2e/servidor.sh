#!/usr/bin/env bash
# Servidor de las pruebas de extremo a extremo (lo arranca Playwright, ver
# playwright.config.ts): la API con SQLite en un archivo temporal sirviendo el
# frontend compilado, como la imagen «todo en uno» (una sola URL, sin CORS).
#
# Variables (las pone playwright.config.ts):
#   HAJIME_E2E_PORT            puerto libre donde escucha uvicorn
#   HAJIME_E2E_DIR             carpeta temporal: base, log del servidor y estado
#   HAJIME_E2E_ADMIN_PASSWORD  clave del admin inicial
#   HAJIME_E2E_PYTHON          (opcional) intérprete con el backend instalado
set -euo pipefail

FRONTEND="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$(cd "$FRONTEND/../backend" && pwd)"
: "${HAJIME_E2E_PORT:?falta HAJIME_E2E_PORT}"
: "${HAJIME_E2E_DIR:?falta HAJIME_E2E_DIR}"
: "${HAJIME_E2E_ADMIN_PASSWORD:?falta HAJIME_E2E_ADMIN_PASSWORD}"

# Frontend compilado: se (re)compila si no existe o si el código es más nuevo
# que la compilación (HAJIME_E2E_BUILD=1 fuerza compilar siempre).
STATIC="$FRONTEND/dist/hajime/browser"
if [ "${HAJIME_E2E_BUILD:-}" = "1" ] || [ ! -f "$STATIC/index.html" ] ||
  [ -n "$(find "$FRONTEND/src" "$FRONTEND/public" "$FRONTEND/angular.json" "$FRONTEND/package-lock.json" -newer "$STATIC/index.html" -print -quit)" ]; then
  echo "[e2e] Compilando el frontend…"
  (cd "$FRONTEND" && npx ng build)
fi

PYTHON="${HAJIME_E2E_PYTHON:-}"
if [ -z "$PYTHON" ]; then
  if [ -x "$BACKEND/.venv/bin/python" ]; then PYTHON="$BACKEND/.venv/bin/python"; else PYTHON=python; fi
fi

mkdir -p "$HAJIME_E2E_DIR"
export HAJIME_ENVIRONMENT=test
export HAJIME_DATABASE_URL="sqlite:///$HAJIME_E2E_DIR/hajime.db"
export HAJIME_STATIC_DIR="$STATIC"
export HAJIME_ADMIN_PASSWORD="$HAJIME_E2E_ADMIN_PASSWORD"
export HAJIME_SECRET_FILE="$HAJIME_E2E_DIR/jwt_secret"
export HAJIME_PUBLIC_URL="http://127.0.0.1:$HAJIME_E2E_PORT"
# El correo va al log (proveedor console); las pruebas leen de ahí los enlaces.
export HAJIME_MAIL_PROVIDER=console
export HAJIME_MAIL_POLL_SECONDS=0.5
export HAJIME_LOG_FORMAT=text
# Como el contenedor: la base se prepara una vez y uvicorn no migra al arrancar.
export HAJIME_MIGRATE_ON_STARTUP=false

cd "$BACKEND"
"$PYTHON" -m app.prepare
echo "[e2e] Servidor en http://127.0.0.1:$HAJIME_E2E_PORT (base y log en $HAJIME_E2E_DIR)"
# Un solo proceso; la salida queda también en servidor.log (correos incluidos).
exec "$PYTHON" -m uvicorn app.main:app --host 127.0.0.1 --port "$HAJIME_E2E_PORT" --workers 1 \
  > >(tee -a "$HAJIME_E2E_DIR/servidor.log") 2>&1
