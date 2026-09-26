#!/usr/bin/env bash
# Funciones y nombres compartidos por los scripts de infra/azure/.
# No se ejecuta solo: los demás scripts lo cargan con `source`.
#
# Nombres de un ambiente <amb> (test | prod):
#   grupo de recursos     hajime-<amb>
#   app                   hajime-<amb>            (Container App)
#   entorno               hajime-<amb>-env        (Container Apps Environment)
#   job de migraciones    hajime-<amb>-migrar     (Container Apps Job, manual)
#   base de datos         hajime                  (en el servidor hajime-<amb>-sql-…)

# shellcheck disable=SC2034 # las variables se usan en los scripts que cargan este archivo
# Imagen publicada por CI (en minúsculas: GHCR no acepta mayúsculas).
IMAGEN_BASE="$(echo "${IMAGEN_BASE:-ghcr.io/lorboftherin/hajime-kumite-app}" | tr '[:upper:]' '[:lower:]')"
API_APPS="2024-03-01" # versión de la API de Microsoft.App usada con `az rest`

# Comando del job de migraciones. Usa `python -m app.prepare` si la imagen lo
# trae; si no (imágenes anteriores), aplica las migraciones como lo hacía la app
# al arrancar. Se cambia con COMANDO_MIGRACION="..." al correr crear-ambiente.sh.
COMANDO_MIGRACION_POR_DEFECTO='if python -c "import importlib.util as u, sys; sys.exit(u.find_spec(\"app.prepare\") is None)"; then exec python -m app.prepare; else exec python -c "from app.db.base import get_engine, wait_for_database; from app.db.migrate import upgrade_database; e = get_engine(); wait_for_database(e); upgrade_database(e); print(\"Migraciones aplicadas\")"; fi'

nombres_ambiente() {
  AMBIENTE="$1"
  case "$AMBIENTE" in test | prod) ;; *) echo "Ambiente inválido: '$AMBIENTE' (usa test o prod)" >&2 && exit 1 ;; esac
  RG="hajime-$AMBIENTE"
  APP="hajime-$AMBIENTE"
  ENTORNO="hajime-$AMBIENTE-env"
  JOB="hajime-$AMBIENTE-migrar"
  SQL_DB="hajime"
}

preparar_az() {
  az extension add --name containerapp --upgrade --only-show-errors >/dev/null
}

# Etiqueta de imagen para Azure a partir de un SHA o una versión:
#   1a2b3c4 / 1a2b3c4d5e…  -> sha-1a2b3c4-azure
#   0.2.0 / v0.2.0         -> 0.2.0-azure
#   sha-1a2b3c4-azure      -> igual (ya es una etiqueta)
etiqueta_imagen() {
  local x="${1#v}"
  if [[ "$x" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
    echo "$x-azure"
  elif [[ "$x" =~ ^[0-9a-f]{7,40}$ ]]; then
    echo "sha-${x:0:7}-azure"
  elif [[ "$x" =~ -azure$ ]]; then
    echo "$x"
  else
    echo "No entiendo '$1': usa un SHA (1a2b3c4), una versión (0.2.0) o una etiqueta (sha-1a2b3c4-azure)" >&2
    return 1
  fi
}

# Valor de un secreto de la app (vacío si la app o el secreto no existen).
secreto_app() {
  az containerapp secret show -g "$RG" -n "$APP" --secret-name "$1" --query value -o tsv 2>/dev/null || true
}

existe_app() { az containerapp show -g "$RG" -n "$APP" -o none 2>/dev/null; }
existe_job() { az containerapp job show -g "$RG" -n "$JOB" -o none 2>/dev/null; }

fqdn_app() { az containerapp show -g "$RG" -n "$APP" --query properties.configuration.ingress.fqdn -o tsv; }

revision_activa() {
  az containerapp revision list -g "$RG" -n "$APP" \
    --query "reverse(sort_by([?properties.active], &properties.createdTime))[0].name" -o tsv
}

# Corre el job de migraciones con la imagen indicada y espera a que termine.
correr_migraciones() {
  local imagen="$1" ejecucion estado
  echo "-> Migraciones: job $JOB con $imagen…"
  az containerapp job update -g "$RG" -n "$JOB" --image "$imagen" -o none
  ejecucion="$(az containerapp job start -g "$RG" -n "$JOB" --query name -o tsv)"
  echo "   ejecución $ejecucion"
  for _ in $(seq 1 90); do # hasta 15 minutos (la base serverless puede estar despertando)
    estado="$(az containerapp job execution show -g "$RG" -n "$JOB" \
      --job-execution-name "$ejecucion" --query properties.status -o tsv 2>/dev/null || true)"
    case "$estado" in
      Succeeded) echo "   migraciones aplicadas"; return 0 ;;
      Failed | Stopped | Degraded)
        echo "   las migraciones fallaron ($estado). Registros:" >&2
        az containerapp job logs show -g "$RG" -n "$JOB" --execution "$ejecucion" \
          --container "$JOB" --format text 2>/dev/null | tail -40 >&2 || true
        echo "   (también en el portal: $JOB → Historial de ejecuciones)" >&2
        return 1 ;;
    esac
    sleep 10
  done
  echo "   las migraciones no terminaron en 15 minutos" >&2
  return 1
}

# Servidor Azure SQL del ambiente (el único del grupo de recursos).
servidor_sql() {
  az sql server list -g "$RG" --query "[0].name" -o tsv
}

# Clave del administrador del servidor SQL para una tarea puntual (exportar,
# restaurar). Si la app aún se conecta como administrador (ambiente creado sin
# sqlcmd), se usa esa clave; si no, se asigna una nueva que no se guarda: el
# administrador solo lo usan estos scripts. Deja SQL_ADMIN_USUARIO y SQL_ADMIN_CLAVE.
clave_admin_sql() {
  local servidor="$1" admin url clave
  admin="$(az sql server show -g "$RG" -n "$servidor" --query administratorLogin -o tsv)"
  url="$(secreto_app db-url)"
  clave="$(DB_URL="$url" ADMIN="$admin" python3 -c '
import os
from urllib.parse import unquote, urlsplit
u = urlsplit(os.environ["DB_URL"]) if os.environ["DB_URL"] else None
print(unquote(u.password or "") if u and u.username == os.environ["ADMIN"] else "")')"
  if [ -z "$clave" ]; then
    clave="$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | cut -c1-28)Aa1"
    az sql server update -g "$RG" -n "$servidor" --admin-password "$clave" -o none
  fi
  SQL_ADMIN_USUARIO="$admin"
  SQL_ADMIN_CLAVE="$clave"
}
