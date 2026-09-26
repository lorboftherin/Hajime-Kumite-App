# Cómo contribuir a Hajime

Guía corta para trabajar en el repositorio sin romper un torneo. Todo (código,
comentarios, documentación, commits) va **en español**.

## Ramas y pull requests

- **`main` está protegida:** solo recibe cambios por pull request con CI en
  verde. Lo que está en `main` se publica solo en el ambiente de pruebas de
  Azure (job `deploy-test`) y es lo único que se puede promover a producción.
- **Ramas de trabajo** cortas, una por tema, desde `main`: `feature/mesa-kata`,
  `fix/reloj-anulacion`, `ops/respaldos` (las de los agentes empiezan con
  `claude/`). Se abren como PR contra `main` con la plantilla
  (`.github/pull_request_template.md`).
- Se integra con **squash** (un commit por PR, con el título del PR) salvo que
  la historia de la rama valga la pena.
- `CODEOWNERS` pide la revisión del dueño en cada PR.

## Preparar el entorno

Requisitos: Python 3.12 (3.11 funciona), Node 22, Docker (opcional), y
[uv](https://docs.astral.sh/uv/) si vas a cambiar dependencias del backend.

```bash
# Backend
cd backend
python -m venv .venv && source .venv/bin/activate
pip install --require-hashes -r requirements-dev.txt   # versiones exactas, como en CI
pip install --no-deps -e .
HAJIME_ADMIN_PASSWORD=admin12345 python -m app.seed admin
python -m app.seed demo                                # torneo mock ficticio
uvicorn app.main:app --reload --port 8000              # http://localhost:8000/docs

# Frontend (otra terminal)
cd frontend
npm ci
npm start                                              # http://localhost:4200 (proxy a :8000)

# Todo junto, como en producción
HAJIME_ADMIN_PASSWORD='una-clave' docker compose up -d --build   # http://localhost:8000
```

## Antes de subir un cambio

Lo mismo que corre CI (`.github/workflows/ci.yml`):

```bash
# Backend (en backend/)
ruff check app tests scripts && ruff format --check app tests scripts
pytest -q
HAJIME_DATABASE_URL=sqlite:///ci.db alembic upgrade head && HAJIME_DATABASE_URL=sqlite:///ci.db alembic check; rm -f ci.db
python scripts/export_ddl.py && git diff --exit-code ../sql/001_schema.sql
python scripts/exportar_openapi.py --check

# Frontend (en frontend/)
npm run lint
npx ng test --watch=false
npm run format:check
npx ng build
npm run e2e                                  # extremo a extremo (ver abajo)

# Raíz
python scripts/version.py --check
shellcheck -x -P SCRIPTDIR infra/azure/*.sh scripts/*.sh   # si tocaste scripts
bash scripts/humo-contenedor.sh "$(docker build -q .)"     # si tocaste Dockerfile o el arranque
```

## Pruebas de extremo a extremo

Playwright en `frontend/e2e/` (configuración en `frontend/playwright.config.ts`)
contra el servidor real: `e2e/servidor.sh` prepara una base SQLite en una
carpeta temporal (`python -m app.prepare`) y levanta uvicorn con un proceso en
un puerto libre, sirviendo el frontend compilado en la misma URL (como la
imagen «todo en uno»). `e2e/global-setup.ts` siembra por la API un organizador
y una plantilla pequeña y deja las credenciales en `estado.json` de esa
carpeta; cada escenario crea sus propios datos con nombres únicos, así que
corren en paralelo y en cualquier orden. CI las corre en el job `e2e`.

```bash
# Requisitos: el backend instalado (backend/.venv, como arriba) y npm ci.
cd frontend
npx playwright install chromium        # una vez (en Linux: --with-deps)
npm run e2e                            # toda la suite (~1 min)
npm run e2e -- mesa-sin-red            # un archivo
npm run e2e -- -g "kata por banderas"  # por nombre
npx tsc -p e2e                         # tipos de las pruebas
```

- **Frontend compilado:** si `dist/hajime/browser` no existe o hay cambios en
  `src/` más nuevos, `servidor.sh` corre `npx ng build` antes de arrancar
  (`HAJIME_E2E_BUILD=1` fuerza la compilación).
- **Depurar:** `npm run e2e -- --ui` (modo interactivo: cada paso con su
  captura del DOM), `--headed` para ver el navegador, `--debug` para ir paso a
  paso con el inspector.
- **Trazas:** en CI cada prueba que falla se reintenta una vez y el reintento
  graba la traza (`trace: 'on-first-retry'`); el reporte queda en el artefacto
  `playwright-report` de la corrida, junto con el log del servidor. Localmente: `npm run e2e -- --trace on`,
  luego `npx playwright show-report` o
  `npx playwright show-trace test-results/<prueba>/trace.zip`.
- **Correo:** el servidor usa el proveedor `console`; las pruebas leen los
  enlaces (recuperar contraseña) del log `servidor.log` de la carpeta temporal.
- **Variables:** `HAJIME_E2E_PYTHON` (intérprete con el backend; por defecto
  `backend/.venv/bin/python` o `python`), `HAJIME_E2E_CHROMIUM` (otro Chromium
  si el de la versión de Playwright no está instalado), `HAJIME_E2E_PORT` y
  `HAJIME_E2E_DIR` (puerto y carpeta fijos; la carpeta temporal por defecto se
  borra al terminar, una fijada a mano se conserva con la base y el log).
- **Selectores:** por rol y texto visibles (como los ve quien usa la app o un
  lector de pantalla); `data-testid` solo donde no hay texto ni rol estable
  (los puntos de la pantalla grande).
- **Esperas:** nunca pausas fijas. `expect(...)` reintenta hasta cumplirse y,
  para el servidor, `expect.poll(() => api.get(...))`.
- **Accesibilidad:** `accesibilidad.e2e.ts` pasa axe-core (reglas WCAG 2.x A/AA
  y buenas prácticas) por ingreso, torneos, detalle, mesa, vivo y pantalla
  grande; falla con violaciones *serious* o *critical*. Pendientes conocidas,
  de impacto *moderate*: sin región `main` en el ingreso y en el vivo público
  (`landmark-one-main`, `region`), saltos de nivel de encabezado en las tarjetas
  de torneos y en el Resumen (`heading-order`) y la mesa sin `h1`
  (`page-has-heading-one`).

## Cambios en la base de datos

El esquema vive en los modelos (`backend/app/db/models.py`) y cada cambio lleva
**una migración de Alembic** en `backend/app/migrations/versions/`:

```bash
cd backend
HAJIME_DATABASE_URL=sqlite:///dev.db alembic upgrade head            # base al día
HAJIME_DATABASE_URL=sqlite:///dev.db alembic revision --autogenerate -m "descripción en español"
```

1. Renombra el archivo al estilo existente (`0005_descripcion_corta.py`) y
   ajusta `revision`/`down_revision` a `0005`/`0004`.
2. Revisa el código generado: SQLite necesita `op.batch_alter_table` para
   cambiar columnas; los datos existentes necesitan valores por defecto.
3. **Compatible hacia atrás:** en producción la migración corre antes de que la
   nueva versión reciba tráfico y un rollback vuelve la app pero no la base.
   Agregar antes de quitar: columna nueva con valor por defecto → versión que
   la usa → recién en otra versión se borra lo viejo.
4. Regenera los archivos derivados y súbelos en el mismo PR:
   ```bash
   python scripts/export_ddl.py          # sql/001_schema.sql (SQL Server / Azure SQL)
   python scripts/exportar_openapi.py    # docs/openapi.json, si cambió la API
   ```
5. `pytest -q` incluye `tests/test_migrations.py` (las migraciones aplicadas
   desde cero dejan exactamente el esquema de los modelos) y CI corre además
   `alembic check`.

Si cambiaste rutas o esquemas de la API, regenera `docs/openapi.json` aunque no
haya migración: CI falla si no está al día.

## Dependencias

- **Backend:** los rangos van en `backend/pyproject.toml`; las versiones exactas
  (con hashes) en `backend/requirements*.txt`, generadas con
  `bash scripts/bloquear-dependencias.sh` (`--upgrade` para subir todo). La
  imagen y CI instalan solo desde esos archivos.
- **Frontend:** `npm install paquete` actualiza `package-lock.json`; súbelo.
- Dependabot abre PR semanales (lunes); revisa el CHANGELOG del paquete antes de
  aprobar las de versión mayor.

## Commits

- En español, en imperativo o descriptivo, como la historia existente:
  `Mesa: vibración al terminar el tiempo`, `Azure: respaldos antes del torneo`.
  Prefijo con el área cuando ayuda (`Mesa:`, `API:`, `Frontend:`, `Azure:`, `CI:`).
- Primera línea de 72 caracteres como máximo; en el cuerpo, **por qué** y lo que
  no es obvio.
- Un commit = un cambio coherente que pasa las pruebas.

## Versiones y releases

La versión única está en `VERSION` ([SemVer](https://semver.org/lang/es/)):
mayor para cambios que rompen datos o la API pública, menor para funciones
nuevas, parche para correcciones.

1. Anota los cambios en `CHANGELOG.md` bajo `## [Sin publicar]` en cada PR.
2. Para publicar: en un PR, `python scripts/version.py 0.3.0` (actualiza
   `VERSION`, `backend/pyproject.toml` y `frontend/package.json`), mueve las
   notas de `[Sin publicar]` a `## [0.3.0] - AAAA-MM-DD` y agrega el enlace al
   final del archivo.
3. Con el PR integrado en `main`: `git tag v0.3.0 && git push origin v0.3.0`.
   El workflow **Release** publica las imágenes `:0.3.0` y `:0.3.0-azure`, el
   APK y el Release de GitHub con esas notas.
4. Producción: Actions → **Desplegar a producción** → versión `0.3.0` (pide
   aprobación). Ver `docs/despliegue-azure.md`.
