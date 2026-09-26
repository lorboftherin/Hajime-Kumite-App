# Hajime — imagen "todo en uno": interfaz web + API en un solo contenedor.
#
#   docker compose up -d        (ver docker-compose.yml)
#   abrir http://localhost:8000
#
# 1) Compilar el frontend Angular
FROM node:22-alpine AS frontend
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npx ng build --configuration production

# 2) API (FastAPI) sirviendo el frontend compilado
FROM python:3.12-slim
# Driver ODBC de Microsoft, solo necesario si se usa SQL Server / Azure SQL
ARG WITH_MSSQL=false
RUN if [ "$WITH_MSSQL" = "true" ]; then \
      apt-get update && apt-get install -y --no-install-recommends curl gnupg2 unixodbc \
      && curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor -o /usr/share/keyrings/microsoft.gpg \
      && echo "deb [signed-by=/usr/share/keyrings/microsoft.gpg] https://packages.microsoft.com/debian/12/prod bookworm main" > /etc/apt/sources.list.d/mssql.list \
      && apt-get update && ACCEPT_EULA=Y apt-get install -y --no-install-recommends msodbcsql18 \
      && rm -rf /var/lib/apt/lists/*; \
    fi
WORKDIR /app
COPY backend/pyproject.toml ./
COPY backend/app ./app
COPY backend/scripts ./scripts
COPY backend/alembic.ini ./
COPY backend/docker-entrypoint.sh ./
# La imagen para Azure trae además Azure Monitor (se activa solo con
# APPLICATIONINSIGHTS_CONNECTION_STRING).
RUN pip install --no-cache-dir . && if [ "$WITH_MSSQL" = "true" ]; then pip install --no-cache-dir ".[mssql,azure]"; fi \
    && chmod 755 /app/docker-entrypoint.sh
COPY --from=frontend /src/dist/hajime/browser ./static

RUN useradd --create-home --uid 1000 hajime && mkdir -p /data && chown hajime /data
USER hajime

ENV HAJIME_ENVIRONMENT=test \
    HAJIME_DATABASE_URL=sqlite:////data/hajime.db \
    HAJIME_SECRET_FILE=/data/jwt_secret \
    HAJIME_STATIC_DIR=/app/static
VOLUME ["/data"]
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health/live')" || exit 1
# El entrypoint prepara la base una sola vez y luego reemplaza al shell por
# uvicorn (forma exec: recibe SIGTERM y apaga ordenadamente). Varios procesos:
# cada uno atiende pocas peticiones a la vez (ver worker_threads en config.py);
# con dos, la app responde el doble de rápido bajo carga y usa ~400 MB.
# Variables: HAJIME_WORKERS (2), HAJIME_FORWARDED_ALLOW_IPS (*), PORT (8000).
ENTRYPOINT ["/app/docker-entrypoint.sh"]
