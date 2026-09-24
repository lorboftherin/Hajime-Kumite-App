# Hajime — API (FastAPI)

## Ejecutar en local

```bash
cd backend
python -m venv .venv && source .venv/bin/activate   # o: uv venv && uv pip install -e ".[dev]"
pip install -e ".[dev]"
python -m app.seed admin --password admin12345      # crea el admin (SQLite por defecto)
python -m app.seed demo                              # plantilla borrador + torneo mock ficticio
uvicorn app.main:app --reload --port 8000
```

- Documentación interactiva: http://localhost:8000/docs
- Todas las rutas están bajo `/api/v1`.

## Tests y calidad

```bash
pytest -q                 # dominio + API (guion del torneo mock)
ruff check app tests && ruff format --check app tests
python scripts/export_ddl.py   # regenera sql/001_schema.sql tras cambiar modelos
```

## Estructura

| Carpeta | Contenido |
| --- | --- |
| `app/domain/` | Lógica deportiva pura, sin BD: llaves, marcador de kumite, kata, categorías, identidad |
| `app/services/` | Orquestación: lee filas, llama al dominio y guarda lo que el dominio decidió; auditoría |
| `app/api/` | Routers, esquemas Pydantic, errores uniformes, dependencias (auth) |
| `app/db/` | Modelos SQLAlchemy (SQL Server / SQLite) |
| `tests/domain/` | Tests rápidos del dominio (llaves de 2 a 64, separación por dojo, reproducibilidad, eventos, kata) |
| `tests/api/` | Guion del torneo mock de punta a punta |

## Convenciones de la API

- **Errores:** `{"error": {"code", "message", "details"}}`.
- **Advertencias de negocio:** HTTP 409 con `code: "WARNINGS"` y `details.warnings`. Para aceptarlas, reenviar la misma petición con `"override": {"reason": "..."}`; cada una queda registrada en `rule_overrides`.
- **Concurrencia:** las entidades editables llevan `version`; si no coincide, la API responde 409 `VERSION_CONFLICT`.
- **Eventos de combate:** `POST /matches/{id}/events` con `id` (UUID del dispositivo) y `at` (hora del dispositivo). Reenviar el mismo `id` responde 200 sin duplicar el evento (idempotencia).
- **Correcciones:** nunca se edita un evento. Para deshacer, se agrega un evento `annul` que apunta al anterior; para cambiar el ganador, se agrega un nuevo `finish`.
