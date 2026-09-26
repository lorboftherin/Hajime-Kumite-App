#!/usr/bin/env bash
# Despliega en un ambiente una imagen ya publicada por CI o por un Release.
#
#   bash promover.sh test 1a2b3c4       # la imagen sha-1a2b3c4-azure
#   bash promover.sh prod 0.2.0         # la imagen 0.2.0-azure
#   bash promover.sh --solo-etiqueta 1a2b3c4   # solo imprime la etiqueta (la usa deploy-prod.yml)
#
# Pasos: migraciones con el job hajime-<amb>-migrar (si existe) → nueva revisión
# de la app → espera /health/ready → prueba de humo. Lo usan ci.yml (pruebas) y
# deploy-prod.yml (producción), y se puede correr a mano desde Cloud Shell.
#
# Variables opcionales:
#   IMAGEN_BASE=ghcr.io/…            repositorio de la imagen (por defecto el de Hajime)
#   SIN_MIGRAR=1                     no correr el job de migraciones
#   ROLLBACK_AUTOMATICO=1            si la nueva revisión no queda sana, volver a la anterior
#
# Las migraciones deben ser compatibles con la versión anterior de la app
# (agregar antes de quitar): un rollback vuelve la app, no la base.
set -euo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=comun.sh
source "$AQUI/comun.sh"

if [ "${1:-}" = "--solo-etiqueta" ]; then
  etiqueta_imagen "${2:?Falta el SHA o la versión}"
  exit 0
fi
nombres_ambiente "${1:?Uso: bash promover.sh test|prod SHA|versión}"
ETIQUETA="$(etiqueta_imagen "${2:?Falta el SHA o la versión}")"
IMAGEN="$IMAGEN_BASE:$ETIQUETA"
preparar_az

echo "== Promover $IMAGEN a '$AMBIENTE' =="
existe_app || { echo "No existe la app $APP en $RG: crea el ambiente con crear-ambiente.sh $AMBIENTE" >&2; exit 1; }
ANTERIOR="$(revision_activa)"
echo "   revisión activa ahora: $ANTERIOR"

if [ -n "${SIN_MIGRAR:-}" ]; then
  echo "-> Migraciones omitidas (SIN_MIGRAR)"
elif existe_job; then
  correr_migraciones "$IMAGEN"
else
  echo "-> Aviso: no existe el job $JOB; la app debe migrar al arrancar." >&2
  echo "   Vuelve a correr crear-ambiente.sh $AMBIENTE para crearlo." >&2
fi

# Sufijo legible y único: la lista de revisiones muestra qué imagen tiene cada una.
# (minúsculas, números y guiones; debe empezar con letra: 0.2.0 -> v0-2-0-HHMMSS).
SUFIJO="$(echo "${ETIQUETA%-azure}" | tr '.' '-' | tr -cd 'a-z0-9-' | cut -c1-20)"
[[ "$SUFIJO" =~ ^[a-z] ]] || SUFIJO="v$SUFIJO"
SUFIJO="$SUFIJO-$(date -u +%H%M%S)"
echo "-> Nueva revisión $APP--$SUFIJO…"
az containerapp update -g "$RG" -n "$APP" --image "$IMAGEN" --revision-suffix "$SUFIJO" -o none

FQDN="$(fqdn_app)"
URL="https://$FQDN"
volver() {
  if [ -n "${ROLLBACK_AUTOMATICO:-}" ] && [ -n "$ANTERIOR" ]; then
    echo "-> Volviendo a la revisión anterior $ANTERIOR…" >&2
    bash "$AQUI/rollback.sh" "$AMBIENTE" "$ANTERIOR" || true
  else
    echo "   Para volver atrás: bash infra/azure/rollback.sh $AMBIENTE $ANTERIOR" >&2
  fi
  exit 1
}

echo "-> Esperando que responda sana…"
bash "$AQUI/../../scripts/esperar-salud.sh" "$URL" 40 10 || volver

echo "-> Prueba de humo…"
curl -sf --max-time 20 "$URL/" | grep -qi "<app-root" || { echo "La interfaz no carga en $URL" >&2; volver; }
VERSION_API="$(curl -sf --max-time 20 "$URL/openapi.json" |
  python3 -c 'import sys, json; print(json.load(sys.stdin)["info"]["version"])' 2>/dev/null || echo "?")"
echo "   interfaz OK; versión de la API: $VERSION_API"

echo "url=$URL" >> "${GITHUB_OUTPUT:-/dev/null}"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Desplegado en $AMBIENTE"
    echo "- Imagen: \`$IMAGEN\` (API $VERSION_API)"
    echo "- URL: $URL"
    echo "- Revisión anterior (para rollback): \`$ANTERIOR\`"
  } >> "$GITHUB_STEP_SUMMARY"
fi
echo "Listo: $URL ($IMAGEN). Revisión anterior: $ANTERIOR"
