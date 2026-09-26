#!/usr/bin/env bash
# Prueba de humo de la imagen "todo en uno", como corre en producción: dos
# procesos (HAJIME_WORKERS=2) sobre una base vacía que arrancan a la vez.
#
#   bash scripts/humo-contenedor.sh hajime:ci
#   bash scripts/humo-contenedor.sh hajime:azure --mssql   # además: driver de SQL Server
#
# Lo usan ci.yml y release.yml. Deja el contenedor borrado al terminar.
set -euo pipefail
IMAGEN="${1:?Uso: humo-contenedor.sh IMAGEN [--mssql]}"
NOMBRE="hajime-humo-$$"
PUERTO="${PUERTO:-8000}"
CLAVE="ci-password-123"
AQUI="$(cd "$(dirname "$0")" && pwd)"

limpiar() {
  echo "--- registros del contenedor ---"
  docker logs "$NOMBRE" 2>&1 | tail -40 || true
  docker rm -f "$NOMBRE" >/dev/null 2>&1 || true
}
trap limpiar EXIT

if [ "${2:-}" = "--mssql" ]; then
  docker run --rm "$IMAGEN" python -c \
    "import pyodbc; assert 'ODBC Driver 18 for SQL Server' in pyodbc.drivers(), pyodbc.drivers()"
fi

docker run -d --name "$NOMBRE" -p "$PUERTO:8000" \
  -e HAJIME_WORKERS=2 -e HAJIME_ADMIN_PASSWORD="$CLAVE" "$IMAGEN" >/dev/null
BASE="http://localhost:$PUERTO"
bash "$AQUI/esperar-salud.sh" "$BASE" 45 2

# Los dos procesos terminaron de arrancar (ninguno cayó por la carrera del primer arranque).
for _ in $(seq 1 15); do
  LISTOS="$(docker logs "$NOMBRE" 2>&1 | grep -c 'Application startup complete' || true)"
  [ "$LISTOS" -ge 2 ] && break
  sleep 2
done
echo "Procesos listos: $LISTOS"
[ "$LISTOS" -ge 2 ] || { echo "Se esperaban 2 procesos listos" >&2; exit 1; }
if docker logs "$NOMBRE" 2>&1 | grep -q 'Traceback'; then
  echo "Hay errores (Traceback) en los registros del arranque" >&2
  exit 1
fi

# Interfaz: la raíz y una ruta de Angular devuelven la app.
curl -sf "$BASE/" | grep -qi "<app-root"
curl -sf "$BASE/mesa/1" | grep -qi "<app-root"

# API: el admin del primer arranque entra y la plantilla base quedó cargada.
TOKEN="$(curl -sf "$BASE/api/v1/auth/login" -H 'content-type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$CLAVE\"}" |
  python3 -c 'import sys, json; print(json.load(sys.stdin)["access_token"])')"
curl -sf "$BASE/api/v1/templates" -H "Authorization: Bearer $TOKEN" | python3 -c \
  'import sys, json; t = json.load(sys.stdin); assert t and len(t[0]["items"]) > 0, t; print("plantilla:", len(t[0]["items"]), "categorías")'
echo "Prueba de humo OK: $IMAGEN"
