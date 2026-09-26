#!/bin/sh
# Arranque del contenedor.
#
# 1) Prepara la base UNA vez (espera a que responda, migra, crea el admin y la
#    plantilla). Si cada proceso de uvicorn lo hiciera por su cuenta, sobre una
#    base vacía chocarían creando las mismas tablas (ver app/prepare.py).
# 2) Levanta uvicorn con `exec`: pasa a ser el proceso principal y recibe
#    directamente la señal de apagado (SIGTERM) de Docker / Container Apps, así
#    termina las peticiones en curso antes de salir.
#
# Con argumentos, ejecuta ese comando en su lugar
# (p. ej. `docker run hajime python -m app.seed demo`).
set -e

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

python -m app.prepare

# La base ya está lista: los procesos no deben volver a migrar.
export HAJIME_MIGRATE_ON_STARTUP=false

# --forwarded-allow-ips: de quién se aceptan X-Forwarded-For / -Proto. En Azure
# Container Apps el ingress (un proxy de Azure) está siempre delante y el
# contenedor no es accesible de otra forma, así que se confía en cualquiera
# ("*"). Sin esto, la IP del cliente sería la del proxy y el bloqueo de
# intentos de inicio de sesión trataría a todos como una sola persona.
# Si el contenedor queda expuesto directamente a internet, poner aquí la IP
# del proxy (o 127.0.0.1 si no hay ninguno).
exec uvicorn app.main:app \
  --host 0.0.0.0 \
  --port "${PORT:-8000}" \
  --proxy-headers \
  --forwarded-allow-ips "${HAJIME_FORWARDED_ALLOW_IPS:-*}" \
  --workers "${HAJIME_WORKERS:-2}" \
  --timeout-graceful-shutdown 20 \
  --no-access-log
