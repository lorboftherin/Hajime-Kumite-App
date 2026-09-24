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
| `HAJIME_CORS_ORIGINS` | `["https://hajime.example.pe"]` | Solo si el frontend se sirve desde otro dominio |
| `HAJIME_SECRET_FILE` | `/data/jwt_secret` | Alternativa a `HAJIME_JWT_SECRET`: se genera y guarda la primera vez |
| `HAJIME_ADMIN_PASSWORD` | — | Crea el admin en el primer arranque si no hay usuarios |
| `HAJIME_STATIC_DIR` | `/app/static` | Carpeta del frontend compilado (ya viene en la imagen) |

## Azure (propuesta inicial, sección 22)

1. **Azure SQL Database** en un tier económico (serverless con autopausa o Basic),
   con backups automáticos. Antes de cada torneo real, además, hacer una
   exportación manual (`.bacpac`).
2. **Esquema:** `cd backend && HAJIME_DATABASE_URL=<url> alembic upgrade head`
   (o `HAJIME_AUTO_CREATE_SCHEMA=true` para que la API aplique las
   migraciones al arrancar). `sql/001_schema.sql` queda como referencia del
   esquema completo.
3. **App:** Azure Container Apps o App Service para contenedores con la imagen
   "todo en uno" (`Dockerfile` de la raíz, construida con
   `--build-arg WITH_MSSQL=true`): sirve la interfaz y la API en la misma URL.
   Secretos en la configuración del servicio (o Key Vault).
4. **Primer arranque:** con `HAJIME_ADMIN_PASSWORD` definida, la app crea el
   admin (si no hay usuarios) y carga la plantilla base. Después conviene
   quitar esa variable.

## Local con SQLite (pruebas y torneo mock)

```bash
HAJIME_ADMIN_PASSWORD='una-clave' docker compose up -d --build   # http://localhost:8000
```

## Local con SQL Server (Docker)

```bash
docker compose --profile sqlserver up -d db
docker compose --profile sqlserver run --rm init-db   # crea la base 'hajime' (vacía)
HAJIME_ADMIN_PASSWORD='una-clave' docker compose --profile sqlserver up -d app-sqlserver
```

## Checklist antes de un torneo real

- [ ] Backup o exportación de la base de datos.
- [ ] Torneo con la marca `es_prueba` desactivada, y datos con consentimiento registrado.
- [ ] Llaves impresas desde la app como respaldo en papel.
- [ ] Tablet cargada y probada en la red del local; plan B: la mesa sigue en papel (principio "la app nunca detiene un torneo").
