# Registro de cambios

Todos los cambios relevantes de Hajime se anotan aquí. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y las versiones,
[Versionado Semántico](https://semver.org/lang/es/). La versión vigente está en
el archivo `VERSION`; cómo publicar una nueva, en `CONTRIBUTING.md`.

Secciones de cada versión: **Agregado**, **Cambiado**, **Corregido**,
**Seguridad**, **Operación** (despliegue, CI e infraestructura).

## [Sin publicar]

### Agregado

- **Manual de usuario** (`docs/manual-de-usuario.md`, por rol, con capturas nuevas en
  `docs/manual/`) y **documento técnico** (`docs/documento-tecnico.md`), también en
  PDF en `docs/pdf/`.

- **Cobros apagados por defecto** (decisión del dueño: por ahora no se cobra).
  Nuevo interruptor `HAJIME_PAYMENTS_ENABLED` (`false` por defecto): todo queda
  permitido como en la marcha blanca aunque `HAJIME_BILLING_MODE=enforced`
  (aviso en el log al arrancar; nunca 402); checkout, prueba gratis,
  cancelación, cargo de Culqi, avisos de las pasarelas, comprobantes,
  reembolsos y cupones responden 404 `PAYMENTS_DISABLED`; no salen
  recordatorios de vencimiento ni correos de cobro. `GET /billing/config`
  informa `payments_enabled` y la interfaz oculta el menú «Pagos», el aviso
  «tu plan vence», «Suscribirse», cupones, pagos, comprobantes y datos
  fiscales; las rutas `/pago/*` llevan al inicio y «Planes» queda
  informativa. La asignación manual de planes del Admin sigue. El código de
  cobros no se borró: se activa con la variable (ver `docs/cobros.md`).

- **Idiomas:** la interfaz también en inglés y portugués de Brasil, con un
  solo build (`@angular/localize` con traducciones cargadas al arrancar). El
  español sigue siendo el idioma por defecto; se elige por la preferencia del
  dispositivo o el idioma del navegador, y se cambia en «Mi cuenta» o al pie
  del inicio de sesión y de las páginas públicas. Fechas, números y montos
  siguen el idioma elegido; los errores de la API se traducen por código con
  el mensaje del servidor como respaldo. `npm run i18n:extract` y
  `npm run i18n:check` (en CI). Correos, PDF y advertencias del backend siguen
  en español. Ver `docs/idiomas.md`.

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

- **Acreditación y pesaje:** pestaña «Acreditación» para la tablet de la
  entrada (buscador grande, «Presente» de un toque, peso con teclado numérico,
  filtros por dojo, pendientes y fuera de peso, contadores por categoría).
  Credenciales imprimibles con QR (`/torneos/:id/credenciales`) y lector QR con
  la cámara (BarcodeDetector). Tolerancia de peso por torneo; fuera de rango se
  advierte y se mueve a la categoría sugerida o se acepta con motivo. Ausentes:
  advertencia y «excluir ausentes» al generar la llave, o walkover si ya existe.
  Check-in obligatorio opcional por torneo, en la verificación previa.

- **Plantillas editables:** nombre y descripción, duplicar, borrar (o archivar
  si un torneo la usó), edición de categorías en tabla e intercambio con Excel;
  cada organización edita las suyas (owner/admin) y las globales solo el Admin.

- **Diplomas y certificados** en PDF: podio (oro, plata, bronce) y
  participación, por categoría, por dojo y por persona (también el apoderado),
  con firma y organizador editables por torneo. Derecho «certificates» del plan
  y aviso opcional por correo (`HAJIME_NOTIFY_DIPLOMAS`).

- **Ranking por temporada y liga:** puntos por lugar, multiplicador por torneo,
  categorías equivalentes entre torneos, «mejor academia», puesto en el perfil
  de la persona y vista pública `/ranking/:temporada` (menores abreviados).

- **Portal público** (`docs/portal-publico.md`): dirección fija `/t/<slug>`
  (del nombre y el año, editable; el enlace secreto `/vivo/<token>` sigue
  funcionando), directorio `/torneos-publicos` con buscador, metadatos para
  compartir, «¿Cuándo pelea?» con buscador por nombre o dojo y favoritos en el
  dispositivo, llave de solo lectura por categoría y pantalla grande del
  coliseo (`/pantalla/<token>/<tatami>` y mosaico `/pantalla/<token>`).

- **Horarios estimados:** hora planificada por tatami, zona horaria y margen
  entre combates del torneo; hora estimada de cada combate en el vivo, en
  «¿Cuándo pelea?», en la cola del tatami y en «Mi tatami». Cubre grupos +
  eliminación y kata por rondas (duración por ejecución configurable,
  `performance_seconds`, 3 min por defecto) y descuenta a los ausentes.

- **Vista previa al compartir:** el backend sirve el `index.html` con título,
  descripción, URL e imagen del torneo, la categoría, el competidor o el
  ranking público en `/t/…`, `/competidor/…` y `/ranking/…`.

- Los nombres del portal público enlazan al perfil `/competidor/<id>`.

- **Actualización en vivo por SSE** (`GET /public/{token}/stream`): un sondeo
  compartido por torneo y proceso, latido cada 15 s, límite de conexiones
  (503 → el navegador sigue con el sondeo). `prueba_carga.py --sse N` mide la
  propagación de un punto.

- **Pruebas de extremo a extremo** con Playwright (`frontend/e2e/`,
  `npm run e2e`) contra el servidor real (API con SQLite temporal sirviendo el
  frontend compilado): ingreso con cambio de clave y recuperación por correo,
  torneo de punta a punta, mesa de kumite en tablet y sin red, importación
  Excel, kata por banderas y por puntaje, vivo público y pantalla grande,
  autoinscripción, acreditación, accesibilidad con axe-core y teléfono sin
  scroll horizontal. Ver «Pruebas de extremo a extremo» en `CONTRIBUTING.md`.

- **Avisos push «te toca pronto»** (Web Push con VAPID, sin Firebase en la
  web): «Te toca en ~3 combates», «¡A tatami!», resultado de cada combate y
  medallas del competidor seguido; para las cuentas, inscripciones revisadas y
  perfiles aprobados. Campana «Avisarme» junto a la estrella en la página
  pública (sin cuenta, vence al terminar el torneo), en «Mis perfiles» y en
  «Mis competidores» (alumno o todo el dojo); preferencias en `/avisos`. Un
  recorrido por torneo tras cada cambio (no por espectador), bandeja
  `notification_outbox` deduplicada con reserva entre procesos, hilo en la API
  y `python -m app.push_worker`. Ver `docs/avisos-push.md`.

### Cambiado

- Frontend formateado con Prettier de una vez; el job `formato` de CI pasa
  a ser obligatorio. `htmlWhitespaceSensitivity: strict` evita que Prettier
  cambie el espacio del texto de las plantillas (alteraría los textos que se
  traducen).

### Corregido

- **CodeQL:** el análisis semanal fallaba al subir los resultados porque el repositorio
  privado no tiene activado Code scanning; ahora los guarda como artefacto de la corrida.
- **App de Android (y iPhone):** en teléfonos con Android 15+ y WebView reciente la
  cabecera quedaba debajo de la barra de estado (la app se dibuja de borde a borde).
  La interfaz reserva el espacio de la barra de estado, la muesca y la barra de
  gestos con `--safe-top`/`--safe-bottom`/`--safe-left`/`--safe-right` en la
  cabecera, la barra lateral, la barra inferior, la mesa, el vivo público, la
  pantalla grande y las páginas sueltas.

- El diálogo «Editar inscripción» decía que no se puede cambiar de categoría con
  llave generada; ahora explica que la persona pasa de una llave a otra con motivo.

- **Mesa sin red:** el marcador se quedaba en el último valor confirmado por el
  servidor aunque el punto ya figurara «pendiente» en el historial (el
  operador podía volver a marcarlo). Ahora muestra también los puntos y los
  «Deshacer» que siguen en la cola, igual que el reloj.

- Contraste insuficiente (axe, *serious*) en el kanji de la navegación lateral
  y en el de HAJIME en la mesa.

- «Nuevo torneo»: si se elegía «Sin plantilla» antes de que llegara la lista
  de plantillas (red lenta), la app la reemplazaba por la plantilla base y el
  torneo se creaba con todas sus categorías.

### Seguridad

- Avisos push: el endpoint de una suscripción debe ser https y de un servicio
  de push conocido (sin POST a URL arbitrarias); cambiarla sin sesión exige su
  secreto `auth`; los avisos abrevian el nombre de los menores y el clic solo
  abre rutas internas.

- De los rivales, quien no es organizador ve solo el nombre abreviado en el
  historial. Los últimos dígitos del documento de un reclamo no se guardan.

- **Cobros con pasarela real** (`HAJIME_PAYMENT_PROVIDER`): Mercado Pago
  (Checkout Pro para pagos únicos y `preapproval` para el mensual automático,
  avisos con firma `x-signature`) y Culqi (Culqi Checkout en el navegador,
  cargo con token, suscripciones con planes de Culqi). El estado siempre se
  consulta a la API de la pasarela; avisos idempotentes; tabla `payments`.
  Pago rechazado o vencido: `past_due` con gracia configurable
  (`HAJIME_BILLING_GRACE_DAYS`). Cancelación por el titular y reembolso por el
  Admin (llamando a la pasarela). Ver `docs/cobros.md`.

- **Comprobantes electrónicos (SUNAT)** detrás de `invoicing.Provider`
  (`HAJIME_INVOICING_PROVIDER`): Nubefact emite factura a la organización con
  RUC y boleta en los demás casos (DNI opcional para Competidor Plus) al
  aprobarse un pago; tabla `invoices` con serie, número, estado y enlaces
  PDF/XML. Datos fiscales en «Organización».

- **Periodo de prueba y cupones:** `plans.trial_days` (30 días para Dojo y
  Organizador), tabla `coupons` (porcentaje o monto, planes, usos, vencimiento,
  solo primer periodo) y el cupón de ejemplo `PRIMER-TORNEO` sembrado
  desactivado.

- **Correos de cobro** por la bandeja de salida con la plantilla de la marca:
  pago recibido (monto, plan, periodo, enlace al comprobante), pago no
  completado, periodo de gracia y «tu plan vence» 7 y 1 días antes, a los
  dueños de la organización o al titular de Competidor Plus. Revisión cada
  hora desde el despachador de correo y `python -m app.billing_reminders`,
  sin repetir avisos.

- **Competidor Plus por persona:** el titular puede ser un perfil (el propio
  o el de un menor a cargo con tutela aprobada); los derechos quedan en esa
  persona.

- **Nota de crédito** automática (SUNAT 07, anulación) al reembolsar un pago
  con boleta o factura emitida, con reserva de número y reintento.

- **Interfaz de cobro:** «Suscribirse» en «Planes» (mensual/anual, cupón),
  pago con Culqi embebido o redirección a Mercado Pago, páginas de retorno
  (`/pago/exito|pendiente|error`), historial de pagos y comprobantes con
  Renovar/Cancelar en «Organización», pantalla «Pagos» del Admin (búsqueda,
  reembolso, comprobantes, cupones) y aviso «tu plan vence en N días» en el
  encabezado. Competidor Plus con el mismo flujo, con la cuenta como titular.

- Ningún dato de tarjeta pasa por el servidor; de las respuestas de la
  pasarela se guarda solo una lista blanca de campos. Secretos de pasarelas y
  de Nubefact solo por variables de entorno (`SecretStr`, nunca en logs).
  Avisos sin sesión pero con firma o autenticación y cuerpo limitado
  (`HAJIME_WEBHOOK_MAX_BYTES`).

### Operación

- CI: job `e2e` (después de `backend` y `frontend`) con Chromium de
  Playwright; un reintento con traza y el reporte como artefacto
  `playwright-report` si falla.

- Migración `0014_pagos`: tablas `payments`, `invoices` y `coupons`; columnas
  opcionales o con valor por defecto en `organizations` (datos fiscales),
  `plans` (`trial_days`) y `subscriptions` (periodo, pasarela, gracia, cupón,
  titular de la boleta). Variables nuevas en `docs/despliegue.md`.

- Migración `0009_organizaciones`: crea la «Organización principal» y le
  asigna todos los torneos existentes antes de volver obligatoria
  `tournaments.organization_id`. Ver `docs/organizaciones-y-planes.md`.

- Migración `0012_checkin_ranking` (acreditación, plantillas archivadas, firma
  de diplomas y tablas `ranking_seasons`/`ranking_entries`; compatible hacia atrás).

- Migración `0013_portal_publico` (columnas nuevas con valor por defecto o
  nulas; los torneos con vivo activo reciben su dirección fija).

- Migración `0015_avisos_push` (tablas nuevas `push_subscriptions`,
  `push_follows` y `notification_outbox`; compatible hacia atrás).

- Dependencias nuevas del backend: `cryptography` y `http-ece` (cifrado
  RFC 8291). Variables `HAJIME_VAPID_*` y `HAJIME_PUSH_*`; las claves se
  generan con `python -m app.seed vapid-keys` (ver `docs/despliegue.md`).

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
