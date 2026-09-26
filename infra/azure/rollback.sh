#!/usr/bin/env bash
# Vuelve la app a una revisión anterior (misma imagen, variables y escala).
#
#   bash rollback.sh prod                   # lista las revisiones y vuelve a la anterior a la activa
#   bash rollback.sh prod hajime-prod--v0-2-0-101500   # vuelve a esa revisión
#
# La app está en modo de una sola revisión activa: se crea una revisión nueva
# copiada de la elegida (`az containerapp revision copy`) y el tráfico pasa a
# ella cuando queda lista. La base de datos NO se revierte: por eso las
# migraciones deben ser compatibles con la versión anterior (agregar antes de
# quitar). Si hiciera falta volver los datos: restaurar un punto en el tiempo
# (ver restaurar-prueba.sh y docs/despliegue-azure.md).
set -euo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=comun.sh
source "$AQUI/comun.sh"
nombres_ambiente "${1:?Uso: bash rollback.sh test|prod [revisión]}"
preparar_az

echo "== Revisiones de $APP (más reciente primero) =="
az containerapp revision list -g "$RG" -n "$APP" --all \
  --query "reverse(sort_by(@, &properties.createdTime))[:10].{revision:name, creada:properties.createdTime, activa:properties.active, trafico:properties.trafficWeight, salud:properties.healthState, imagen:properties.template.containers[0].image}" \
  -o table

ACTIVA="$(revision_activa)"
DESTINO="${2:-}"
if [ -z "$DESTINO" ]; then
  # La más reciente creada antes de la activa que no haya quedado enferma.
  DESTINO="$(az containerapp revision list -g "$RG" -n "$APP" --all -o json | ACTIVA="$ACTIVA" python3 -c '
import json, os, sys
revs = sorted(json.load(sys.stdin), key=lambda r: r["properties"]["createdTime"], reverse=True)
nombres = [r["name"] for r in revs]
activa = os.environ["ACTIVA"]
desde = nombres.index(activa) + 1 if activa in nombres else 0
for r in revs[desde:]:
    if r["name"] != activa and r["properties"].get("healthState") != "Unhealthy":
        print(r["name"])
        break
')"
fi
[ -n "$DESTINO" ] || { echo "No hay una revisión anterior a $ACTIVA" >&2; exit 1; }
IMAGEN="$(az containerapp revision show -g "$RG" -n "$APP" --revision "$DESTINO" \
  --query "properties.template.containers[0].image" -o tsv)"
echo "-> Activa: $ACTIVA"
echo "-> Volver a: $DESTINO ($IMAGEN)"
if [ -t 0 ] && [ -z "${SIN_CONFIRMAR:-}" ]; then
  read -r -p "¿Confirmas? (s/N) " R
  [ "$R" = "s" ] || [ "$R" = "S" ] || { echo "Cancelado"; exit 1; }
fi

az containerapp revision copy -g "$RG" -n "$APP" --from-revision "$DESTINO" \
  --revision-suffix "rb-$(date -u +%m%d%H%M%S)" -o none
bash "$AQUI/../../scripts/esperar-salud.sh" "https://$(fqdn_app)" 40 10
echo "Listo: $APP volvió a $IMAGEN (copia de $DESTINO)"
