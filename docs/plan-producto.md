# Plan de producto: de MVP a producto completo

Análisis del 26/09/2026 sobre la rama `claude/peaceful-wright-mqncfd` (commit
`21a8d37`). Cinco revisiones independientes (experiencia de uso, backend y
seguridad, lógica deportiva, madurez técnica, competencia) más la prueba de
carga contra Azure del mismo día. Los hallazgos con más impacto se verificaron
a mano en el código o reproduciendo el fallo; se indica cuándo.

## 0. Estado al 27/09/2026: el plan está construido

Todo el plan de la sección 4 se implementó en la rama
`claude/peaceful-wright-mqncfd` durante el 26 y 27/09, con CI completo en verde
(backend, frontend, contratos, auditoría, Docker con prueba de humo de 2
procesos y Trivy, Android y extremo a extremo). Lo que falta ya no es código:
son decisiones y acciones del dueño, listadas al final de esta sección y, con
el paso a paso, en `docs/acciones-del-duenio.md`.

| Horizonte | Estado | Dónde leer más |
| --- | --- | --- |
| 0: arranque, vivo, login, errores | Hecho. Arranque único con candado entre procesos; instantánea del vivo compartida en base (346 → 8 consultas; mesa p95 1,1 s → 71 ms en local con 300 espectadores); bloqueo de login en base con IP real; errores JSON con `request_id`; `/health/ready` | `docs/despliegue.md`, `docs/pruebas-carga.md` |
| 1: operación del día | Hecho. Sonido de fin de tiempo, «Mi tatami», dos tablets con «Tomar la mesa», cierre en cola sin red, retiro con walkover o regenerar, edición de inscripción y categoría, cola de tatamis editable, «listo para iniciar», importación corregible en pantalla, accesibilidad | `docs/guia-prueba.md` |
| 1: confianza | Hecho. Logs JSON, Azure Monitor opcional, CI con permisos mínimos y acciones fijadas, lockfile con hashes, Dependabot, pip-audit, npm audit, Trivy, CodeQL, versión 0.2.0 con CHANGELOG, release, despliegue a producción con aprobación, rollback, respaldos y ensayo de restauración | `CONTRIBUTING.md`, `docs/despliegue-azure.md` |
| 1: seguridad | Hecho. Lecturas con ámbito por torneo y organización, sesiones de 60 min con renovación revocable, rotación de secreto sin cortar sesiones, anonimización completa, purga de importaciones, registro de lecturas sensibles, cabeceras | `docs/revision-v0.2.md` §5.3 |
| 1: e2e | Hecho. 15 pruebas Playwright (organizador, mesa, mesa sin red, importación, kata, público, autoinscripción, acreditación, accesibilidad, móvil); encontraron y corrigieron 3 fallos reales | `CONTRIBUTING.md` |
| 2: organizaciones y planes | Hecho. Organizaciones con miembros, planes con derechos verificados en la API, marcha blanca por defecto | `docs/organizaciones-y-planes.md` |
| 2: correo y cuentas | Hecho. Correo transaccional con outbox, recuperación de contraseña, registro abierto (apagado por defecto), reclamo de perfil de adulto y de menor, perfil público | `docs/cuentas-y-correo.md` |
| 2: autoinscripción por dojo | Hecho. Invitación por enlace, portal del sensei, aprobación en lote | `docs/organizaciones-y-planes.md` |
| 2: portal público y horarios | Hecho. Dirección fija `/t/<slug>`, directorio, «¿cuándo pelea?», favoritos, llaves públicas, horas estimadas, pantalla grande y mosaico, SSE, vista previa al compartir | `docs/portal-publico.md` |
| 2: acreditación, plantillas, kata, reglas | Hecho. Check-in, pesaje, credenciales con QR; plantillas editables; reglas configurables (faltas, senshu, punto de oro, kata WKF 2+2 y 70/30, rondas, grupos + eliminación, edad por año, división de categorías, inscripción tardía en llave) | `docs/acreditacion-y-pesaje.md`, `docs/reglas-configurables.md` |
| 3: cobros | Hecho. Mercado Pago y Culqi, comprobantes con Nubefact y nota de crédito, prueba gratis, cupones, recibos y recordatorios por correo, Plus pagado por el tutor | `docs/cobros.md` |
| 3: avisos, ranking, diplomas | Hecho. Web Push («te toca», resultados, medallas), ranking por temporada y de dojos, diplomas de podio y participación | `docs/avisos-push.md`, `docs/ranking.md` |
| 3: idiomas | En integración: inglés y portugués de Brasil con un solo build | `docs/idiomas.md` |

### Lo que no se hizo y por qué

- **Prueba de carga contra Azure:** el ambiente de pruebas sigue con la imagen vieja hasta que se cree `main` y se conecte la publicación automática. Hay que repetir `prueba_carga.py` (también con `--sse`) después del primer despliegue.
- **Doble eliminación:** fuera de alcance para torneos locales (documentado en `docs/reglas-configurables.md`).
- **Nota de crédito parcial, Izipay y avisos nativos en Android (FCM):** quedan preparados y documentados, sin activar.
- **Rutas de suscripción de Culqi:** hay que verificarlas en su sandbox antes de cobrar mensualidades con Culqi.
- **Revisión visual en celulares reales:** las pantallas pasaron build, pruebas unitarias, e2e con Chromium y axe, pero nadie las abrió aún en una tablet del coliseo.

### Lo que depende de ti

1. Crear y proteger `main` desde esta rama, y apuntar la publicación automática a `main` (`docs/acciones-del-duenio.md`, GitHub y Azure).
2. Decidir el reglamento de referencia (§5, punto 1); todas las reglas ya son configurables y sus valores por defecto están en `docs/reglas-configurables.md`.
3. Asesoría legal (Ley 29733) antes de abrir el registro de competidores y de mostrar perfiles de menores.
4. Precios finales, pasarela y proveedor de comprobantes antes de pasar a `HAJIME_BILLING_MODE=enforced`.
5. Claves VAPID y correo (SMTP o Azure Communication Services) en cada ambiente.
6. Producción en Azure: tamaño de la base y `crear-ambiente.sh prod`.

## 1. Veredicto en una página

Hajime ya es un producto operativo serio para un torneo local: el núcleo
deportivo (llaves con separación por dojo, tres reglas de tercer lugar, mesa de
kumite con cola offline e idempotencia, kata por banderas, equipos, Shadow
Mode, auditoría) está bien resuelto y cubierto por 359 pruebas que pasan. La
mesa de kumite es la pantalla más madura y la que mejor aguanta una red mala.

Lo que separa al MVP de un producto completo está en cuatro capas, en este
orden de urgencia:

1. **Confiabilidad en producción.** Hay tres fallos que pueden tumbar un torneo
   real y ninguno es deportivo: el contenedor no arranca de forma fiable con dos
   procesos sobre una base nueva (reproducido, 2 de 3 intentos), el vivo
   público satura las copias de Azure con 200 espectadores (medido: mesa con
   p95 de 20–28 s) y cualquiera puede bloquear la cuenta de una mesa durante 5
   minutos con cinco intentos de login fallidos.
2. **Seguridad de datos antes de abrir cuentas.** Toda lectura de la API es
   global: cualquier cuenta ve inscripciones (edad, grado, peso) de todos los
   torneos y la auditoría de otros organizadores. Hoy no importa porque solo
   hay cuentas internas; será un problema el día que un sensei tenga usuario.
3. **Lo que un organizador hace "el día del torneo" y la app todavía no.**
   Inscribir tarde en una llave generada, retirar con walkover desde la
   pantalla, sobrecupo, kata por puntaje con una mesa de verdad, cola del
   tatami editable, fin de tiempo audible, y que un padre encuentre a su hijo.
4. **La plataforma del modelo de negocio.** Organizaciones, cuentas de
   competidor con correo, autoinscripción por dojo, cobros. Tu roadmap ya lo
   lista; aquí se ordena y se dimensiona frente a lo que cobra la competencia.

Esfuerzo total estimado del plan: **unas 75–90 jornadas de desarrollo**, de las
cuales 6–8 desbloquean el primer torneo oficial y 20–25 el primer dojo
pagando. Sección 4 tiene el detalle.

## 2. Qué se revisó y qué se comprobó a mano

| Área | Alcance | Verificado a mano |
| --- | --- | --- |
| Experiencia de uso | Todo `frontend/src/app`, 18 capturas, guía de prueba | Retiro con llave solo muestra un aviso; mesa sin sonido al fin del tiempo; perfil de persona detrás del login |
| Backend y seguridad | `backend/app` completo (11 227 líneas), migraciones, infra, CI | Hash PBKDF2 390k; bloqueo de login en memoria por proceso sin IP real; lecturas sin ámbito; auditoría global; autopausa en prod |
| Lógica deportiva | `domain/*`, servicios, tests de dominio, documento maestro §12–21 | Kata por puntaje en llave cae silenciosamente a banderas |
| Madurez técnica | Pruebas ejecutadas (359 en 47 s, 87 % de cobertura), build del frontend (11 s, 117 KB), CI, dependencias, scripts de Azure | Carrera de migraciones con 2 procesos (reproducida 2/3); CI en rojo en las corridas 50, 51, 53 y 54; no existe la rama `main` |
| Competencia | 15 plataformas vía buscador (las páginas no se pudieron abrir desde este entorno; precios marcados como verificados solo si aparecían en la página oficial) | — |

## 3. Hallazgos por área

### 3.1 Confiabilidad y operación (lo que puede parar un torneo)

| # | Hallazgo | Evidencia | Efecto |
| --- | --- | --- | --- |
| C1 | **Carrera de migraciones al arrancar.** Cada proceso uvicorn ejecuta `alembic upgrade` y el `bootstrap` del admin al iniciar; con 2 procesos sobre una base vacía uno muere con `table users already exists` y uvicorn apaga al padre. | `backend/app/main.py:28-58`, `Dockerfile:45`; reproducido localmente 2 de 3 veces; CI en rojo en 4 de las últimas 6 corridas desde el commit `070c3e4` | En Azure, con `HAJIME_AUTO_CREATE_SCHEMA=true` y hasta 6 procesos, la primera migración nueva deja las copias reiniciándose en bucle. Además hoy la imagen no se publica cuando la prueba de humo falla y nadie recibe aviso. |
| C2 | **El vivo público satura Azure.** La caché de 2 s vive en memoria de cada proceso (hasta 6), sin agrupar cálculos concurrentes; cada cálculo hace 200–250 consultas a Azure SQL (~0,5 s) y ocupa los mismos 4 hilos que atienden a la mesa. | `backend/app/api/routers/public.py:27-47`, `services/public.py:182-272`; `docs/pruebas-carga.md` «Resultado en Azure» | Con 200 espectadores: mesa p95 20–28 s, login 4,7 s. Un torneo con público en el vivo degrada la mesa. |
| C3 | **Bloqueo de login inútil y peligroso.** Contador en memoria por proceso (se esquiva cambiando de copia) y clave `usuario|IP`, pero uvicorn ignora `X-Forwarded-For` sin `--forwarded-allow-ips`, así que la IP es siempre la del ingress: el contador es solo por usuario. | `backend/app/security.py:70-90`, `api/routers/core.py:53-65`, `Dockerfile:45` | Cinco intentos fallidos contra `mesa1` bloquean esa tablet 5 minutos. El hash PBKDF2 de 390 000 iteraciones cuesta ~0,4 s de CPU por login en 0,5 vCPU. |
| C4 | **Errores sin formato.** No hay manejador para errores de base, pool agotado ni excepciones genéricas: Starlette responde texto plano. | `backend/app/api/errors.py` | Fue lo que tumbó 3 mesas del script de carga; las tablets reales reciben lo mismo. |
| C5 | **Azure SQL se pausa también en producción** y `/health` no consulta la base. | `infra/azure/crear-ambiente.sh:92-96`, `main.py:81-83` | El primer usuario del día recibe errores durante ~1 minuto; las sondas de Container Apps no lo detectan. |
| C6 | **Sin monitoreo ni alertas.** Solo el log de acceso de uvicorn; sin id de petición, sin Application Insights, sin métricas. | `backend/app/db/base.py:81-90` | El primer incidente en torneo se diagnostica por WhatsApp. |
| C7 | **Pool de conexiones sobredimensionado**: 20 + 40 por proceso, hasta 360 conexiones en 3 copias contra un serverless de 2 vCores. | `backend/app/db/base.py:551` | Agotamiento de workers en la base bajo carga. |
| C8 | **Escritura en cada lectura de la llave** (`sync` recalcula y hace DELETE+INSERT de resultados) sin bloqueo por categoría. | `backend/app/services/brackets.py:426-435, 560-569` | 500 intermitentes cuando dos mesas cierran combates de la misma categoría. |
| C9 | **`crear-ambiente.sh` no es idempotente**: borra y recrea la app (se pierde el dominio y el certificado), rota la clave SQL y el secreto JWT en cada ejecución. | `infra/azure/crear-ambiente.sh:108-120` | Reejecutarlo en producción cierra todas las sesiones y tumba el dominio. |

### 3.2 Seguridad y datos personales

| # | Hallazgo | Evidencia |
| --- | --- | --- |
| S1 | **Lecturas sin ámbito.** Basta cualquier cuenta para listar torneos, inscripciones con edad/grado/peso, cola de tatamis, llaves, resultados, historial y estadísticas de cualquier persona, y buscar entre todas las personas por nombre. | `routers/tournaments.py:151-167`, `competition.py:330-486`, `history.py:16-47`, `core.py:262-286` |
| S2 | **Auditoría y excepciones globales** para cualquier staff; el filtro solo excluye la entidad `person`, pero `registration`, `team` y `referee_assignment` traen nombres y edades. | `core.py:394-436` |
| S3 | **Presencia de mesa sin permiso**: cualquier usuario puede registrar o borrar "quién opera" un combate. | `competition.py:413-421` |
| S4 | **Sesiones de 12 h sin revocación** ni cierre de sesión; rotar el secreto expulsa a todas las mesas a la vez. | `security.py`, `config.py` |
| S5 | **Anonimización incompleta**: los mensajes de excepciones aceptadas y las auditorías de inscripción y equipo conservan el nombre. | `services/people.py:184-210`, `teams.py:85-88` |
| S6 | **Filas de importación** guardan DNI y fecha de nacimiento en JSON y nunca se purgan tras confirmar. | `services/registrations.py` |
| S7 | Sin cabeceras de seguridad (HSTS, nosniff, frame-options); `/docs` público en producción; CORS incluye `localhost` en producción. | `main.py:63-76` |
| S8 | La app usa el **login de administrador del servidor SQL** y el firewall admite cualquier servicio de Azure; `HAJIME_ADMIN_PASSWORD` queda como secreto permanente. | `crear-ambiente.sh:82-120` |
| S9 | **Sin lockfile** de Python: cada build puede traer versiones distintas (hoy ya corre SQLAlchemy 2.1 sin que nadie lo decidiera); sin `pip-audit` ni Dependabot; sin `permissions` en el workflow. | `backend/pyproject.toml`, `.github/workflows/ci.yml` |

### 3.3 Experiencia de uso

**Organizador.** Todas las piezas existen, pero varias tareas se hacen fila
por fila y decisiones que la API soporta no tienen botón:

- Retirar con llave generada solo muestra un aviso con las opciones como texto; hay que saber ir a la llave o a la mesa (`registrations-tab.ts:612-628`). La guía de prueba promete otra cosa.
- No se puede editar una inscripción ni una categoría desde la pantalla aunque existan `PATCH /registrations` y `PATCH /categories`. Retirar y reinscribir es el único camino.
- Asignar tatami y orden de cola es un modal por categoría con un número escrito de memoria: unos 45 clics para 15 categorías (`categories-tab.ts:152-171`). La pestaña Tatamis solo mira.
- Importación: las filas con error se omiten sin poder corregirlas y las filas sin categoría sugerida no admiten elegir una; la vista previa se pierde al recargar (`import-tab.ts:111-137`).
- «Iniciar torneo» no valida nada (categorías sin llave o sin tatami).
- Kata por puntaje no tiene mesa: se anota en la tabla de la página de llave, en tema claro y sin cola offline (`bracket-page.html:151-230`).

**Operador de mesa.** La mesa de kumite está muy bien (cola local con UUID, reintentos con política clara, reloj coherente offline, deshacer auditado, tamaños táctiles correctos en tablet). Huecos:

- **Fin de tiempo silencioso**: al llegar a 0:00 solo cambia el color; no hay sonido ni vibración larga (`mesa.ts:239-241, 339-341`). Es el error más caro en mesa: puntos registrados fuera de tiempo.
- Llegar al combate cuesta 5 toques por la lista de torneos y 10 pestañas; en celular la pestaña Tatamis queda fuera de vista sin indicador.
- Sin `timeout` HTTP y sin escuchar `window.online`: con red "medio muerta" un envío queda colgado hasta que el sistema corte.
- Dos tablets en la misma mesa: solo un aviso amarillo; el servidor acepta a ambas.
- Vencimiento de sesión expulsa a `/login` en mitad de un combate (la cola sobrevive).
- Celular horizontal: botones de sanción de 34 px y «Más» de 26 px, por debajo del mínimo táctil.
- Corregir un kata cerrado: el selector de método no incluye banderas.

**Padre o espectador.** La página del vivo es clara, pero no puede buscar a su hijo, no sabe cuándo pelea, y el perfil del competidor y la tarjeta para compartir están detrás del login (`app.routes.ts:42-76`).

**Accesibilidad e idioma.** Uso real y cuidadoso de ARIA; faltan trampa de foco en diálogos y operación por teclado en la llave; contraste bajo AA en textos pequeños de la mesa. Todo el texto está fijo en español, con plurales tipo «1 inscripción(es)».

### 3.4 Lógica deportiva

Lo implementado es sólido y corresponde a un torneo local. Huecos por impacto en un torneo real:

| Impacto | Hueco | Evidencia |
| --- | --- | --- |
| Alto | Inscripción tardía o cambio de categoría con llave generada: no se puede agregar a un bye ni regenerar parcialmente | `services/brackets.py:132-135, 274-350` |
| Alto (ligas) | Kata por puntaje en llave y rondas múltiples: no existe; una categoría `scores`+`bracket` se decide por banderas con 3 jueces sin aviso; el orden de salida es aleatorio y no editable | `services/brackets.py:1003`, `schemas.py:696` sin endpoint |
| Medio-alto | Sobrecupo: sin `max_entrants` ni división de categoría | — |
| Medio-alto | Cola del tatami: no se pueden intercalar rondas de varias categorías ni reordenar combates ni garantizar descanso mínimo | `services/brackets.py:1101-1141` |
| Medio | 7 jueces WKF: descarte 1+1 por defecto (WKF 2+2), sin técnico/atlético | `domain/kata.py:301-307` |
| Medio | Faltas: una sola escalera, sin categorías ni tipo (mubobi, jogai, contacto); sin senshu automático en los últimos 15 s; punto de oro sin periodo extra | `domain/kumite.py:46, 157-166` |
| Medio | Shikkaku no descalifica del torneo; kiken y shikkaku entran al repechaje | `domain/brackets.py:483-519` |
| Medio | Pesaje: sin peso real, tolerancia ni recategorización; la importación exige peso pero las sugerencias lo ignoran | `services/registrations.py:242` vs `:465` |
| Medio | Edad por año de nacimiento (común en Perú) no soportada; solo edad a fecha de referencia | `domain/categories.py:36` |
| Medio | Equipos: extra bout empatado pide otro extra en vez de hantei; puesto vacío sin walkover automático | `domain/teams.py:330-338` |
| Bajo-medio | `point_values` configurable no se lee; cabezas de serie sin UI; round robin sin criterios configurables ni dos bronces | `services/tournaments.py:412-429` |
| Reputacional | Índice Hajime y líderes: un oro con un inscrito vale +30; «victoria más rápida» no normaliza por duración de categoría; «mejor kata» compara paneles de distinto tamaño; la insignia «primer combate» se da por inscribirse | `domain/stats.py:492-554`, `services/stats.py:256-337` |

### 3.5 Competencia y modelo de negocio

Quince plataformas revisadas (Sportdata, Smoothcomp, Kihapp, Taikai,
MartialMatch, Karate Tournament System, Toornament, Challonge, KarateHost,
Sistema Ronin, KarateHub, SICL/WarmiTEC en Perú, TKNET y Grandes Campeonatos
en Chile, TKDPLAY en México). Detalle en el anexo.

**Lo que casi todas tienen y Hajime no:** cobro de inscripciones integrado (10
de 15), autoinscripción del dojo con cuenta propia (8), directorio público de
eventos y perfil de atleta persistente (6), ranking multi-evento (5), avisos
al competidor de «próximos turnos y tiempo estimado» (4), panel de kata con un
dispositivo por juez (5), check-in por QR y pesaje (3).

**Lo que diferencia a Hajime:** PWA offline y APK en un solo producto (la
mayoría exige una laptop por tatami), Shadow Mode (sin equivalente), overlay
para OBS sin hardware, repechaje y dos bronces nativos, kumite por equipos,
índice e insignias, gratis para público y competidores, en español y con
soporte local. El competidor directo en Perú (SICL) solo hace inscripciones y
llaves.

**Precios de referencia (verificados en páginas oficiales):** Sportdata 0,3–1
€ por inscrito con mínimo 49 €; MartialMatch 0,50 € por inscrito; Kihapp 5 %
de la recaudación; Taikai 0,25–0,50 USD por competidor; Toornament 19–89 € al
mes; Smoothcomp Pro para atletas 29 USD pago único. Un torneo peruano de
300–600 competidores costaría en Sportdata entre S/ 950 y S/ 2 000.

**Calibración sugerida para Hajime:** membresía de dojo u organizador de S/
49–99 al mes o S/ 490–990 al año con torneos ilimitados, o por evento S/ 1–2
por competidor con mínimo S/ 150; Plus de competidor S/ 39–59 pago único o S/
9,90 al mes; federación o liga con cotización anual y subdominio propio.

### 3.6 Ingeniería

- **Pruebas**: 359 pasan en 47 s; cobertura 87 %; el flujo completo torneo → llave → combate → resultados está cubierto de punta a punta. Faltan: edición manual de llave, importación con archivos malos, kata con 5/7 jueces, comportamiento multi-proceso, contenido de PDF. El frontend tiene 28 tests que **CI no ejecuta**, no hay lint configurado, 65 archivos no cumplen Prettier y no hay pruebas de extremo a extremo.
- **CI**: 3 minutos por push, el frontend se compila cuatro veces, Docker sin caché, acciones sin fijar por SHA, sin `permissions` globales, sin Dependabot ni escaneo. **No existe la rama `main`**: nunca se generan las etiquetas estables ni corre el despliegue automático con la condición por defecto; los scripts apuntan a la imagen de una rama de trabajo.
- **Versionado y despliegue**: sin etiquetas, changelog ni releases; sin promoción test → prod ni rollback documentado; producción no existe todavía.
- **Código**: `services/brackets.py` con 1 191 líneas mezcla llaves, sincronización, marcador, kata y tatamis; importaciones circulares resueltas con imports locales; los servicios devuelven modelos de la API y hacen `commit` internamente; estados como cadenas sueltas. Nada urgente, pero cada función nueva toca los mismos archivos gigantes.
- **Documentación**: excelente para el negocio y el despliegue; falta `CONTRIBUTING.md`, `CLAUDE.md`, estrategia de ramas y cómo regenerar DDL y `openapi.json` (hoy desactualizado).

## 4. Plan priorizado

Esfuerzos en jornadas de una persona con el contexto del repo. Los horizontes
son secuenciales porque cada uno es prerrequisito del siguiente.

### Horizonte 0 — Esta semana: que el contenedor y la mesa aguanten (6–8 días)

| # | Acción | Días | Depende de | Riesgo si no |
| --- | --- | --- | --- | --- |
| 0.1 | Sacar migraciones y bootstrap del arranque: paso `alembic upgrade head` una sola vez antes de uvicorn (entrypoint) o Job de Container Apps en el despliegue; `bootstrap` idempotente; `HAJIME_AUTO_CREATE_SCHEMA=false` en Azure; test que arranque con 2 procesos sobre base vacía | 1 | — | CI sigue en rojo 2 de 3 veces; la primera migración en Azure deja las copias en bucle |
| 0.2 | Vivo compartido: instantánea por torneo en base (`payload`, `dirty`, `lease`) invalidada al escribir eventos, single-flight global por lease y local por proceso, `ETag` + `max-age=2`, hilos separados para `/public`; reducir `public.live` de ~250 a ~8 consultas | 3 | 0.1 | Mesa p95 20–28 s con público; no se puede vender el vivo |
| 0.3 | Bloqueo de login en base con IP real (`--forwarded-allow-ips`), hash calibrado a ~100 ms, manejadores de error JSON con `request_id` para base, pool y excepciones | 1,5 | — | Cualquiera bloquea una tablet; errores en texto plano rompen la mesa |
| 0.4 | Pool 6+4 por proceso, reintento con backoff ante base en pausa y 503 con `Retry-After`, `/health/ready` que consulte la base y sondas de Container Apps, autopausa desactivada en prod (o base S0 de ~15 USD) | 1 | — | Primer login del día falla; 360 conexiones contra 2 vCores |
| 0.5 | Repetir `prueba_carga.py` contra Azure y actualizar `docs/pruebas-carga.md`; objetivo: mesa p95 < 1 s incluyendo red | 0,5 | 0.2–0.4 | No se sabe si funcionó |

### Horizonte 1 — Antes del primer torneo oficial (4–6 semanas, 22–28 días)

Cierra los criterios de éxito de la sección 2 del documento maestro: 0
combates retrasados por la app, ≤ 3 s por evento, 0 incidentes bloqueantes.

**Operación del día (10–12 días)**

| # | Acción | Días |
| --- | --- | --- |
| 1.1 | Fin de tiempo audible y háptico (pitido, vibración larga, parpadeo a 15 s y a 0:00) con opción de auto-YAME por categoría | 0,5–1 |
| 1.2 | Retiro accionable (botones «Regenerar» y «Walkover» sobre la API existente) y edición de inscripción y de categoría desde pantalla | 2 |
| 1.3 | Inscripción tardía en llave generada: ocupar un bye, quitar un competidor, regenerar parcial antes de que empiece la ronda | 3–4 |
| 1.4 | Cola de tatami editable en la pestaña Tatamis: multiselección, subir/bajar, intercalar rondas de varias categorías, vista de la cola resultante | 3 |
| 1.5 | Pantalla «Mi tatami» para el operador (un toque hasta el combate), `timeout` HTTP de 8 s y reintento inmediato al volver la red, indicador de pestañas ocultas en celular, tamaños táctiles en horizontal | 2 |
| 1.6 | Validación «listo para iniciar» (categorías con inscritos sin llave o sin tatami) y corrección de filas en la importación con elección manual de categoría | 1,5 |

**Confianza y monitoreo (5–6 días)**

| # | Acción | Días |
| --- | --- | --- |
| 1.7 | Application Insights vía OpenTelemetry (FastAPI, SQLAlchemy, pyodbc), logging JSON con id de petición, alertas: copias en 0, 5xx, p95 de eventos de mesa > 1 s, presupuesto | 1,5 |
| 1.8 | Backups: exportación `.bacpac` a Blob la víspera de cada torneo (script), retención larga semanal, un ensayo de restauración documentado | 1 |
| 1.9 | Crear `main` protegida (PR + CI verde), scripts e imagen apuntando a etiquetas estables, `crear-ambiente.sh` idempotente (sin borrar la app ni rotar secretos), promoción test → prod con aprobación y `rollback.sh` | 2 |
| 1.10 | Lockfile de Python, `pip-audit` y `npm audit` en CI, `permissions: contents: read`, acciones por SHA, Dependabot, `ng test` y Prettier en CI, caché de Docker | 1 |

**Seguridad mínima antes de dar cuentas a terceros (5–6 días)**

| # | Acción | Días |
| --- | --- | --- |
| 1.11 | Ámbito en todas las lecturas: dependencia `TournamentAccess` (admin, organizador, operador o árbitro del torneo) en GET de torneo, llave, marcador, inscripciones, cola y reportes; auditoría y excepciones limitadas al torneo; presencia con permiso de operador; búsqueda de personas solo para staff | 2 |
| 1.12 | Sesiones: token de acceso de 60 min más token de refresco revocable en tabla; cierre de sesión; `kid` para rotar el secreto sin expulsar a nadie | 1,5 |
| 1.13 | Cabeceras de seguridad, `/docs` cerrado en prod, CORS solo desde variable, usuario SQL propio con permisos mínimos, quitar `HAJIME_ADMIN_PASSWORD` tras el primer arranque, purga de filas de importación confirmadas, anonimización completa | 1,5 |
| 1.14 | Pruebas de extremo a extremo con Playwright contra el contenedor con SQLite: login, torneo → llave → combate → podio, importación, vivo, mesa sin red | 2–3 |

### Horizonte 2 — Producto para organizadores y dojos (un trimestre, 25–30 días)

Es donde empieza el ingreso: el primer valor real para un dojo es inscribir a
sus alumnos y ver a sus competidores en vivo.

| # | Acción | Días | Depende de |
| --- | --- | --- | --- |
| 2.1 | **Organizaciones**: entidad, miembros con rol, `organization_id` en torneos y plantillas, plan «marcha blanca» con acceso total, derechos verificados en la API; refactor previo: enum de estados, unidad de trabajo por petición, dividir `brackets.py` | 6–8 | 1.11 |
| 2.2 | **Correo transaccional** (Azure Communication Services o Resend): recuperación de contraseña, verificación, confirmación de inscripción | 2 | — |
| 2.3 | **Cuentas de dojo y autoinscripción**: invitación por enlace, el sensei inscribe a su delegación con cierre de inscripciones y cupo por categoría, el organizador aprueba; `dojo_admin` pasa a otorgar permisos | 5–6 | 2.1, 2.2 |
| 2.4 | **Página pública del torneo** con dirección fija (slug) además del token: llaves y resultados por categoría con nombres abreviados, buscador por nombre y dojo, «¿cuándo pelea?» con tatami, número y cuántos faltan, favorito en el dispositivo | 3–4 | 0.2 |
| 2.5 | **Marcador de pantalla grande** por tatami (nombres, puntos, faltas, reloj) reutilizando la API del overlay; en el backlog del documento maestro como bajo esfuerzo | 1 | — |
| 2.6 | **Horarios estimados**: hora planificada por tatami, duración estimada por categoría, hora estimada por combate persistida y visible en el vivo; con las horas reales ya guardadas se recalibra torneo a torneo | 2–3 | 1.4 |
| 2.7 | **Check-in y pesaje**: presente/ausente por inscripción, peso real con rango numérico por categoría y tolerancia, advertencia o cambio de categoría; ausentes no entran a la llave | 3 | 1.3 |
| 2.8 | **Mesa de kata por puntaje** con botones grandes y cola offline, y **kata en llave con puntaje** (arreglar la caída a banderas), orden de salida editable; después, rondas múltiples y 7 jueces WKF | 5–7 | reglamento (§30) |
| 2.9 | Plantillas de categorías editables; edad por año de nacimiento; `point_values` configurable; sobrecupo con división de categoría | 3 | plantilla (§30) |

### Horizonte 3 — Plataforma y negocio (siguiente trimestre, 20–25 días)

| # | Acción | Días | Depende de |
| --- | --- | --- | --- |
| 3.1 | **Cuentas de competidor y familia**: registro abierto con verificación, reclamar perfil propio o de un menor (validado por el dojo), historial completo gratis | 5–8 | 2.2, asesoría legal |
| 3.2 | **Avisos**: Web Push desde la PWA («te toca en 3 combates», resultado del hijo), patrón outbox y worker aparte; después push nativo | 4–6 | 2.6, 3.1 |
| 3.3 | **Cobros**: pasarela local (Culqi, Niubiz o Mercado Pago) para membresía y Plus, comprobantes vía OSE, periodo de prueba y cupones; opcionalmente cobro de inscripciones por evento con comisión | 8–10 | 2.1, decisión de precios |
| 3.4 | **Ranking por temporada y liga**: puntos por podio, tabla por dojo («mejor academia»), reutilizando líderes e índice; corregir las métricas señaladas (oro sin combate, victoria más rápida, mejor kata, insignia de primer combate) | 3–4 | 2.1 |
| 3.5 | Certificados y diplomas en PDF con logo del organizador (beneficio Plus y de membresía) | 1 | — |
| 3.6 | Actualización en vivo por SSE para vivo, cola y overlay en lugar de sondeo | 2–3 | 0.2 |
| 3.7 | Reglas WKF completas: faltas con categoría y tipo, senshu automático, punto de oro con periodo extra, shikkaku global, repechaje sin kiken; equipos con hantei y walkover automático; grupos + eliminación | 6–8 | reglamento (§30) |
| 3.8 | Idioma: extraer textos a `$localize` (español, inglés, portugués) antes de que la app crezca más | 3 | — |
| 3.9 | Tiendas: Google Play (prueba cerrada) y App Store (`cap add ios`), política de privacidad, deep links | 3 + trámites | 3.2 |

### Resumen de esfuerzo

| Horizonte | Objetivo | Días |
| --- | --- | --- |
| 0 | El contenedor arranca siempre y la mesa aguanta público | 6–8 |
| 1 | Primer torneo oficial sin volver al papel | 22–28 |
| 2 | Primer dojo inscribiendo solo; organizador cómodo el día del torneo | 25–30 |
| 3 | Cuentas de competidor, avisos, cobros, ligas | 20–25 |
| **Total** | | **73–91** |

## 5. Decisiones que solo tú puedes tomar

Bloquean partes concretas del plan; ninguna bloquea el Horizonte 0.

1. **Reglamento de referencia** (documento maestro §30): escala de faltas, kata con 7 jueces, bronce en round robin, edad por fecha o por año. Bloquea 2.8, 2.9 y 3.7.
2. **Base de datos de producción**: serverless con autopausa (gratis, arranque en frío) o S0 sin pausa (~15 USD al mes). Afecta 0.4.
3. **Precios**: membresía de dojo por mes, por torneo o por alumno; qué entra en Plus. Bloquea 3.3. La sección 3.5 da referencias del mercado.
4. **Asesoría legal (Ley 29733)** para cuentas de menores y publicación de resultados. Bloquea 3.1 y el portal público con nombres.
5. **Estrategia de ramas**: crear `main` y trabajar por PR (1.9). Hoy hay 51 commits directos en 3 días en ramas de trabajo.

## 6. Riesgos del plan

- **Hacer producto antes de estabilizar.** Cada función nueva sobre el arranque y el vivo actuales hereda los fallos C1 a C4. Por eso el Horizonte 0 va primero y es corto.
- **Multi-tenant tarde.** Organizaciones toca unas 60 rutas; cuanto más tarde llegue, más caro. Está al inicio del Horizonte 2 a propósito.
- **Abrir cuentas sin ámbito en las lecturas** (S1) expone datos de menores a cualquier usuario. 1.11 es prerrequisito de 2.3 y 3.1.
- **Depender del reglamento sin decidirlo.** Lo deportivo que falta es mayormente configuración; si las decisiones de §30 siguen abiertas, se construirá dos veces.
- **Un solo desarrollador.** El plan asume ritmo sostenido; con revisiones y pruebas en campo cada horizonte alarga un 30 %.

## 7. Anexo: comparación con la competencia

| Producto | Público | Diferencial | Precio (verificado si lleva fuente oficial) |
| --- | --- | --- | --- |
| Sportdata SET Online | Federaciones, WKF | Inscripción y cobro, sorteos, video review, kata electrónico, ranking, acreditación | 0,3–1,0 € por inscrito, mínimo 49 € |
| Smoothcomp | Organizadores de BJJ, judo, karate | Inscripción y pagos, scoreboard PC, app móvil con perfil y avisos, white-label | Créditos por participante; Pro de atleta 29 USD único |
| Kihapp | Karate y TKD, torneos abiertos | Un teléfono por juez, gráficos para streaming, pantallas de público | 5 % de la recaudación |
| Taikai | Directores de torneos de karate | Kata con jueces independientes, check-in por QR, live results | 0,25–0,50 USD por competidor (beta) |
| MartialMatch | Deportes de combate | Inscripción, llaves, resultados | 0,50 € por inscrito |
| Karate Tournament System | WKF medianos y grandes | 15 tatamis en red | Licencia Windows; soporte 50 USD/h |
| Toornament / Challonge | Esports, general | Formatos de llave, comunidades | 19–89 € al mes / gratis con anuncios |
| KarateHost | Organizadores pequeños | Kumite y kata en vivo, Excel y escaneo con cámara | Gratis para empezar |
| Sistema Ronin / KarateHub | Federaciones en Brasil | Placar en TV, financiero, ranking | Cotización |
| SICL (WarmiTEC) | Copas de karate en Perú | Inscripciones por WhatsApp, llaves en un clic | No visible |
| TKNET / Grandes Campeonatos / TKDPLAY | Taekwondo en Chile y México | Inscripción por técnico, medallero en vivo, «en cancha / próximos / tiempo estimado» sin login, certificados | Suscripción por evento |

Nota: las páginas no se pudieron abrir desde este entorno; la información
proviene de los fragmentos del buscador y de páginas oficiales de precios.
Confirmar antes de citar cifras a terceros.
