#!/usr/bin/env bash
# Ensayo de recuperación: restaura la base de un ambiente a un punto en el
# tiempo en una base TEMPORAL, la revisa y la borra. No toca la base real.
# Sirve para comprobar que los respaldos automáticos funcionan y medir cuánto
# tarda una restauración (hacerlo antes de cada temporada de torneos).
#
#   bash restaurar-prueba.sh prod          # punto: hace 60 minutos
#   bash restaurar-prueba.sh prod 1440     # punto: hace 24 horas
#   CONSERVAR=1 bash restaurar-prueba.sh prod   # no borra la base temporal (para revisarla a mano)
#
# Variables: SKU_ENSAYO=S0 (tamaño de la base temporal; se cobra por hora).
set -euo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=comun.sh
source "$AQUI/comun.sh"
nombres_ambiente "${1:?Uso: bash restaurar-prueba.sh test|prod [minutos_atrás]}"
MINUTOS="${2:-60}"
SKU_ENSAYO="${SKU_ENSAYO:-S0}"
preparar_az

SERVIDOR="$(servidor_sql)"
[ -n "$SERVIDOR" ] || { echo "No hay servidor SQL en $RG" >&2; exit 1; }
PUNTO="$(date -u -d "-$MINUTOS minutes" +%Y-%m-%dT%H:%M:%SZ)"
TEMPORAL="$SQL_DB-ensayo-$(date -u +%Y%m%d%H%M)"
MAS_ANTIGUO="$(az sql db show -g "$RG" -s "$SERVIDOR" -n "$SQL_DB" --query earliestRestoreDate -o tsv)"
echo "== Ensayo de restauración: $SERVIDOR/$SQL_DB al $PUNTO (el punto más antiguo es $MAS_ANTIGUO) =="

borrar() {
  if [ -z "${CONSERVAR:-}" ]; then
    echo "-> Borrando la base temporal $TEMPORAL…"
    az sql db delete -g "$RG" -s "$SERVIDOR" -n "$TEMPORAL" --yes -o none 2>/dev/null || true
  else
    echo "-> Se conserva $TEMPORAL (bórrala luego: az sql db delete -g $RG -s $SERVIDOR -n $TEMPORAL --yes)"
  fi
}
trap borrar EXIT

INICIO=$SECONDS
echo "-> Restaurando en $TEMPORAL ($SKU_ENSAYO)…"
az sql db restore -g "$RG" -s "$SERVIDOR" -n "$SQL_DB" --dest-name "$TEMPORAL" \
  --time "$PUNTO" --service-objective "$SKU_ENSAYO" -o none
echo "   restaurada en $((SECONDS - INICIO)) s"

if command -v sqlcmd >/dev/null 2>&1; then
  clave_admin_sql "$SERVIDOR"
  MI_IP="$(curl -s --max-time 10 https://api.ipify.org || true)"
  if [ -n "$MI_IP" ]; then
    az sql server firewall-rule create -g "$RG" -s "$SERVIDOR" -n EnsayoTemporal \
      --start-ip-address "$MI_IP" --end-ip-address "$MI_IP" -o none
  fi
  echo "-> Revisando el contenido restaurado…"
  SQLCMDPASSWORD="$SQL_ADMIN_CLAVE" sqlcmd -S "tcp:$SERVIDOR.database.windows.net,1433" -d "$TEMPORAL" \
    -U "$SQL_ADMIN_USUARIO" -b -l 60 -W -Q "
SET NOCOUNT ON;
SELECT (SELECT version_num FROM alembic_version) AS migracion,
       (SELECT COUNT(*) FROM users) AS usuarios,
       (SELECT COUNT(*) FROM tournaments) AS torneos,
       (SELECT COUNT(*) FROM matches) AS combates;" || echo "   Aviso: no se pudo consultar la base restaurada"
  [ -n "$MI_IP" ] && az sql server firewall-rule delete -g "$RG" -s "$SERVIDOR" -n EnsayoTemporal -o none || true
else
  echo "   (sin sqlcmd: se omite la revisión del contenido)"
fi
echo "Ensayo OK: restaurar $SQL_DB al $PUNTO tomó $((SECONDS - INICIO)) s."
echo "Anótalo en el checklist del torneo (docs/despliegue.md)."
