# Hajime — guía para agentes

Plataforma de gestión de torneos de karate (Perú). Backend FastAPI en
`backend/`, frontend Angular 21 + Capacitor en `frontend/`, imagen "todo en
uno" en `Dockerfile`, despliegue en Azure Container Apps + Azure SQL
(`infra/azure/`). Detalle del proceso: `CONTRIBUTING.md`.

## Reglas del repositorio

- **Todo en español:** código nuevo (nombres de funciones de scripts, mensajes),
  comentarios, docs, commits y PR. Respeta el estilo del archivo que tocas.
- **La app nunca detiene un torneo.** La mesa de kumite funciona con red mala:
  cada acción es un evento con UUID del cliente, idempotente, que queda en cola y
  se reintenta con el mismo id. No rompas eso: nada de validaciones que rechacen
  un evento reintentado, ni cambios de contrato en `POST /matches/{id}/events`
  sin compatibilidad con clientes que tengan eventos en cola.
- **Advertir, no bloquear** (`409 WARNINGS` + `override`), eventos inmutables
  (corregir = nuevo evento), auditoría en todo cambio.
- **Base de datos:** todo cambio de modelo lleva migración de Alembic
  compatible hacia atrás (agregar antes de quitar) y el DDL regenerado
  (`sql/001_schema.sql`). Ver «Cambios en la base de datos» en `CONTRIBUTING.md`.
- **Contrato de la API:** si cambian rutas o esquemas, regenera `docs/openapi.json`.
- **Versión:** única en `VERSION`; se cambia con `python scripts/version.py X.Y.Z`,
  nunca a mano en pyproject/package.json. Anota los cambios en `CHANGELOG.md`
  (`## [Sin publicar]`).
- **Dependencias del backend:** rangos en `pyproject.toml`, versiones exactas en
  `backend/requirements*.txt` (`bash scripts/bloquear-dependencias.sh`).
- **Secretos:** nunca en el código ni en los scripts. Datos de prueba siempre
  ficticios; nunca copias de producción en TEST.
- No hagas push a `main`: ramas de trabajo y PR.

## Comandos

```bash
# Backend (cd backend; entorno: python -m venv .venv && source .venv/bin/activate)
pip install --require-hashes -r requirements-dev.txt && pip install --no-deps -e .
pytest -q                                          # ~560 pruebas, ~4 min
pytest -q tests/domain                             # solo dominio (rápidas)
ruff check app tests scripts && ruff format --check app tests scripts
ruff format app tests scripts                      # formatear
HAJIME_DATABASE_URL=sqlite:///ci.db alembic upgrade head && HAJIME_DATABASE_URL=sqlite:///ci.db alembic check
HAJIME_DATABASE_URL=sqlite:///dev.db alembic revision --autogenerate -m "descripción"
python scripts/export_ddl.py                       # sql/001_schema.sql
python scripts/exportar_openapi.py [--check]       # docs/openapi.json
HAJIME_ADMIN_PASSWORD=admin12345 python -m app.seed admin && python -m app.seed demo
uvicorn app.main:app --reload --port 8000

# Frontend (cd frontend)
npm ci
npm run lint                                       # ESLint (angular-eslint)
npx ng test --watch=false                          # Vitest
npm run format:check                               # Prettier (npm run format para aplicar)
npx ng build                                       # producción; build:mobile para Capacitor
npm start                                          # :4200 con proxy a :8000

# Raíz
python scripts/version.py --check
shellcheck -x -P SCRIPTDIR infra/azure/*.sh scripts/*.sh
docker build -t hajime:local . && bash scripts/humo-contenedor.sh hajime:local
```

## Checklist antes de push

1. Backend: ruff (check + format), pytest, `alembic check`, DDL y OpenAPI al día.
2. Frontend: lint, `ng test`, build; Prettier en los archivos que tocaste.
3. Migración nueva → compatible hacia atrás y probada desde una base con datos.
4. Si tocaste la mesa: sigue funcionando sin red (eventos en cola, mismo id).
5. `CHANGELOG.md` actualizado; commit en español que explica el porqué.

## Dónde está cada cosa

| Qué | Dónde |
| --- | --- |
| Lógica deportiva pura (sin BD) | `backend/app/domain/` |
| Servicios, routers, modelos, migraciones | `backend/app/{services,api,db,migrations}/` |
| Mesa de kumite / kata | `frontend/src/app/features/mesa/` |
| CI, release, producción, CodeQL | `.github/workflows/` |
| Scripts de Azure (crear, promover, rollback, respaldos) | `infra/azure/` |
| Despliegue y acciones manuales del dueño | `docs/despliegue-azure.md`, `docs/acciones-del-duenio.md` |
