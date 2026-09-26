#!/usr/bin/env bash
# Crea una identidad de Azure para que un asistente (Claude Code en la nube)
# pueda correr comandos `az` sobre los ambientes de Hajime: actualizar la app,
# ver logs, escalar. Es una identidad de aplicación con permiso de Colaborador
# SOLO sobre los grupos de recursos hajime-test y hajime-prod (si existe).
#
#   bash conectar-claude.sh
#
# Imprime las variables para pegar en el entorno de Claude (Environment
# variables). El secreto se muestra una sola vez y vale 6 meses; para renovarlo,
# vuelve a correr el script. Para revocarlo: az ad app delete --id <AZURE_CLIENT_ID>
set -euo pipefail
NOMBRE="hajime-claude-code"
SUB="$(az account show --query id -o tsv)"
TENANT="$(az account show --query tenantId -o tsv)"

APP_ID="$(az ad app list --display-name "$NOMBRE" --query "[0].appId" -o tsv)"
if [ -z "$APP_ID" ]; then
  echo "-> Creando la identidad $NOMBRE…"
  APP_ID="$(az ad app create --display-name "$NOMBRE" --query appId -o tsv)"
  az ad sp create --id "$APP_ID" -o none
  sleep 15  # la identidad tarda unos segundos en propagarse
else
  echo "-> La identidad $NOMBRE ya existía: se renueva su secreto"
fi

for RG in hajime-test hajime-prod; do
  if az group show -n "$RG" -o none 2>/dev/null; then
    az role assignment create --assignee "$APP_ID" --role Contributor \
      --scope "/subscriptions/$SUB/resourceGroups/$RG" -o none 2>/dev/null || true
    echo "   permiso de Colaborador sobre $RG"
  fi
done

SECRET="$(az ad app credential reset --id "$APP_ID" --append --years 0.5 --display-name "claude-$(date +%Y%m)" --query password -o tsv)"

cat <<FIN

================================================================
 Copia estas líneas en claude.ai/code → botón de la nube (nombre del
 entorno) → engranaje del entorno → Environment variables:

AZURE_CLIENT_ID=$APP_ID
AZURE_TENANT_ID=$TENANT
AZURE_SUBSCRIPTION_ID=$SUB
AZURE_CLIENT_SECRET=$SECRET

 Y en Network access (Custom → Allowed domains) agrega:

login.microsoftonline.com
management.azure.com
*.azurecontainerapps.io
hajime.lorboftherin.com

 El secreto vence en 6 meses. Para revocarlo: az ad app delete --id $APP_ID
================================================================
FIN
