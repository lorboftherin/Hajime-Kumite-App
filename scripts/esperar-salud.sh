#!/usr/bin/env bash
# Espera a que Hajime responda sano en una URL base.
#
#   bash scripts/esperar-salud.sh http://localhost:8000          # 30 intentos cada 2 s
#   bash scripts/esperar-salud.sh https://hajime-test.… 40 10     # 40 intentos cada 10 s
#
# Usa /health/ready (la app puede atender: base conectada y migrada) y, si esa
# ruta aún no existe en la versión desplegada, /health. «Sano» = código 2xx y un
# objeto JSON: las rutas desconocidas devuelven el index.html de la interfaz con 200.
# Lo usan CI, release.yml, deploy-prod.yml e infra/azure/promover.sh.
set -euo pipefail
BASE="${1:?Uso: esperar-salud.sh URL_BASE [intentos] [pausa_segundos]}"
BASE="${BASE%/}"
INTENTOS="${2:-30}"
PAUSA="${3:-2}"

es_json_sano() {
  curl -sf --max-time 10 "$1" 2>/dev/null | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except ValueError:
    sys.exit(1)
sys.exit(0 if isinstance(d, dict) else 1)'
}

es_json() {
  curl -s --max-time 10 "$1" 2>/dev/null | python3 -c 'import json, sys; json.load(sys.stdin)' 2>/dev/null
}

for i in $(seq 1 "$INTENTOS"); do
  if es_json_sano "$BASE/health/ready"; then
    echo "Sano ($BASE/health/ready) en el intento $i"
    exit 0
  fi
  # Versiones anteriores sin /health/ready: la ruta cae en la interfaz (HTML).
  if ! es_json "$BASE/health/ready" && es_json_sano "$BASE/health"; then
    echo "Sano ($BASE/health; esta versión no tiene /health/ready) en el intento $i"
    exit 0
  fi
  sleep "$PAUSA"
done
echo "La app no respondió sana en $BASE tras $INTENTOS intentos" >&2
curl -s --max-time 10 "$BASE/health/ready" >&2 || true
exit 1
