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
| Frontend | Angular 21 (SPA, lista para PWA; requiere Node 22) | [`frontend/`](frontend/) |
| API | FastAPI, `/api/v1`, OpenAPI en `/docs` | [`backend/`](backend/) |
| Dominio | Python puro, sin BD (llaves, marcador, kata, reglas) | [`backend/app/domain/`](backend/app/domain/) |
| Persistencia | SQL Server / Azure SQL (SQLite en desarrollo) | [`sql/`](sql/) |

## Probar la app (un solo comando)

Con [Docker](https://www.docker.com/products/docker-desktop/) instalado:

```bash
HAJIME_ADMIN_PASSWORD='una-clave-segura' docker compose up -d --build
```

Abrir <http://localhost:8000> y entrar con `admin` y esa clave. La plantilla
base de categorías se carga sola. Para el primer torneo mock seguir
[`docs/guia-prueba.md`](docs/guia-prueba.md) (instalación, roles del equipo,
guion de casos difíciles y comparación con el papel).

La imagen ya compilada se publica en cada cambio en
`ghcr.io/lorboftherin/hajime-kumite-app` (ver la guía).

## Desarrollo

```bash
# API
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
HAJIME_ADMIN_PASSWORD=admin12345 python -m app.seed admin
python -m app.seed demo            # torneo mock con datos ficticios (solo DEV/TEST)
uvicorn app.main:app --reload --port 8000

# Frontend (en otra terminal)
cd frontend
npm install
npm start                          # http://localhost:4200 (proxy de /api hacia :8000)
```

Capturas: [`docs/screenshots/`](docs/screenshots/).

## Estado del MVP

| Incremento | Contenido | Estado |
| --- | --- | --- |
| MVP-1 | Torneo, dojos, personas (duplicados y fusión), plantilla y categorías, inscripciones e importación Excel, fusión de categorías, llaves con separación por dojo, edición e impresión de llaves, mesa de kumite, resultados | ✅ API + UI |
| MVP-2 | Kata (banderas y puntuación en ronda única), final directa, round robin, terceros lugares configurables, medallero, reapertura auditada, reporte Shadow Mode | ✅ API + UI |
| MVP-3 | Historial de competidor y dojo en pantalla | ✅ API + UI |
| MVP-3 | Equipos temporales (kata y kumite): inscripción con titulares y suplentes, enfrentamientos por equipos con alineación, hikiwake, desempate por puntos o combate extra, historial de cada integrante | ✅ API + UI |
| MVP-3 | Rol Operador de Mesa por torneo; control de versiones y eventos idempotentes para varias mesas a la vez | ✅ API + UI |
| Extra | Ideas de CricHeroes: hoja del combate con línea de tiempo, perfil deportivo con insignias, líderes y premios automáticos, tarjeta para compartir, seguimiento en vivo público y overlay para transmisiones | ✅ API + UI |
| MVP-3 | Operador limitado a un tatami, aviso de dos tablets en el mismo combate, vista de todos los tatamis (avance, quién opera, árbitros), árbitros opcionales (registro, asignación, juez de cada bandera o nota), rol sensei e importación de árbitros y senseis por Excel | ✅ API + UI |

## Principios que guían el código

- **La app nunca detiene un torneo:** todo error deja seguir con papel; nada crítico depende de la app en el MVP.
- **Advertir, no bloquear:** las reglas devuelven advertencias (`409 WARNINGS`) que se aceptan con un motivo, y el override queda registrado. Solo se bloquea lo que corrompe datos.
- **Los eventos son la fuente de verdad:** el marcador se calcula a partir de eventos inmutables e idempotentes. Corregir es agregar un evento.
- **Todo se puede corregir, con auditoría:** quién, cuándo, antes, después y por qué.
