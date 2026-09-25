#!/usr/bin/env bash
# Crea un ambiente de Hajime en Azure: base de datos (Azure SQL serverless) y
# la app (Azure Container Apps). Pensado para correr en Azure Cloud Shell
# (portal.azure.com → ícono >_ → Bash), sin instalar nada.
#
#   bash crear-ambiente.sh test        # ambiente de pruebas (base gratis, se apaga sola)
#   bash crear-ambiente.sh prod        # producción (siempre encendida)
#
# Al final imprime la dirección de la app y los dos registros DNS para Cloudflare.
set -euo pipefail

AMBIENTE="${1:-test}"
case "$AMBIENTE" in test | prod) ;; *) echo "Uso: bash crear-ambiente.sh test|prod" && exit 1 ;; esac

REGION="${REGION:-eastus2}"                       # región de Azure (cambiable con REGION=...)
RG="hajime-$AMBIENTE"                             # grupo de recursos: todo lo de este ambiente
APP="hajime-$AMBIENTE"                            # la app (Container App)
ENTORNO="hajime-$AMBIENTE-env"                    # entorno de Container Apps
SUFIJO="$(az account show --query id -o tsv | tr -d '-' | cut -c1-6)"
SQL_SERVER="hajime-$AMBIENTE-sql-$SUFIJO"         # nombre único en todo Azure
SQL_DB="hajime"
SQL_USER="hajimeadmin"
# Imagen con el driver de SQL Server. Mientras la rama de desarrollo no se une a
# main, se usa la de esa rama; luego será ghcr.io/lorboftherin/hajime-kumite-app:azure
IMAGEN="${IMAGEN:-ghcr.io/lorboftherin/hajime-kumite-app:claude-gracious-feynman-qtapgx-azure}"

echo "== Hajime en Azure: ambiente '$AMBIENTE' en $REGION =="

# Datos que no deben quedar en el código: se piden aquí y viajan como secretos.
read -r -s -p "Clave para el usuario admin de Hajime (mín. 8 caracteres): " ADMIN_PASS; echo
echo "Si la imagen en GitHub es privada, hace falta un token con permiso read:packages."
read -r -p "Usuario de GitHub (Enter si la imagen es pública): " GH_USER
GH_TOKEN=""
if [ -n "$GH_USER" ]; then read -r -s -p "Token de GitHub (read:packages): " GH_TOKEN; echo; fi

SQL_PASS="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)Aa1!"
JWT_SECRET="$(openssl rand -hex 32)"

echo "-> Registrando proveedores (solo la primera vez tarda)…"
az provider register --namespace Microsoft.App --wait
az provider register --namespace Microsoft.OperationalInsights --wait
az provider register --namespace Microsoft.Sql --wait
az extension add --name containerapp --upgrade --only-show-errors

echo "-> Grupo de recursos $RG…"
az group create -n "$RG" -l "$REGION" -o none

echo "-> Servidor y base de datos Azure SQL…"
az sql server create -g "$RG" -n "$SQL_SERVER" -l "$REGION" \
  --admin-user "$SQL_USER" --admin-password "$SQL_PASS" --minimal-tls-version 1.2 -o none
# Permite conexiones desde servicios de Azure (la app). Nada más entra.
az sql server firewall-rule create -g "$RG" -s "$SQL_SERVER" -n PermitirAzure \
  --start-ip-address 0.0.0.0 --end-ip-address 0.0.0.0 -o none
if [ "$AMBIENTE" = "test" ]; then
  # Oferta gratuita permanente; si se agota en el mes, la base se pausa (no cobra).
  az sql db create -g "$RG" -s "$SQL_SERVER" -n "$SQL_DB" -e GeneralPurpose -f Gen5 -c 2 \
    --compute-model Serverless --use-free-limit --free-limit-exhaustion-behavior AutoPause \
    --backup-storage-redundancy Local -o none
else
  # Producción: oferta gratuita, pero si se agota sigue en línea y cobra el excedente.
  az sql db create -g "$RG" -s "$SQL_SERVER" -n "$SQL_DB" -e GeneralPurpose -f Gen5 -c 2 \
    --compute-model Serverless --use-free-limit --free-limit-exhaustion-behavior BillOverUsage -o none
fi
DB_URL="mssql+pyodbc://$SQL_USER:$SQL_PASS@$SQL_SERVER.database.windows.net:1433/$SQL_DB?driver=ODBC+Driver+18+for+SQL+Server&Encrypt=yes&TrustServerCertificate=no"

echo "-> Entorno de Container Apps…"
az containerapp env create -g "$RG" -n "$ENTORNO" -l "$REGION" -o none

if [ "$AMBIENTE" = "test" ]; then MIN=0; else MIN=1; fi   # test se apaga sin uso; prod siempre encendida

echo "-> App $APP (imagen $IMAGEN)…"
REGISTRO=()
if [ -n "$GH_USER" ]; then REGISTRO=(--registry-server ghcr.io --registry-username "$GH_USER" --registry-password "$GH_TOKEN"); fi
az containerapp create -g "$RG" -n "$APP" --environment "$ENTORNO" \
  --image "$IMAGEN" "${REGISTRO[@]}" \
  --target-port 8000 --ingress external --cpu 0.5 --memory 1.0Gi \
  --min-replicas "$MIN" --max-replicas 3 \
  --secrets "db-url=$DB_URL" "jwt-secret=$JWT_SECRET" "admin-pass=$ADMIN_PASS" \
  --env-vars "HAJIME_ENVIRONMENT=$AMBIENTE" "HAJIME_AUTO_CREATE_SCHEMA=true" \
    "HAJIME_DATABASE_URL=secretref:db-url" "HAJIME_JWT_SECRET=secretref:jwt-secret" \
    "HAJIME_ADMIN_PASSWORD=secretref:admin-pass" -o none

FQDN="$(az containerapp show -g "$RG" -n "$APP" --query properties.configuration.ingress.fqdn -o tsv)"
VERIF="$(az containerapp show -g "$RG" -n "$APP" --query properties.customDomainVerificationId -o tsv)"

cat <<FIN

================================================================
 Listo. La app ya responde en:  https://$FQDN
 (la primera visita puede tardar ~1 minuto: se despiertan la app y la base)
 Entra con el usuario 'admin' y la clave que escribiste.

 Registros DNS para Cloudflare (DNS → Registros → Agregar registro):

   Tipo: CNAME   Nombre: hajime          Destino:   $FQDN
                 Proxy: DESACTIVADO (nube gris, «Solo DNS»)
   Tipo: TXT     Nombre: asuid.hajime    Contenido: $VERIF

 Luego conecta el dominio con:
   bash conectar-dominio.sh $AMBIENTE hajime.lorboftherin.com
================================================================
FIN
