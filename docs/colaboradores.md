# Trabajar en Hajime entre varias personas (y varios Claude)

Guía para quien se suma al repositorio y para el asistente (Claude Code u
otro) que lo ayude. Complementa `CLAUDE.md` (reglas que el asistente lee
solo) y `CONTRIBUTING.md` (proceso técnico).

## Qué necesitas

| Qué | Para qué | Quién lo da |
| --- | --- | --- |
| Colaborador del repo en GitHub con permiso **write** | Clonar, crear ramas, hacer push, abrir PR | El dueño del repo (Settings → Collaborators) |
| Tu cuenta de GitHub conectada a tu Claude | Que tu asistente vea el repo y pueda hacer push por ti | Tú (Claude → Settings → Connectors → GitHub) |
| Nada más | No hacen falta tokens de Fly, Cloudflare, Azure ni secretos: CI construye, prueba y despliega | — |

Si tu asistente dice que no encuentra el repo, revisa que la app de GitHub de
Claude tenga acceso a él (la instala el dueño del repositorio).

## Reglas de convivencia

1. **Una rama por persona y tema**: `<tu-nombre>/<tema>` (por ejemplo
   `maria/mesa-sonidos`). Nunca push a `main` ni a ramas `claude/...` ajenas.
2. **PR a `main`** con descripción en español: qué cambia, por qué y cómo se
   probó. CI debe quedar en verde (backend, frontend, e2e, auditoría, docker).
3. **`CHANGELOG.md`**: anota tu cambio en `## [Sin publicar]` en el mismo PR.
4. **Conflictos**: si `main` avanzó, trae `main` a tu rama (`git merge main`),
   nunca reescribas la historia de una rama compartida.
5. **Migraciones**: compatibles hacia atrás (agregar antes de quitar) y con
   el DDL regenerado; ver «Cambios en la base de datos» en `CONTRIBUTING.md`.
6. **Textos**: todo en español; si agregas textos a la interfaz, corre
   `npm run i18n:extract` y completa `en.json` y `pt-BR.json`.

## Ambientes: cuál tocar y cuál no

| Ambiente | Dónde | Datos | ¿Puedo tocarlo? |
| --- | --- | --- | --- |
| Tu máquina | `docker compose up` o `uvicorn` + `npm start` | Los que quieras (`app.seed demo`, `cargar_demo.py`) | Sí, libremente |
| Pruebas e2e | `npx playwright test` (levanta su propio servidor) | Temporales | Sí |
| **Pruebas en línea** | <https://hajime-test.fly.dev> | **Torneos reales en curso** | Solo leer. No importar, borrar, resembrar ni cambiar categorías sin que el dueño lo pida |
| Producción | (pendiente) | — | No |

CI despliega a pruebas **solo la rama configurada** (`FLY_BRANCH` en las
variables del repo; si no existe, la que dice el job `deploy-fly` en
`.github/workflows/ci.yml`). Tu rama no se despliega hasta que se integra
a esa rama por PR. No cambies `fly.toml`, el job `deploy-fly` ni esa variable
sin coordinar con el dueño.

## Cómo arrancar en tu máquina

```bash
git clone https://github.com/lorboftherin/Hajime-Kumite-App.git && cd Hajime-Kumite-App
git checkout -b <tu-nombre>/<tema>
# Backend
cd backend && python -m venv .venv && source .venv/bin/activate
pip install --require-hashes -r requirements-dev.txt && pip install --no-deps -e .
HAJIME_ADMIN_PASSWORD=admin12345 python -m app.seed admin && python -m app.seed demo
uvicorn app.main:app --reload --port 8000
# Frontend (otra terminal)
cd frontend && npm ci && npm start      # http://localhost:4200 con proxy a :8000
```

Entra con `admin` / `admin12345`. Los datos de demo son ficticios.

## Antes de pedir revisión

```bash
cd backend && ruff check app tests scripts && ruff format --check app tests scripts && pytest -q
HAJIME_DATABASE_URL=sqlite:///ci.db alembic upgrade head && HAJIME_DATABASE_URL=sqlite:///ci.db alembic check
python scripts/exportar_openapi.py --check && python scripts/export_ddl.py
cd ../frontend && npm run lint && npm run i18n:check && npx ng test --watch=false && npx ng build && npm run format:check
```

## Dónde está cada cosa

Ver la tabla «Dónde está cada cosa» de `CLAUDE.md` y el manual de usuario en
`docs/manual-de-usuario.md`. Para entender la mesa y la regla «la app nunca
detiene un torneo», lee primero `docs/documento-maestro-v0.2.md`, sección 6.

## Si tu asistente es Claude Code

Lee `CLAUDE.md` al empezar (lo hace solo). Resumen de lo que no debe hacer sin
que el dueño lo pida: push a `main`, tocar el ambiente de pruebas en línea,
cambiar el despliegue, saltarse una prueba para que CI pase, o quitar
compatibilidad del contrato de la API (`docs/openapi.json`) o de los eventos
en cola de la mesa (`POST /matches/{id}/events`).
