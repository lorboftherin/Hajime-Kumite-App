# Hajime — Plataforma de gestión de torneos de karate (Perú)

Organiza torneos de karate, registra sus resultados y construye un historial
deportivo confiable. Nace para operarse en **Shadow Mode**: el torneo sigue con
papel y cronómetro, y la app registra lo mismo en paralelo.

- Especificación: [`docs/documento-maestro-v0.2.md`](docs/documento-maestro-v0.2.md)
- Revisión técnica y decisiones tomadas: [`docs/revision-v0.2.md`](docs/revision-v0.2.md)
- Despliegue: [`docs/despliegue.md`](docs/despliegue.md)

## Stack

| Capa | Tecnología | Carpeta |
| --- | --- | --- |
| Frontend | Angular (SPA, lista para PWA) | [`frontend/`](frontend/) |
| API | FastAPI, `/api/v1`, OpenAPI en `/docs` | [`backend/`](backend/) |
| Dominio | Python puro, sin BD (llaves, marcador, kata, reglas) | [`backend/app/domain/`](backend/app/domain/) |
| Persistencia | SQL Server / Azure SQL (SQLite en desarrollo) | [`sql/`](sql/) |

## Inicio rápido

```bash
# API
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
python -m app.seed admin --password admin12345
python -m app.seed demo            # plantilla borrador + torneo mock con datos ficticios
uvicorn app.main:app --reload --port 8000

# Frontend (en otra terminal)
cd frontend
npm install
npm start                          # http://localhost:4200 (proxy de /api hacia :8000)
```

Usuario: `admin` / `admin12345` (solo para desarrollo).

## Estado del MVP

| Incremento | Contenido | Estado |
| --- | --- | --- |
| MVP-1 | Torneo, dojos, personas (duplicados y fusión), plantilla y categorías, inscripciones e importación Excel, fusión de categorías, llaves con separación por dojo, edición e impresión de llaves, mesa de kumite, resultados | ✅ API + UI |
| MVP-2 | Kata (banderas y puntuación en ronda única), final directa, round robin, terceros lugares configurables, medallero, reapertura auditada, reporte Shadow Mode | ✅ API + UI |
| MVP-3 | Historial de competidor y dojo | ✅ API |
| MVP-3 | Equipos temporales, registro de árbitros, operadores concurrentes por tatami (rol Operador de Mesa) | ⏳ Pendiente |

## Principios que guían el código

- **La app nunca detiene un torneo:** todo error deja seguir con papel; nada crítico depende de la app en el MVP.
- **Advertir, no bloquear:** las reglas devuelven advertencias (`409 WARNINGS`) que se aceptan con un motivo, y el override queda registrado. Solo se bloquea lo que corrompe datos.
- **Los eventos son la fuente de verdad:** el marcador se calcula a partir de eventos inmutables e idempotentes. Corregir es agregar un evento.
- **Todo se puede corregir, con auditoría:** quién, cuándo, antes, después y por qué.
