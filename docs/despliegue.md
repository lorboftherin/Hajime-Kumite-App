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

## Azure

**Paso a paso con scripts listos:** [`docs/despliegue-azure.md`](despliegue-azure.md) (`infra/azure/`).
Acciones que solo puede hacer el dueño: [`docs/acciones-del-duenio.md`](acciones-del-duenio.md).

1. **Azure SQL Database:** pruebas en la oferta gratuita (se pausa sola);
   producción en S0 sin autopausa, con respaldos a cualquier punto de 14 días y
   retención semanal y mensual. La app entra con su propio usuario
   (`hajime_app`), no con el administrador.
2. **Esquema:** lo aplica el job `hajime-<amb>-migrar` (el mismo contenedor con
   `python -m app.prepare`) antes de cada versión; la app corre con
   `HAJIME_AUTO_CREATE_SCHEMA=false`. A mano:
   `cd backend && HAJIME_DATABASE_URL=<url> alembic upgrade head`.
   `sql/001_schema.sql` queda como referencia del esquema completo.
3. **App:** Azure Container Apps con la imagen "todo en uno" `-azure` (con el
   driver de SQL Server), sondas en `/health/live` y `/health/ready`. Pruebas se
   actualiza sola desde `main`; producción con el workflow «Desplegar a
   producción» (aprobación manual, rollback con `infra/azure/rollback.sh`).
4. **Primer arranque:** `crear-ambiente.sh` pasa `HAJIME_ADMIN_PASSWORD` una
   sola vez; la app crea el admin y la plantilla base, y el script borra esa
   variable cuando la app responde sana.

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

Una semana antes:

- [ ] La versión que se usará está en producción desde hace días (promovida
      desde pruebas, no el mismo día) y se probó la mesa en pruebas con ella.
- [ ] Ensayo de restauración hecho en la temporada: `bash infra/azure/restaurar-prueba.sh prod`
      (anotar cuánto tardó: ______ s).
- [ ] Sabes volver atrás: `bash infra/azure/rollback.sh prod` lista las revisiones
      (anotar la revisión estable: ______________________).
- [ ] Base de producción sin autopausa y app con mínimo 1 réplica
      (`crear-ambiente.sh prod` lo deja así; revisar si alguien lo cambió).
- [ ] Alerta de presupuesto activa y sin sorpresas en el gasto del mes.

El día anterior:

- [ ] Congelar cambios: nada se promueve a producción hasta después del torneo.
- [ ] Respaldo exportado: `bash infra/azure/respaldar.sh prod` (queda en la lista).
- [ ] Torneo con la marca `es_prueba` desactivada, y datos con consentimiento registrado.
- [ ] Llaves impresas desde la app como respaldo en papel.

El día del torneo:

- [ ] `https://<dominio>/health/ready` responde y la app abre en cada tablet.
- [ ] Tablets cargadas y probadas en la red del local, con la app instalada
      (PWA o APK) y la sesión del operador abierta; probar cortar el wifi en la
      mesa y ver que los eventos quedan en cola y se envían al volver.
- [ ] Plan B: la mesa sigue en papel (principio "la app nunca detiene un torneo").

Después:

- [ ] Respaldo exportado otra vez (`respaldar.sh prod`) con los resultados finales.
