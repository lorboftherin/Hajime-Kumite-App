# Hajime — Frontend (Angular)

Cliente web de Hajime, la plataforma de gestión de torneos de karate. Es una SPA en
Angular 21 (componentes standalone, signals y control de flujo `@if`/`@for`) con SCSS
propio, sin librerías de UI.

**El frontend no tiene reglas de negocio.** Todo lo decide la API (`/api/v1`, FastAPI, en
`../backend`); la web solo muestra datos y envía acciones.

## Requisitos

- Node.js 22.12 o superior (probado con 22.22) y npm 10+.
- El backend corriendo en `http://localhost:8000` (ver `../backend`).

## Puesta en marcha

```bash
cd frontend
npm install
npm start          # ng serve en http://localhost:4200 con proxy
```

`npm start` usa `proxy.conf.json`: `/api` y `/health` se redirigen a
`http://localhost:8000`, así que la app siempre llama a URLs relativas (`/api/v1/...`).

Para tener datos de prueba en el backend:

```bash
cd backend
rm -f hajime.db
.venv/bin/python -m app.seed admin --password admin12345
.venv/bin/python -m app.seed demo       # torneo mock con datos ficticios
.venv/bin/uvicorn app.main:app --port 8000
```

Luego se ingresa con `admin` / `admin12345`.

## Build y pruebas

```bash
npm run build                 # producción → dist/hajime/browser
npx ng test --watch=false     # pruebas unitarias (Vitest)
```

En producción la app espera que `/api` se sirva en el mismo origen (p. ej. un proxy
inverso delante del sitio estático y de la API).

## Estructura

```
src/app/
  core/        ApiService, auth (JWT en localStorage, interceptor Bearer, guard),
               interceptor de errores (formato {error:{code,message,details}}),
               MutationService (advertencias/override), diálogos, toasts, formatos
  shared/      modal, badges de estado, pipes de fecha (America/Lima), formulario de persona
  layout/      barra superior y navegación
  features/
    login/         ingreso y usuarios (admin)
    tournaments/   lista, creación y detalle con pestañas: Resumen, Categorías,
                   Inscripciones, Importar Excel, Tatamis, Resultados, Shadow Mode, Auditoría
    bracket/       llave (eliminación directa, round robin, rondas de kata)
    mesa/          mesa de kumite / kata por banderas (pantalla completa)
    persons/       personas (búsqueda, alta, ficha, grados, dojo, fusión)
    dojos/         dojos y sedes
    templates/     plantillas de categorías (solo lectura)
```

## Principios aplicados

- **Advertir, no bloquear.** Toda mutación pasa por `MutationService`. Si la API responde
  `409` con `error.code = "WARNINGS"`, se muestra la lista de advertencias, se pide un
  motivo (mínimo 3 caracteres) y se reenvía la misma petición con
  `override: { reason }`. Un `409 VERSION_CONFLICT` avisa que otra persona modificó el
  registro y recarga los datos.
- **Eventos inmutables en la mesa.** Cada acción de la mesa es un evento con UUID del
  cliente (`crypto.randomUUID()`) y hora del dispositivo. El `POST /matches/{id}/events`
  es idempotente: ante un error de red el evento queda en una cola en memoria y se
  reintenta con el **mismo id** (backoff de 1 a 15 s), con indicador "Sin conexión /
  pendientes". "Deshacer último" envía un evento `annul` que apunta al último evento
  activo.
- **Cronómetro en el cliente.** Se calcula a partir del estado confirmado por el servidor
  y de los eventos de tiempo (inicio, pausa, reanudación, ajuste) aún pendientes.
- **Horas en Lima.** Las fechas con hora llegan en UTC y se muestran en
  `America/Lima`; las fechas de calendario (`YYYY-MM-DD`) no se desplazan.
- **Archivos protegidos.** Los PDF y Excel (llaves, resultados, plantilla de importación) se
  descargan como Blob con el token y se abren con un Object URL.
