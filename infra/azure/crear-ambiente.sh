#!/usr/bin/env bash
# Crea o actualiza un ambiente de Hajime en Azure: base de datos (Azure SQL),
# job de migraciones y la app (Azure Container Apps). Pensado para correr en
# Azure Cloud Shell (portal.azure.com → ícono >_ → Bash), sin instalar nada.
#
#   bash crear-ambiente.sh test                     # pruebas (base gratis, se apaga sola)
#   bash crear-ambiente.sh prod                     # producción (siempre encendida)
#   bash crear-ambiente.sh prod --rotar-secretos    # además cambia la clave de la base y la de sesiones
#
# Se puede repetir sin miedo (idempotente): si la app ya existe se ACTUALIZA
# (conserva su dominio, su certificado, su imagen y sus secretos); solo crea lo
# que falta. Pasos:
#   1. servidor y base Azure SQL; usuario propio de la app con permisos mínimos
#      (db_datareader, db_datawriter, db_ddladmin), no el administrador;
#   2. entorno de Container Apps y job de migraciones hajime-<amb>-migrar;
#   3. corre las migraciones y crea o actualiza la app (sondas de salud,
#      HAJIME_AUTO_CREATE_SCHEMA=false);
#   4. tras el primer arranque sano, borra la clave inicial del admin de la app.
#
# Variables opcionales (se ponen antes del comando: SQL_SKU=S1 bash crear-ambiente.sh prod):
#   REGIONES="brazilsouth …"   regiones a probar para la base, en orden
#   IMAGEN=ghcr.io/…:azure     imagen inicial (solo si la app aún no existe)
#   SQL_SKU=S0                 prod: S0 (por defecto), S1, S2, Basic o serverless (sin autopausa)
#   SQL_FIREWALL=azure         azure: permite servicios de Azure (por defecto)
#                              salida: solo las IP de salida de la app (más estricto; ver docs)
#   COMANDO_MIGRACION="…"      comando del job (por defecto: python -m app.prepare si existe)
#   APP_INSIGHTS=1             crea Application Insights y pasa APPLICATIONINSIGHTS_CONNECTION_STRING
#   PRESUPUESTO_USD=30 PRESUPUESTO_CORREO=yo@…   alerta de gasto mensual del grupo de recursos
#   GH_USER=… GH_TOKEN=…       credenciales de GHCR si la imagen es privada (si no, se preguntan)
set -euo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=comun.sh
source "$AQUI/comun.sh"

USO="Uso: bash crear-ambiente.sh test|prod [--rotar-secretos]"
nombres_ambiente "${1:-test}"
ROTAR=""
for OPCION in "${@:2}"; do
  case "$OPCION" in --rotar-secretos) ROTAR=1 ;; *) echo "$USO" && exit 1 ;; esac
done

# Azure a veces no acepta bases nuevas en una región por falta de capacidad
# (RegionDoesNotAllowProvisioning). Brasil Sur es la más cercana a Perú.
REGIONES="${REGIONES:-brazilsouth southcentralus centralus eastus westus2 eastus2 canadacentral}"
SUB="$(az account show --query id -o tsv)"
SUFIJO="$(echo "$SUB" | tr -d '-' | cut -c1-6)"
SQL_ADMIN="hajimeadmin"  # administrador del servidor: solo lo usa este script
SQL_APP_USER="hajime_app" # usuario contenido en la base: el que usa la app
SQL_FIREWALL="${SQL_FIREWALL:-azure}"
COMANDO_MIGRACION="${COMANDO_MIGRACION:-$COMANDO_MIGRACION_POR_DEFECTO}"
SQL_SKU_PEDIDO="${SQL_SKU:-}"
SQL_SKU="${SQL_SKU:-S0}"
if [ "$AMBIENTE" = "test" ]; then MIN=0; else MIN=1; fi # test se apaga sin uso; prod siempre encendida

TMP="$(mktemp -d)"
chmod 700 "$TMP"
IP_TEMPORAL=""
limpiar() {
  if [ -n "$IP_TEMPORAL" ]; then
    az sql server firewall-rule delete -g "$RG" -s "$SQL_SERVER" -n CloudShellTemporal -o none 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap limpiar EXIT
clave() { echo "$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | cut -c1-28)Aa1"; }

echo "== Hajime en Azure: ambiente '$AMBIENTE' =="
[ -n "$ROTAR" ] && echo "   (--rotar-secretos: nueva clave de la base y de sesiones; todos deberán volver a entrar)"

echo "-> Registrando proveedores (solo la primera vez tarda)…"
for P in Microsoft.App Microsoft.OperationalInsights Microsoft.Sql; do
  az provider register --namespace "$P" --wait
done
preparar_az

echo "-> Grupo de recursos $RG…"
if [ "$(az group exists -n "$RG")" = "false" ]; then
  az group create -n "$RG" -l "${REGIONES%% *}" -o none
fi

APP_EXISTE=""
if existe_app; then APP_EXISTE=1; fi

# ---------------------------------------------------------------- secretos ---
# Se leen de la app existente; solo se generan si faltan (o con --rotar-secretos).
JWT_SECRET="$(secreto_app jwt-secret)"
DB_URL_ACTUAL="$(secreto_app db-url)"
ADMIN_PASS="$(secreto_app admin-pass)"
if [ -z "$JWT_SECRET" ] || [ -n "$ROTAR" ]; then JWT_SECRET="$(openssl rand -hex 32)"; fi
if [ -z "$APP_EXISTE" ]; then
  while :; do
    read -r -s -p "Clave inicial para el usuario admin de Hajime (mín. 8 caracteres): " ADMIN_PASS
    echo
    [ "${#ADMIN_PASS}" -ge 8 ] && break
    echo "Muy corta."
  done
fi

# Credenciales de GHCR (imagen privada). Si la app ya las tiene, se reutilizan.
GH_USER="${GH_USER:-}"
GH_TOKEN="${GH_TOKEN:-}"
if [ -z "$GH_USER" ] && [ -t 0 ]; then
  echo "Si la imagen en GitHub es privada, hace falta un token con SOLO read:packages."
  read -r -p "Usuario de GitHub (Enter: imagen pública o mantener el actual): " GH_USER
  if [ -n "$GH_USER" ]; then read -r -s -p "Token de GitHub (read:packages): " GH_TOKEN && echo; fi
fi
if [ -z "$GH_USER" ] && [ -n "$APP_EXISTE" ]; then
  REG="$(az containerapp registry list -g "$RG" -n "$APP" --query "[?server=='ghcr.io'] | [0].[username, passwordSecretRef]" -o tsv 2>/dev/null || true)"
  if [ -n "$REG" ]; then
    GH_USER="$(echo "$REG" | cut -f1)"
    GH_TOKEN="$(secreto_app "$(echo "$REG" | cut -f2)")"
  fi
fi

# ------------------------------------------------------------- Azure SQL ---
echo "-> Servidor Azure SQL…"
REGION=""
SQL_SERVER=""
SQL_ADMIN_PASS="$(clave)"
EXISTE="$(az sql server list -g "$RG" --query "[?state=='Ready'] | [0].[name, location]" -o tsv 2>/dev/null || true)"
if [ -n "$EXISTE" ]; then
  SQL_SERVER="$(echo "$EXISTE" | cut -f1)"
  REGION="$(echo "$EXISTE" | cut -f2)"
  echo "   ya existía: $SQL_SERVER ($REGION)"
  SERVIDOR_NUEVO=""
else
  for R in $REGIONES; do
    NOMBRE="hajime-$AMBIENTE-sql-$SUFIJO-$R"
    echo "   · $R…"
    if az sql server create -g "$RG" -n "$NOMBRE" -l "$R" --admin-user "$SQL_ADMIN" \
      --admin-password "$SQL_ADMIN_PASS" --minimal-tls-version 1.2 -o none 2>"$TMP/sql-err.txt"; then
      REGION="$R"
      SQL_SERVER="$NOMBRE"
      break
    fi
    grep -q "RegionDoesNotAllowProvisioning\|not accepting creation\|InvalidResourceLocation" "$TMP/sql-err.txt" \
      || { cat "$TMP/sql-err.txt"; exit 1; }
    echo "     no disponible ahora; pruebo la siguiente"
  done
  SERVIDOR_NUEVO=1
fi
[ -n "$REGION" ] || { echo "Ninguna región aceptó la base. Prueba más tarde o con REGIONES=\"...\"."; exit 1; }
HOST_SQL="$SQL_SERVER.database.windows.net"

if [ "$SQL_FIREWALL" = "azure" ] || [ -z "$APP_EXISTE" ]; then
  # Conexiones desde servicios de Azure (incluye la app). Con SQL_FIREWALL=salida
  # se reemplaza al final por las IP de salida de la app.
  az sql server firewall-rule create -g "$RG" -s "$SQL_SERVER" -n PermitirAzure \
    --start-ip-address 0.0.0.0 --end-ip-address 0.0.0.0 -o none
fi

echo "-> Base de datos…"
if az sql db show -g "$RG" -s "$SQL_SERVER" -n "$SQL_DB" -o none 2>/dev/null; then
  ACTUAL="$(az sql db show -g "$RG" -s "$SQL_SERVER" -n "$SQL_DB" --query "[currentServiceObjectiveName, autoPauseDelay]" -o tsv)"
  echo "   ya existía: $(echo "$ACTUAL" | cut -f1)"
  if [ "$AMBIENTE" = "prod" ]; then
    if [ "$(echo "$ACTUAL" | cut -f2)" != "-1" ] && echo "$ACTUAL" | grep -q "GP_S"; then
      echo "   producción no debe pausarse: se desactiva la autopausa"
      az sql db update -g "$RG" -s "$SQL_SERVER" -n "$SQL_DB" --auto-pause-delay -1 -o none \
        || echo "   Aviso: no se pudo desactivar la autopausa; hazlo en el portal (Proceso y almacenamiento)."
    fi
    if [ -n "$SQL_SKU_PEDIDO" ] && [ "$SQL_SKU_PEDIDO" != "$(echo "$ACTUAL" | cut -f1)" ] && [ "$SQL_SKU_PEDIDO" != "serverless" ]; then
      echo "   Para pasar a $SQL_SKU_PEDIDO (cambio de costo; se hace a mano a propósito):"
      echo "     az sql db update -g $RG -s $SQL_SERVER -n $SQL_DB --service-objective $SQL_SKU_PEDIDO"
    fi
  fi
elif [ "$AMBIENTE" = "test" ]; then
  # Oferta gratuita permanente; si se agota en el mes, la base se pausa (no cobra).
  az sql db create -g "$RG" -s "$SQL_SERVER" -n "$SQL_DB" -e GeneralPurpose -f Gen5 -c 2 \
    --compute-model Serverless --use-free-limit --free-limit-exhaustion-behavior AutoPause \
    --backup-storage-redundancy Local -o none
elif [ "$SQL_SKU" = "serverless" ]; then
  # Producción serverless: nunca se pausa (la primera petición no espera a que despierte).
  az sql db create -g "$RG" -s "$SQL_SERVER" -n "$SQL_DB" -e GeneralPurpose -f Gen5 -c 2 \
    --compute-model Serverless --auto-pause-delay -1 --min-capacity 0.5 -o none
else
  # Producción: DTU fijo (S0 ≈ 15 USD/mes), siempre en línea y con costo predecible.
  az sql db create -g "$RG" -s "$SQL_SERVER" -n "$SQL_DB" --service-objective "$SQL_SKU" -o none
fi

if [ "$AMBIENTE" = "prod" ]; then
  echo "-> Respaldos de producción: 14 días a cualquier punto + semanales 8 semanas + mensuales 12 meses…"
  az sql db str-policy set -g "$RG" -s "$SQL_SERVER" -n "$SQL_DB" --retention-days 14 --diffbackup-hours 12 -o none \
    || echo "   Aviso: no se pudo ajustar la retención corta (Basic admite 7 días)."
  az sql db ltr-policy set -g "$RG" -s "$SQL_SERVER" -n "$SQL_DB" \
    --weekly-retention P8W --monthly-retention P12M -o none \
    || echo "   Aviso: no se pudo configurar la retención larga (LTR); revisa el SKU en el portal."
fi

# Usuario propio de la app (contenido en la base) con permisos mínimos.
USUARIO_APP=""
if command -v sqlcmd >/dev/null 2>&1; then
  # La clave del administrador se renueva en cada corrida: solo la usa este
  # script y no se guarda en ningún lado.
  if [ -z "$SERVIDOR_NUEVO" ]; then
    az sql server update -g "$RG" -n "$SQL_SERVER" --admin-password "$SQL_ADMIN_PASS" -o none
  fi
  MI_IP="$(curl -s --max-time 10 https://api.ipify.org || true)"
  if [ -n "$MI_IP" ]; then
    az sql server firewall-rule create -g "$RG" -s "$SQL_SERVER" -n CloudShellTemporal \
      --start-ip-address "$MI_IP" --end-ip-address "$MI_IP" -o none && IP_TEMPORAL=1
  fi
  APP_PASS=""
  if [ -z "$ROTAR" ] && [ -n "$DB_URL_ACTUAL" ]; then
    APP_PASS="$(DB_URL="$DB_URL_ACTUAL" USUARIO="$SQL_APP_USER" python3 -c '
import os
from urllib.parse import unquote, urlsplit
u = urlsplit(os.environ["DB_URL"])
print(unquote(u.password or "") if u.username == os.environ["USUARIO"] else "")')"
  fi
  [ -n "$APP_PASS" ] || APP_PASS="$(clave)"
  echo "-> Usuario $SQL_APP_USER en la base (db_datareader, db_datawriter, db_ddladmin)…"
  cat >"$TMP/usuario.sql" <<SQL
SET NOCOUNT ON;
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'$SQL_APP_USER')
  CREATE USER [$SQL_APP_USER] WITH PASSWORD = N'$APP_PASS';
ELSE
  ALTER USER [$SQL_APP_USER] WITH PASSWORD = N'$APP_PASS';
ALTER ROLE db_datareader ADD MEMBER [$SQL_APP_USER];
ALTER ROLE db_datawriter ADD MEMBER [$SQL_APP_USER];
ALTER ROLE db_ddladmin ADD MEMBER [$SQL_APP_USER];
SQL
  for _ in $(seq 1 12); do # la base serverless puede estar despertando
    if SQLCMDPASSWORD="$SQL_ADMIN_PASS" sqlcmd -S "tcp:$HOST_SQL,1433" -d "$SQL_DB" -U "$SQL_ADMIN" \
      -b -l 60 -i "$TMP/usuario.sql"; then
      USUARIO_APP=1
      break
    fi
    echo "   reintento en 15 s…"
    sleep 15
  done
  [ -n "$USUARIO_APP" ] || { echo "No se pudo crear el usuario $SQL_APP_USER con sqlcmd" >&2; exit 1; }
  DB_URL="mssql+pyodbc://$SQL_APP_USER:$APP_PASS@$HOST_SQL:1433/$SQL_DB?driver=ODBC+Driver+18+for+SQL+Server&Encrypt=yes&TrustServerCertificate=no"
elif [ -n "$DB_URL_ACTUAL" ] && [ -z "$ROTAR" ]; then
  echo "   Aviso: no hay sqlcmd; se mantiene la conexión actual de la app."
  DB_URL="$DB_URL_ACTUAL"
else
  echo "   Aviso: no hay sqlcmd (Cloud Shell lo trae). La app usará el administrador del servidor;"
  echo "   crea el usuario $SQL_APP_USER a mano (docs/despliegue-azure.md → «Usuario de la base»)."
  if [ -z "$SERVIDOR_NUEVO" ]; then
    az sql server update -g "$RG" -n "$SQL_SERVER" --admin-password "$SQL_ADMIN_PASS" -o none
  fi
  DB_URL="mssql+pyodbc://$SQL_ADMIN:$SQL_ADMIN_PASS@$HOST_SQL:1433/$SQL_DB?driver=ODBC+Driver+18+for+SQL+Server&Encrypt=yes&TrustServerCertificate=no"
fi

# ------------------------------------------------------- Container Apps ---
echo "-> Entorno de Container Apps en $REGION…"
if ! az containerapp env show -g "$RG" -n "$ENTORNO" -o none 2>/dev/null; then
  az containerapp env create -g "$RG" -n "$ENTORNO" -l "$REGION" -o none
fi
ENTORNO_ID="$(az containerapp env show -g "$RG" -n "$ENTORNO" --query id -o tsv)"
REGION_ENTORNO="$(az containerapp env show -g "$RG" -n "$ENTORNO" --query location -o tsv)"

AI_CS=""
if [ -n "${APP_INSIGHTS:-}" ]; then
  echo "-> Application Insights…"
  az extension add --name application-insights --upgrade --only-show-errors >/dev/null
  AI="hajime-$AMBIENTE-insights"
  if ! az monitor app-insights component show -g "$RG" --app "$AI" -o none 2>/dev/null; then
    WS="$(az monitor log-analytics workspace list -g "$RG" --query "[0].id" -o tsv)"
    az monitor app-insights component create -g "$RG" --app "$AI" -l "$REGION_ENTORNO" \
      --workspace "$WS" --application-type web --kind web -o none
  fi
  AI_CS="$(az monitor app-insights component show -g "$RG" --app "$AI" --query connectionString -o tsv)"
fi
[ -n "$AI_CS" ] || AI_CS="$(secreto_app appinsights)"

if [ -n "$APP_EXISTE" ]; then
  IMAGEN_APP="$(az containerapp show -g "$RG" -n "$APP" --query "properties.template.containers[0].image" -o tsv)"
  echo "   la app ya existe: se conserva su imagen ($IMAGEN_APP)"
else
  IMAGEN_APP="${IMAGEN:-$IMAGEN_BASE:azure}"
fi

# Definición completa del job (se crea o reemplaza con PUT): mismo contenedor
# que la app, sin ingreso, se ejecuta a pedido.
definir_job() {
  local con_admin="$1"
  JOB_NOMBRE="$JOB" IMAGEN_JOB="$IMAGEN_APP" REGION_JOB="$REGION_ENTORNO" ENTORNO_ID="$ENTORNO_ID" \
    AMBIENTE="$AMBIENTE" DB_URL="$DB_URL" JWT_SECRET="$JWT_SECRET" COMANDO="$COMANDO_MIGRACION" \
    ADMIN_PASS="$([ "$con_admin" = 1 ] && echo "$ADMIN_PASS" || true)" GH_USER="$GH_USER" GH_TOKEN="$GH_TOKEN" \
    python3 - >"$TMP/job.json" <<'PY'
import json, os
e = os.environ
secretos = [{"name": "db-url", "value": e["DB_URL"]}, {"name": "jwt-secret", "value": e["JWT_SECRET"]}]
env = [
    {"name": "HAJIME_ENVIRONMENT", "value": e["AMBIENTE"]},
    {"name": "HAJIME_DATABASE_URL", "secretRef": "db-url"},
    {"name": "HAJIME_JWT_SECRET", "secretRef": "jwt-secret"},
    # El job es el único que migra: app.prepare solo aplica migraciones en SQL Server
    # con esta variable. La app corre con false y nunca migra al arrancar.
    {"name": "HAJIME_AUTO_CREATE_SCHEMA", "value": "true"},
]
if e.get("ADMIN_PASS"):
    secretos.append({"name": "admin-pass", "value": e["ADMIN_PASS"]})
    env.append({"name": "HAJIME_ADMIN_PASSWORD", "secretRef": "admin-pass"})
config = {
    "triggerType": "Manual",
    "replicaTimeout": 1800,
    "replicaRetryLimit": 0,
    "manualTriggerConfig": {"parallelism": 1, "replicaCompletionCount": 1},
    "secrets": secretos,
}
if e.get("GH_USER") and e.get("GH_TOKEN"):
    secretos.append({"name": "ghcr-token", "value": e["GH_TOKEN"]})
    config["registries"] = [{"server": "ghcr.io", "username": e["GH_USER"], "passwordSecretRef": "ghcr-token"}]
print(json.dumps({
    "location": e["REGION_JOB"],
    "properties": {
        "environmentId": e["ENTORNO_ID"],
        "configuration": config,
        "template": {"containers": [{
            "name": e["JOB_NOMBRE"],
            "image": e["IMAGEN_JOB"],
            "command": ["/bin/sh", "-c", e["COMANDO"]],
            "env": env,
            "resources": {"cpu": 0.5, "memory": "1Gi"},
        }]},
    },
}))
PY
  az rest --method put -o none --body "@$TMP/job.json" \
    --url "https://management.azure.com/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.App/jobs/$JOB?api-version=$API_APPS"
  rm -f "$TMP/job.json"
}

echo "-> Job de migraciones $JOB…"
if [ -z "$APP_EXISTE" ]; then definir_job 1; else definir_job "$([ -n "$ADMIN_PASS" ] && echo 1 || echo 0)"; fi
correr_migraciones "$IMAGEN_APP"

echo "-> App $APP…"
SECRETOS=("db-url=$DB_URL" "jwt-secret=$JWT_SECRET")
[ -n "$ADMIN_PASS" ] && SECRETOS+=("admin-pass=$ADMIN_PASS")
[ -n "$AI_CS" ] && SECRETOS+=("appinsights=$AI_CS")
if [ -z "$APP_EXISTE" ]; then
  REGISTRO=()
  if [ -n "$GH_USER" ]; then REGISTRO=(--registry-server ghcr.io --registry-username "$GH_USER" --registry-password "$GH_TOKEN"); fi
  az containerapp create -g "$RG" -n "$APP" --environment "$ENTORNO" \
    --image "$IMAGEN_APP" "${REGISTRO[@]}" \
    --target-port 8000 --ingress external --cpu 0.5 --memory 1.0Gi \
    --min-replicas "$MIN" --max-replicas 3 \
    --secrets "${SECRETOS[@]}" \
    --env-vars "HAJIME_ENVIRONMENT=$AMBIENTE" "HAJIME_AUTO_CREATE_SCHEMA=false" \
    "HAJIME_DATABASE_URL=secretref:db-url" "HAJIME_JWT_SECRET=secretref:jwt-secret" \
    "HAJIME_ADMIN_PASSWORD=secretref:admin-pass" -o none
else
  az containerapp secret set -g "$RG" -n "$APP" --secrets "${SECRETOS[@]}" -o none
  if [ -n "$GH_USER" ] && [ -n "$GH_TOKEN" ]; then
    az containerapp registry set -g "$RG" -n "$APP" --server ghcr.io --username "$GH_USER" --password "$GH_TOKEN" -o none
  fi
fi

# Plantilla de la app (variables, sondas, escala), aplicada sobre la actual para
# conservar variables agregadas a mano. JSON Merge Patch: la configuración
# (dominio, certificado, secretos, registro) no se toca.
echo "-> Variables, sondas de salud (/health/live, /health/ready) y escala…"
az containerapp show -g "$RG" -n "$APP" -o json >"$TMP/app.json"
APP_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$TMP/app.json")"
CON_ADMIN="$([ -n "$ADMIN_PASS" ] && echo 1 || true)" CON_AI="$([ -n "$AI_CS" ] && echo 1 || true)" \
  AMBIENTE="$AMBIENTE" MIN="$MIN" SUFIJO_REV="cfg-$(date -u +%m%d%H%M%S)" \
  python3 - "$TMP/app.json" >"$TMP/parche.json" <<'PY'
import json, os, sys
e = os.environ
app = json.load(open(sys.argv[1]))
tpl = app["properties"]["template"]
c = tpl["containers"][0]
nuestras = {
    "HAJIME_ENVIRONMENT": {"value": e["AMBIENTE"]},
    "HAJIME_AUTO_CREATE_SCHEMA": {"value": "false"},
    "HAJIME_DATABASE_URL": {"secretRef": "db-url"},
    "HAJIME_JWT_SECRET": {"secretRef": "jwt-secret"},
}
if e.get("CON_ADMIN"):
    nuestras["HAJIME_ADMIN_PASSWORD"] = {"secretRef": "admin-pass"}
if e.get("CON_AI"):
    nuestras["APPLICATIONINSIGHTS_CONNECTION_STRING"] = {"secretRef": "appinsights"}
propias = set(nuestras) | {"HAJIME_ADMIN_PASSWORD", "APPLICATIONINSIGHTS_CONNECTION_STRING"}
env = [v for v in c.get("env") or [] if v["name"] not in propias]
env += [{"name": k, **v} for k, v in nuestras.items()]
sonda = lambda ruta, **kw: {"httpGet": {"path": ruta, "port": 8000, "scheme": "HTTP"}, **kw}
c.update(
    env=env,
    resources={"cpu": 0.5, "memory": "1Gi"},
    probes=[
        # Arranque: hasta 5 minutos (la base serverless de pruebas puede estar pausada).
        {"type": "Startup", **sonda("/health/live", initialDelaySeconds=3, periodSeconds=10, failureThreshold=30, timeoutSeconds=5)},
        {"type": "Liveness", **sonda("/health/live", periodSeconds=30, failureThreshold=3, timeoutSeconds=5)},
        {"type": "Readiness", **sonda("/health/ready", periodSeconds=10, failureThreshold=3, timeoutSeconds=5)},
    ],
)
escala = tpl.get("scale") or {}
escala.update(minReplicas=int(e["MIN"]), maxReplicas=max(3, escala.get("maxReplicas") or 3))
print(json.dumps({"properties": {"template": {
    "containers": [c] + tpl["containers"][1:],
    "scale": escala,
    "revisionSuffix": e["SUFIJO_REV"],
}}}))
PY
az rest --method patch -o none --body "@$TMP/parche.json" \
  --url "https://management.azure.com$APP_ID?api-version=$API_APPS"

FQDN="$(fqdn_app)"
echo "-> Esperando que la app responda sana en https://$FQDN …"
bash "$AQUI/../../scripts/esperar-salud.sh" "https://$FQDN" 40 15

# La clave inicial del admin ya cumplió su función (el admin existe): se borra.
if [ -n "$ADMIN_PASS" ]; then
  echo "-> Quitando la clave inicial del admin de la app y del job…"
  az containerapp update -g "$RG" -n "$APP" --remove-env-vars HAJIME_ADMIN_PASSWORD \
    --revision-suffix "sin-admin-$(date -u +%m%d%H%M%S)" -o none
  az containerapp secret remove -g "$RG" -n "$APP" --secret-names admin-pass -o none \
    || echo "   Aviso: no se pudo borrar el secreto admin-pass; bórralo en el portal (Secretos)."
  definir_job 0
  bash "$AQUI/../../scripts/esperar-salud.sh" "https://$FQDN" 40 15
fi

if [ "$SQL_FIREWALL" = "salida" ]; then
  echo "-> Firewall de la base: solo las IP de salida de la app…"
  N=0
  for IP in $(az containerapp show -g "$RG" -n "$APP" --query "properties.outboundIpAddresses[]" -o tsv); do
    N=$((N + 1))
    az sql server firewall-rule create -g "$RG" -s "$SQL_SERVER" -n "ContainerApps-$N" \
      --start-ip-address "$IP" --end-ip-address "$IP" -o none
  done
  if [ "$N" -gt 0 ]; then
    az sql server firewall-rule delete -g "$RG" -s "$SQL_SERVER" -n PermitirAzure -o none 2>/dev/null || true
  else
    echo "   Aviso: Azure no informó IP de salida; se mantiene PermitirAzure."
  fi
fi

if [ -n "${PRESUPUESTO_USD:-}" ] && [ -n "${PRESUPUESTO_CORREO:-}" ]; then
  echo "-> Presupuesto mensual de $PRESUPUESTO_USD USD con aviso a $PRESUPUESTO_CORREO…"
  cat >"$TMP/presupuesto.json" <<JSON
{"properties": {"category": "Cost", "amount": $PRESUPUESTO_USD, "timeGrain": "Monthly",
  "timePeriod": {"startDate": "$(date -u +%Y-%m-01)T00:00:00Z"},
  "notifications": {
    "real80": {"enabled": true, "operator": "GreaterThan", "threshold": 80, "thresholdType": "Actual", "contactEmails": ["$PRESUPUESTO_CORREO"]},
    "previsto100": {"enabled": true, "operator": "GreaterThan", "threshold": 100, "thresholdType": "Forecasted", "contactEmails": ["$PRESUPUESTO_CORREO"]}}}}
JSON
  az rest --method put -o none --body "@$TMP/presupuesto.json" \
    --url "https://management.azure.com/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.Consumption/budgets/hajime-$AMBIENTE?api-version=2023-05-01" \
    || echo "   Aviso: no se pudo crear el presupuesto; créalo en el portal (Presupuestos)."
fi

VERIF="$(az containerapp show -g "$RG" -n "$APP" --query properties.customDomainVerificationId -o tsv)"
DOMINIOS="$(az containerapp show -g "$RG" -n "$APP" --query "properties.configuration.ingress.customDomains[].name" -o tsv 2>/dev/null || true)"

echo
echo "================================================================"
echo " Listo. La app responde en:  https://$FQDN"
[ -n "$DOMINIOS" ] && echo " Dominio propio: $(echo "$DOMINIOS" | tr '\n' ' ')"
if [ -z "$APP_EXISTE" ]; then
  echo " Entra con el usuario 'admin' y la clave que escribiste (la app ya no la guarda)."
fi
echo " Base: $HOST_SQL/$SQL_DB  (usuario de la app: $([ -n "$USUARIO_APP" ] && echo "$SQL_APP_USER" || echo "administrador — ver docs"))"
echo " Migraciones: job $JOB · Revisiones: bash rollback.sh $AMBIENTE"
if [ -z "$DOMINIOS" ]; then
  cat <<FIN

 Registros DNS para Cloudflare (DNS → Registros → Agregar registro):

   Tipo: CNAME   Nombre: hajime          Destino:   $FQDN
                 Proxy: DESACTIVADO (nube gris, «Solo DNS»)
   Tipo: TXT     Nombre: asuid.hajime    Contenido: $VERIF

 Luego conecta el dominio con:
   bash conectar-dominio.sh $AMBIENTE hajime.lorboftherin.com
FIN
fi
echo "================================================================"
