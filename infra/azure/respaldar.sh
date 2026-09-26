#!/usr/bin/env bash
# Exporta la base de un ambiente a un archivo .bacpac en una cuenta de
# almacenamiento propia (la crea si falta) y lista los últimos respaldos.
# Complementa los respaldos automáticos de Azure SQL (punto en el tiempo y
# semanales): el .bacpac es una copia independiente que se puede descargar.
#
#   bash respaldar.sh prod              # exporta y lista
#   bash respaldar.sh prod --listar     # solo lista
#
# Úsalo antes de cada torneo real (checklist en docs/despliegue.md).
# Variables: RETENCION_DIAS=180 (los .bacpac más viejos se borran solos).
set -euo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=comun.sh
source "$AQUI/comun.sh"
nombres_ambiente "${1:?Uso: bash respaldar.sh test|prod [--listar]}"
RETENCION_DIAS="${RETENCION_DIAS:-180}"
SUFIJO="$(az account show --query id -o tsv | tr -d '-' | cut -c1-6)"
CUENTA="hajime${AMBIENTE}bk$SUFIJO" # 3–24 minúsculas y números, única en Azure
CONTENEDOR="respaldos"
preparar_az

SERVIDOR="$(servidor_sql)"
[ -n "$SERVIDOR" ] || { echo "No hay servidor SQL en $RG" >&2; exit 1; }
REGION="$(az sql server show -g "$RG" -n "$SERVIDOR" --query location -o tsv)"

echo "-> Cuenta de almacenamiento $CUENTA…"
if ! az storage account show -g "$RG" -n "$CUENTA" -o none 2>/dev/null; then
  az storage account create -g "$RG" -n "$CUENTA" -l "$REGION" --sku Standard_LRS --kind StorageV2 \
    --min-tls-version TLS1_2 --allow-blob-public-access false --https-only true -o none
  # Borrado automático de los .bacpac viejos.
  cat >"/tmp/politica-$$.json" <<JSON
{"rules": [{"enabled": true, "name": "borrar-viejos", "type": "Lifecycle",
  "definition": {"filters": {"blobTypes": ["blockBlob"], "prefixMatch": ["$CONTENEDOR/"]},
    "actions": {"baseBlob": {"delete": {"daysAfterModificationGreaterThan": $RETENCION_DIAS}}}}}]}
JSON
  az storage account management-policy create -g "$RG" --account-name "$CUENTA" --policy "@/tmp/politica-$$.json" -o none
  rm -f "/tmp/politica-$$.json"
fi
LLAVE="$(az storage account keys list -g "$RG" -n "$CUENTA" --query "[0].value" -o tsv)"
az storage container create --account-name "$CUENTA" --account-key "$LLAVE" -n "$CONTENEDOR" -o none

if [ "${2:-}" != "--listar" ]; then
  ARCHIVO="hajime-$AMBIENTE-$(date -u +%Y%m%d-%H%M).bacpac"
  clave_admin_sql "$SERVIDOR"
  # El servicio de exportación de Azure entra por la regla «servicios de Azure».
  REGLA_TEMPORAL=""
  if ! az sql server firewall-rule show -g "$RG" -s "$SERVIDOR" -n PermitirAzure -o none 2>/dev/null; then
    az sql server firewall-rule create -g "$RG" -s "$SERVIDOR" -n PermitirAzure \
      --start-ip-address 0.0.0.0 --end-ip-address 0.0.0.0 -o none
    REGLA_TEMPORAL=1
  fi
  echo "-> Exportando $SQL_DB a $ARCHIVO (tarda unos minutos)…"
  INICIO=$SECONDS
  RC=0
  az sql db export -g "$RG" -s "$SERVIDOR" -n "$SQL_DB" \
    --admin-user "$SQL_ADMIN_USUARIO" --admin-password "$SQL_ADMIN_CLAVE" \
    --storage-key-type StorageAccessKey --storage-key "$LLAVE" \
    --storage-uri "https://$CUENTA.blob.core.windows.net/$CONTENEDOR/$ARCHIVO" -o none || RC=$?
  if [ -n "$REGLA_TEMPORAL" ]; then
    az sql server firewall-rule delete -g "$RG" -s "$SERVIDOR" -n PermitirAzure -o none || true
  fi
  [ "$RC" -eq 0 ] || { echo "La exportación falló" >&2; exit "$RC"; }
  echo "   listo en $((SECONDS - INICIO)) s"
fi

echo
echo "== Últimos respaldos en $CUENTA/$CONTENEDOR (se borran a los $RETENCION_DIAS días) =="
az storage blob list --account-name "$CUENTA" --account-key "$LLAVE" -c "$CONTENEDOR" \
  --query "reverse(sort_by(@, &properties.lastModified))[:10].{archivo:name, fecha:properties.lastModified, bytes:properties.contentLength}" \
  -o table
echo
echo "Descargar uno: az storage blob download --account-name $CUENTA -c $CONTENEDOR -n <archivo> -f <archivo> --account-key \"\$(az storage account keys list -g $RG -n $CUENTA --query '[0].value' -o tsv)\""
echo "Restaurar un .bacpac en una base nueva: az sql db import (ver docs/despliegue-azure.md → Respaldos)."
