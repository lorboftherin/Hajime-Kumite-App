#!/usr/bin/env bash
# Permite que GitHub Actions publique cada cambio en Azure SIN guardar claves:
# crea una identidad con credencial federada (OIDC) limitada al grupo de recursos.
#
#   bash conectar-github.sh test claude/gracious-feynman-qtapgx
#
# Al final imprime 3 valores para GitHub → Settings → Secrets and variables →
# Actions → Variables (no son secretos).
set -euo pipefail
AMBIENTE="${1:?Uso: bash conectar-github.sh test|prod rama}"
RAMA="${2:-main}"
REPO="lorboftherin/Hajime-Kumite-App"
RG="hajime-$AMBIENTE"
NOMBRE="hajime-github-$AMBIENTE"

SUB="$(az account show --query id -o tsv)"
TENANT="$(az account show --query tenantId -o tsv)"
APP_ID="$(az ad app create --display-name "$NOMBRE" --query appId -o tsv)"
az ad sp create --id "$APP_ID" -o none 2>/dev/null || true
# Solo puede tocar el grupo de recursos de este ambiente.
az role assignment create --assignee "$APP_ID" --role Contributor \
  --scope "/subscriptions/$SUB/resourceGroups/$RG" -o none
az ad app federated-credential create --id "$APP_ID" --parameters "{
  \"name\": \"github-$AMBIENTE\",
  \"issuer\": \"https://token.actions.githubusercontent.com\",
  \"subject\": \"repo:$REPO:ref:refs/heads/$RAMA\",
  \"audiences\": [\"api://AzureADTokenExchange\"]
}" -o none

cat <<FIN

En GitHub: Settings → Secrets and variables → Actions → pestaña «Variables» → New:
  AZURE_CLIENT_ID        = $APP_ID
  AZURE_TENANT_ID        = $TENANT
  AZURE_SUBSCRIPTION_ID  = $SUB
  AZURE_TEST_BRANCH      = $RAMA
Desde el próximo cambio en la rama '$RAMA', CI publicará la app en '$AMBIENTE' sola.
FIN
