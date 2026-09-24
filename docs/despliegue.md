# Despliegue

## Ambientes

| Ambiente | Base de datos | Datos | Uso |
| --- | --- | --- | --- |
| DEV | SQLite local o SQL Server en Docker | Ficticios (`python -m app.seed demo`) | Desarrollo |
| TEST | Azure SQL (tier económico) | Ficticios o anonimizados, **nunca copias de PROD** | Torneo mock, pruebas de campo |
| PROD | Azure SQL | Reales, con consentimiento registrado | Shadow Mode y torneos reales |

## Variables de entorno de la API (prefijo `HAJIME_`)

| Variable | Ejemplo | Notas |
| --- | --- | --- |
| `HAJIME_ENVIRONMENT` | `prod` | `dev`, `test` o `prod` |
| `HAJIME_DATABASE_URL` | `mssql+pyodbc://usuario:clave@servidor.database.windows.net:1433/hajime?driver=ODBC+Driver+18+for+SQL+Server&Encrypt=yes` | En Azure, guardarla como secreto |
| `HAJIME_JWT_SECRET` | 64 caracteres aleatorios | La API no arranca en `prod` sin este valor |
| `HAJIME_CORS_ORIGINS` | `["https://hajime.example.pe"]` | Dominio del frontend |

## Azure (propuesta inicial, sección 22)

1. **Azure SQL Database** en un tier económico (serverless con autopausa o Basic),
   con backups automáticos. Antes de cada torneo real, además, hacer una
   exportación manual (`.bacpac`).
2. **Esquema:** aplicar `sql/001_schema.sql` con Azure Data Studio o `sqlcmd`.
3. **API:** Azure Container Apps o App Service para contenedores, con la imagen
   de `backend/Dockerfile`. Secretos en la configuración del servicio (o Key Vault).
4. **Frontend:** Azure Static Web Apps con el build de `frontend/`
   (`npx ng build`, carpeta `dist/frontend/browser`). Configurar un proxy o
   rewrite de `/api/*` hacia la API, o poner la URL de la API en CORS.
5. **Usuario administrador:** ejecutar una vez, dentro del contenedor:
   `python -m app.seed admin --username <usuario> --password <clave>`, y
   `python -m app.seed template` para cargar la plantilla borrador.

## Local con SQL Server (Docker)

```bash
docker compose up -d db
docker compose run --rm init-db   # crea la base 'hajime' y aplica el esquema
docker compose up -d api          # http://localhost:8000/docs
docker compose exec api python -m app.seed admin --password admin12345
```

## Checklist antes de un torneo real

- [ ] Backup o exportación de la base de datos.
- [ ] Torneo con la marca `es_prueba` desactivada, y datos con consentimiento registrado.
- [ ] Llaves impresas desde la app como respaldo en papel.
- [ ] Tablet cargada y probada en la red del local; plan B: la mesa sigue en papel (principio "la app nunca detiene un torneo").
