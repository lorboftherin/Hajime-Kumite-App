# Registro de cambios

Todos los cambios relevantes de Hajime se anotan aquí. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y las versiones,
[Versionado Semántico](https://semver.org/lang/es/). La versión vigente está en
el archivo `VERSION`; cómo publicar una nueva, en `CONTRIBUTING.md`.

Secciones de cada versión: **Agregado**, **Cambiado**, **Corregido**,
**Seguridad**, **Operación** (despliegue, CI e infraestructura).

## [Sin publicar]

### Agregado

- **Correo transaccional** con bandeja de salida en la base (`outbox_emails`),
  reintentos con espera creciente, reserva entre procesos y proveedores
  `console`, `smtp` (STARTTLS) y `acs` (Azure Communication Services por REST).
  Hilo despachador en la API y `python -m app.mail_worker` para un Job.
- **Correo en las cuentas:** recuperación de contraseña («¿Olvidaste tu
  contraseña?», enlace de un solo uso por 1 h que cierra todas las sesiones),
  verificación del correo, correo en «Mi cuenta» y en Usuarios; se entra
  también con el correo.
- **Cuentas de competidor** (`HAJIME_OPEN_SIGNUP`): registro abierto, reclamo
  del propio perfil o del de un hijo o hija, revisión por el dojo u
  organizador, tutela con consentimiento del apoderado, «Mis perfiles» con
  historial, estadísticas e insignias.
- **Perfil público** del competidor en `/competidor/<id>` sin datos sensibles y
  página de **Privacidad** (texto provisional).
- **Avisos por correo** al sensei cuando se revisan sus inscripciones (aprobadas
  y rechazadas con motivo) y al dojo cuando llega una solicitud de perfil. El
  administrador del dojo ve el historial de sus competidores; la persona y su
  apoderado ven la hoja de sus combates.
- **Organizaciones (multi-organizador):** cada torneo pertenece a una liga,
  dojo u organizador; owner/admin administran todos sus torneos y member los
  lee. Página «Organización» (datos, miembros, plan) y selector al crear un
  torneo. Rol con ámbito «organización».
- **Planes y derechos verificados en la API:** tablas `plans` y
  `subscriptions`; con `HAJIME_BILLING_MODE=enforced` las funciones de pago
  responden 402 `PLAN_REQUIRED` (crear torneos, varios tatamis, overlay,
  Shadow Mode, importar Excel, autoinscripción). En marcha blanca (por
  defecto) todo está permitido. Suscripciones manuales del Admin, página
  «Planes» e interfaz `payments.Provider` con el proveedor manual.
- **Autoinscripción por dojo:** el organizador abre la inscripción en línea y
  reparte enlaces de invitación; el sensei (admin de dojo) gestiona «Mis
  competidores» y los inscribe; las inscripciones quedan pendientes hasta que
  el organizador las aprueba o rechaza en lote (pestaña «Solicitudes»).

### Seguridad

- De los rivales, quien no es organizador ve solo el nombre abreviado en el
  historial. Los últimos dígitos del documento de un reclamo no se guardan.

### Operación

- Migración `0009_organizaciones`: crea la «Organización principal» y le
  asigna todos los torneos existentes antes de volver obligatoria
  `tournaments.organization_id`. Ver `docs/organizaciones-y-planes.md`.

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
