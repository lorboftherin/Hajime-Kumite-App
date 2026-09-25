#!/usr/bin/env bash
# Conecta un dominio propio a la app y le emite un certificado HTTPS gratis.
# Requiere los registros CNAME y TXT ya creados en Cloudflare (ver crear-ambiente.sh).
#
#   bash conectar-dominio.sh test hajime.lorboftherin.com
set -euo pipefail
AMBIENTE="${1:?Uso: bash conectar-dominio.sh test|prod dominio}"
DOMINIO="${2:?Falta el dominio, p. ej. hajime.lorboftherin.com}"
RG="hajime-$AMBIENTE"; APP="hajime-$AMBIENTE"; ENTORNO="hajime-$AMBIENTE-env"

echo "-> Agregando $DOMINIO a la app…"
az containerapp hostname add -g "$RG" -n "$APP" --hostname "$DOMINIO" -o none
echo "-> Emitiendo el certificado HTTPS administrado (puede tardar unos minutos)…"
az containerapp hostname bind -g "$RG" -n "$APP" --hostname "$DOMINIO" \
  --environment "$ENTORNO" --validation-method CNAME -o none
echo "Listo: https://$DOMINIO"
echo "Si este paso falla, hazlo desde el portal: tu app → Dominios personalizados →"
echo "Agregar dominio personalizado → Certificado administrado (docs/despliegue-azure.md)."
