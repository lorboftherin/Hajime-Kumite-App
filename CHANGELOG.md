# Registro de cambios

Todos los cambios relevantes de Hajime se anotan aquí. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y las versiones,
[Versionado Semántico](https://semver.org/lang/es/). La versión vigente está en
el archivo `VERSION`; cómo publicar una nueva, en `CONTRIBUTING.md`.

Secciones de cada versión: **Agregado**, **Cambiado**, **Corregido**,
**Seguridad**, **Operación** (despliegue, CI e infraestructura).

## [Sin publicar]

### Agregado

- **Portal público** (`docs/portal-publico.md`): dirección fija `/t/<slug>`
  (del nombre y el año, editable; el enlace secreto `/vivo/<token>` sigue
  funcionando), directorio `/torneos-publicos` con buscador, metadatos para
  compartir, «¿Cuándo pelea?» con buscador por nombre o dojo y favoritos en el
  dispositivo, llave de solo lectura por categoría y pantalla grande del
  coliseo (`/pantalla/<token>/<tatami>` y mosaico `/pantalla/<token>`).
- **Horarios estimados:** hora planificada por tatami, zona horaria y margen
  entre combates del torneo; hora estimada de cada combate en el vivo, en
  «¿Cuándo pelea?», en la cola del tatami y en «Mi tatami».
- **Actualización en vivo por SSE** (`GET /public/{token}/stream`): un sondeo
  compartido por torneo y proceso, latido cada 15 s, límite de conexiones
  (503 → el navegador sigue con el sondeo). `prueba_carga.py --sse N` mide la
  propagación de un punto.

### Operación

- Migración `0009_portal_publico` (columnas nuevas con valor por defecto o
  nulas; los torneos con vivo activo reciben su dirección fija).

## [0.2.0] - 2026-09-26

Primera versión numerada: reúne el MVP completo usado en el torneo mock y en
pruebas de campo.

### Agregado

- **Torneos:** categorías desde plantilla, inscripciones, llaves de 2 a 64 con
  separación por dojo, kumite individual y por equipos (con hikiwake), kata,
  resultados, podio y medallero.
- **Mesa de kumite** a prueba de red lenta y cortes (cola local, eventos
  idempotentes), escenario «Yoru» de alto contraste, sugerencia de ganador si el
  tiempo terminara ahora, versión para celular en una sola pantalla con
  vibración y pantalla siempre encendida.
- **Varios tatamis** con varios operadores, árbitros y senseis (MVP-3); planilla
  de mesa imprimible y numeración de combates por tatami (Shadow Mode).
- **Estadísticas, premios y seguimiento en vivo público** compartido entre
  espectadores; historial deportivo por persona.
- **Cuentas y roles por ámbito**, cambio de contraseña obligatorio,
  administración de usuarios, consentimientos y anonimización (Ley 29733),
  borrar la propia cuenta.
- **Diseño «Dō»:** paleta de pigmentos, ensō aka/ao, navegación con kanji, PDF
  con la marca; guía visual con capturas.
- **App instalable (PWA)** con servidor configurable y **app de Android** con
  Capacitor (APK de prueba en cada cambio).
- Datos de demostración vía la API y prueba de carga contra un servidor real.

### Cambiado

- Instalación de un solo contenedor (interfaz + API) con SQLite en WAL, o SQL
  Server / Azure SQL con la imagen `-azure`.
- Servidor con pocos hilos por proceso y dos procesos por contenedor; más
  conexiones a la base para muchos usuarios a la vez.

### Corregido

- Reloj al anular puntos, mayoría en banderas, medallas empatadas.
- Filtros booleanos en SQL Server; podio de equipos guardado una sola vez.

### Seguridad

- Endurecimiento básico de la API y roles por ámbito (revisión v0.2,
  `docs/revision-v0.2.md`).
- Dependencias del backend fijadas con hashes (`backend/requirements*.txt`);
  pip-audit, npm audit, Trivy y CodeQL en CI; Dependabot semanal.

### Operación

- Despliegue en Azure Container Apps + Azure SQL con scripts idempotentes
  (`infra/azure/`): no rotan secretos ni recrean la app, usuario SQL con
  permisos mínimos, job de migraciones, sondas de salud, respaldos `.bacpac`
  y retención semanal larga en producción.
- Promoción a producción manual y con aprobación (`deploy-prod.yml`) de la
  imagen ya probada en pruebas, y rollback a la revisión anterior.
- Versión única en `VERSION`, releases por etiqueta `v*` con imagen y APK.
- CI con permisos mínimos, acciones fijadas por SHA, caché de Docker, ESLint y
  pruebas del frontend, y contrato OpenAPI regenerado y verificado.

[Sin publicar]: https://github.com/lorboftherin/Hajime-Kumite-App/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/lorboftherin/Hajime-Kumite-App/releases/tag/v0.2.0
