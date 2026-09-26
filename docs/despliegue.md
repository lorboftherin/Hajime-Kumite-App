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
| `HAJIME_JWT_PREVIOUS_SECRET` | el secreto anterior | Solo durante una rotación: los tokens firmados con él siguen valiendo hasta vencer (ver abajo) |
| `HAJIME_ACCESS_TOKEN_MINUTES` | `60` | Vida del token de acceso; la app lo renueva sola antes de que venza |
| `HAJIME_REFRESH_TOKEN_DAYS` | `30` | Vida del token de renovación (una sesión sin uso durante este tiempo pide la contraseña) |
| `HAJIME_CORS_ORIGINS` | `["https://hajime.example.pe"]` | Orígenes de otros dominios que pueden llamar a la API. Sin definir: en `dev`/`test` se aceptan los de desarrollo (`localhost`, app del celular); en `prod`, **ninguno**. Si en prod se usa la app del celular, agregar `"https://localhost"` y `"capacitor://localhost"` |
| `HAJIME_SECRET_FILE` | `/data/jwt_secret` | Alternativa a `HAJIME_JWT_SECRET`: se genera y guarda la primera vez |
| `HAJIME_ADMIN_PASSWORD` | — | Crea el admin en el primer arranque si no hay usuarios |
| `HAJIME_STATIC_DIR` | `/app/static` | Carpeta del frontend compilado (ya viene en la imagen) |
| `HAJIME_AUTO_CREATE_SCHEMA` | `true` | SQL Server: aplicar las migraciones al arrancar (SQLite siempre las aplica) |
| `HAJIME_MIGRATE_ON_STARTUP` | `true` | Cada proceso prepara la base al iniciar (desarrollo). El contenedor lo pone en `false` solo: su entrypoint ya la preparó una vez |
| `HAJIME_WORKERS` | `2` | Procesos de uvicorn en el contenedor |
| `HAJIME_FORWARDED_ALLOW_IPS` | `*` | De qué proxies se acepta `X-Forwarded-For` (ver abajo). En el contenedor, `*` |
| `HAJIME_PASSWORD_ITERATIONS` | `120000` | Coste del hash de contraseñas (PBKDF2-SHA256). Al cambiarlo, cada usuario se actualiza solo al volver a entrar |
| `HAJIME_DB_POOL_SIZE` | `6` | Conexiones a SQL Server por proceso |
| `HAJIME_DB_MAX_OVERFLOW` | `4` | Conexiones extra por proceso en picos |
| `HAJIME_DB_POOL_TIMEOUT` | `10` | Segundos esperando una conexión libre antes de responder 503 |
| `HAJIME_EXPOSE_DOCS` | `false` | `/docs` y `/openapi.json`. Sin definir: visibles salvo en `prod` |
| `HAJIME_LOG_LEVEL` | `INFO` | `DEBUG` muestra también las sondas de salud |
| `HAJIME_LOG_FORMAT` | `json` | `json` (una línea por evento, para Log Analytics) o `text` |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | — | Activa Azure Monitor (trazas, errores y métricas). La imagen `-azure` ya trae el paquete; en otra instalación: `pip install '.[azure]'` |

Con 3 copias × 2 procesos × (6 + 4) conexiones, la app abre como máximo 60
sesiones en Azure SQL, dentro del límite del tier serverless más chico.

## Arranque del contenedor

El entrypoint (`backend/docker-entrypoint.sh`) hace dos cosas, en orden:

1. `python -m app.prepare`: espera a que la base responda (Azure SQL serverless
   tarda cerca de un minuto en despertar), aplica las migraciones y crea el
   admin y la plantilla base si faltan. Lo hace **una sola vez**, con un
   candado en la base (`sp_getapplock` en SQL Server, un archivo `.lock` en
   SQLite) por si arrancan varias copias a la vez.
2. `exec uvicorn …` con `HAJIME_WORKERS` procesos. Con `exec`, uvicorn recibe
   directamente la señal de apagado y termina las peticiones en curso.

Antes cada proceso migraba por su cuenta y, sobre una base vacía, dos procesos
chocaban creando las mismas tablas. Para otro comando, pasarlo como argumento:
`docker run --rm <imagen> python -m app.seed demo`.

**IP real del cliente.** En Container Apps el ingress de Azure está siempre
delante del contenedor y manda la IP del usuario en `X-Forwarded-For`. uvicorn
la usa solo si confía en quien la envía (`--forwarded-allow-ips`, que el
entrypoint toma de `HAJIME_FORWARDED_ALLOW_IPS`, por defecto `*`: el contenedor
no se alcanza de otra forma). Sin esto, todos parecerían venir de la misma IP y
el bloqueo de intentos de inicio de sesión los trataría como una sola persona.
Si el contenedor se expone directo a internet sin proxy, poner
`HAJIME_FORWARDED_ALLOW_IPS=127.0.0.1`.

## Salud, errores y logs

| Ruta | Uso |
| --- | --- |
| `/health/live` (y `/health`) | El proceso responde. No toca la base: sonda de *liveness* (una base en pausa no debe reiniciar el contenedor) |
| `/health/ready` | `SELECT 1` a la base con 2 s de límite; 503 si falla. Sonda de *readiness* |

- Todos los errores salen en JSON con el mismo formato e incluyen
  `request_id`, el mismo que la cabecera `X-Request-ID` de la respuesta y que
  cada línea de log de esa petición. Si un usuario reporta un error, con ese
  código se encuentra en Log Analytics
  (`ContainerAppConsoleLogs_CL | where Log_s has "<request_id>"`).
- Base en pausa o despertando: 503 con `Retry-After: 10` y el mensaje «La
  base de datos está despertando, reintenta en unos segundos». Sin conexiones
  libres en el pool: 503. Dato duplicado por dos guardados a la vez: 409.
  Cualquier otro error inesperado: 500, con la traza completa en el log.
- Una línea JSON por petición en stdout: método, ruta, estado, duración e IP.

## Seguridad HTTP

- Cabeceras en todas las respuestas: `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`
  (salvo el overlay `/overlay/…`, que se incrusta en OBS) y, fuera de `dev`,
  `Strict-Transport-Security`.
- Inicio de sesión: 5 fallos en 10 min bloquean ese usuario desde esa IP por
  5 min; 30 fallos desde una misma IP (cualquier usuario) la bloquean también.
  La cuenta se guarda en la base (tabla `login_attempts`), así vale para todos
  los procesos y copias.

## Sesiones y rotación del secreto JWT

- Al iniciar sesión la app recibe un token de acceso (60 min) y uno de
  renovación (30 días, rotado en cada uso). Cada dispositivo es una sesión:
  se ven en `GET /auth/sessions`, se cierran con `DELETE /auth/sessions/{id}`
  y el Admin cierra todas las de una cuenta con `DELETE /users/{id}/sessions`
  (p. ej. una tablet perdida).
- `HAJIME_JWT_MINUTES` ya no se usa: la vida del token de acceso es
  `HAJIME_ACCESS_TOKEN_MINUTES`.
- **Rotar el secreto sin expulsar a nadie:** poner el valor actual en
  `HAJIME_JWT_PREVIOUS_SECRET` y el nuevo en `HAJIME_JWT_SECRET`, y
  reiniciar. Los tokens firmados con el anterior siguen valiendo hasta vencer
  (a lo sumo `HAJIME_ACCESS_TOKEN_MINUTES`) y la app se renueva sola con el
  nuevo. Pasado ese tiempo, quitar `HAJIME_JWT_PREVIOUS_SECRET`.

## Protección de datos: filas de importación

Al confirmar o cancelar una importación de Excel se borran el DNI y la
fecha de nacimiento de sus filas. Las filas de lotes de más de 30 días se
borran bajo demanda:

```bash
python -m app.seed purge-imports            # o --days 60
```

(o `POST /api/v1/imports/purge` como Admin). Conviene programarlo, p. ej.
una vez por semana, o correrlo después de cada torneo.

## Azure (propuesta inicial, sección 22)

**Paso a paso con scripts listos:** [`docs/despliegue-azure.md`](despliegue-azure.md) (`infra/azure/`).

1. **Azure SQL Database** en un tier económico (serverless con autopausa o Basic),
   con backups automáticos. Antes de cada torneo real, además, hacer una
   exportación manual (`.bacpac`).
2. **Esquema:** `cd backend && HAJIME_DATABASE_URL=<url> alembic upgrade head`
   (o `HAJIME_AUTO_CREATE_SCHEMA=true` para que el contenedor aplique las
   migraciones al arrancar, una sola vez; ver «Arranque del contenedor»). `sql/001_schema.sql` queda como referencia del
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
