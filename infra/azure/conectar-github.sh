#!/usr/bin/env bash
# Permite que GitHub Actions despliegue en Azure SIN guardar claves: crea (o
# reutiliza) una identidad con credencial federada (OIDC) limitada al grupo de
# recursos del ambiente. Se puede repetir: no duplica nada.
#
#   bash conectar-github.sh test main    # CI despliega en pruebas cada push a esa rama
#   bash conectar-github.sh prod         # deploy-prod.yml, solo desde el entorno «prod» de GitHub
#
# Pruebas: la credencial vale para los push a la rama indicada (job deploy-test).
# Producción: vale solo para jobs del entorno «prod» de GitHub, que exige
# aprobación manual. Cada ambiente tiene su propia identidad.
#
# Al final imprime las variables para GitHub (no son secretos).
set -euo pipefail
AMBIENTE="${1:?Uso: bash conectar-github.sh test [rama] | prod}"
case "$AMBIENTE" in test | prod) ;; *) echo "Ambiente inválido: $AMBIENTE" >&2 && exit 1 ;; esac
RAMA="${2:-main}"
REPO="${REPO:-lorboftherin/Hajime-Kumite-App}"
RG="hajime-$AMBIENTE"
NOMBRE="hajime-github-$AMBIENTE"
if [ "$AMBIENTE" = "prod" ]; then
  SUJETO="repo:$REPO:environment:prod"
else
  SUJETO="repo:$REPO:ref:refs/heads/$RAMA"
fi

SUB="$(az account show --query id -o tsv)"
TENANT="$(az account show --query tenantId -o tsv)"
[ "$(az group exists -n "$RG")" = "true" ] || { echo "Primero crea el ambiente: bash crear-ambiente.sh $AMBIENTE" >&2; exit 1; }

echo "-> Registro de aplicación $NOMBRE…"
APP_ID="$(az ad app list --display-name "$NOMBRE" --query "[0].appId" -o tsv)"
if [ -z "$APP_ID" ]; then
  APP_ID="$(az ad app create --display-name "$NOMBRE" --query appId -o tsv)"
  echo "   creado: $APP_ID"
else
  echo "   ya existía: $APP_ID"
fi
if ! az ad sp show --id "$APP_ID" -o none 2>/dev/null; then
  az ad sp create --id "$APP_ID" -o none
  sleep 20 # la identidad tarda en propagarse antes de poder asignarle un rol
fi

echo "-> Permiso Contributor solo sobre el grupo $RG…"
ALCANCE="/subscriptions/$SUB/resourceGroups/$RG"
if [ -z "$(az role assignment list --assignee "$APP_ID" --scope "$ALCANCE" --role Contributor --query "[0].id" -o tsv)" ]; then
  az role assignment create --assignee "$APP_ID" --role Contributor --scope "$ALCANCE" -o none
fi

echo "-> Credencial federada ($SUJETO)…"
PARAMS="{
  \"name\": \"github-$AMBIENTE\",
  \"issuer\": \"https://token.actions.githubusercontent.com\",
  \"subject\": \"$SUJETO\",
  \"audiences\": [\"api://AzureADTokenExchange\"]
}"
ACTUAL="$(az ad app federated-credential list --id "$APP_ID" --query "[?name=='github-$AMBIENTE'] | [0].subject" -o tsv)"
if [ -z "$ACTUAL" ]; then
  az ad app federated-credential create --id "$APP_ID" --parameters "$PARAMS" -o none
elif [ "$ACTUAL" != "$SUJETO" ]; then
  az ad app federated-credential update --id "$APP_ID" --federated-credential-id "github-$AMBIENTE" --parameters "$PARAMS" -o none
  echo "   actualizada (antes: $ACTUAL)"
else
  echo "   ya estaba"
fi

echo
if [ "$AMBIENTE" = "prod" ]; then
  cat <<FIN
En GitHub: Settings → Environments → prod (créalo si no existe) →
  «Required reviewers»: tú (aprobación manual antes de cada despliegue)
  «Deployment branches and tags»: Selected → main y v*
  «Environment variables» → Add variable:
    AZURE_CLIENT_ID        = $APP_ID
    AZURE_TENANT_ID        = $TENANT
    AZURE_SUBSCRIPTION_ID  = $SUB
Luego: Actions → «Desplegar a producción» → Run workflow (SHA o versión).
FIN
else
  cat <<FIN
En GitHub: Settings → Secrets and variables → Actions → pestaña «Variables» → New:
  AZURE_CLIENT_ID        = $APP_ID
  AZURE_TENANT_ID        = $TENANT
  AZURE_SUBSCRIPTION_ID  = $SUB
  AZURE_TEST_BRANCH      = $RAMA
Desde el próximo cambio en la rama '$RAMA', CI publicará la app en '$AMBIENTE' sola.
FIN
fi
