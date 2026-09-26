# Portal público

Lo que ven familias, público y el coliseo sin iniciar sesión. Solo existe si el
organizador activó el público del torneo (Resumen → «Seguimiento en vivo y
transmisión»). Por la Ley 29733 y porque muchos competidores son menores, solo
se publica lo necesario: nombre (abreviado por defecto, «Diego R.»), dojo,
marcadores, horarios estimados, llaves, resultados y medallero. **Nunca**
documentos, fechas de nacimiento ni ids de personas (lo verifican
`tests/api/test_portal_publico.py` y `tests/api/test_public.py`).

## Páginas

| Ruta (Angular) | Qué es | API |
| --- | --- | --- |
| `/t/:slug` | Página del torneo por su dirección fija: tatamis en vivo con hora estimada, «¿Cuándo pelea?», premios, resultados, llaves y medallero. | `GET /public/t/{slug}` y `/people` |
| `/vivo/:token` | Lo mismo por el enlace secreto de siempre (sigue funcionando). | `GET /public/{token}` y `/people` |
| `/t/:slug/categoria/:id` (y `/vivo/:token/categoria/:id`) | Llave de solo lectura con el resultado de cada combate; podio abierto. | `GET /public/…/categories/{id}` |
| `/torneos-publicos` | Directorio: en curso, próximos y recientes (120 días), con buscador por nombre y ciudad. Solo torneos con público activo, dirección fija y **no** de prueba. | `GET /public/torneos?q=` |
| `/pantalla/:token/:tatami` | Marcador de pantalla grande para un TV: nombres, dojo, puntos, faltas, senshu, reloj local, categoría y siguiente combate. Sin interacción ni cursor, pantalla siempre encendida (Wake Lock). 16:9 y 4:3. | `GET /public/{token}/tatamis/{id}` |
| `/pantalla/:token` | Todos los tatamis en mosaico para la entrada del coliseo. | `GET /public/{token}` |
| `/overlay/:token/:tatami` | Overlay para OBS/vMix (fondo transparente). | `GET /public/{token}/tatamis/{id}` |

El organizador copia todos estos enlaces desde la tarjeta del Resumen, y puede
cambiar la dirección fija (minúsculas sin tildes, números y guiones, única).

## Dirección fija (`tournaments.public_slug`)

- Se genera al activar el público con el nombre y el año: «Copa Lima Kids» en
  2026 → `copa-lima-kids-2026` (si ya existe, `-2`, `-3`…). La migración 0013
  se la da a los torneos que ya tenían el vivo activo.
- Se edita con `PUT /tournaments/{id}/public` (`slug`); 409 `SLUG_TAKEN` o
  `INVALID_SLUG`. La anterior deja de responder.
- Desactivar el público corta también la dirección fija, pero la conserva: al
  volver a activarlo, el mismo enlace. Regenerar el token no la cambia.
- Internamente la dirección se traduce al token (caché de 5 s por proceso): las
  dos rutas comparten la misma instantánea.

## «¿Cuándo pelea?» (`GET /public/…/people`)

Lista compacta de competidores (persona o equipo) con nombre según la regla del
torneo, dojo y, por categoría, su próximo combate: tatami, número (`T2-014`),
cuántos combates faltan antes y hora estimada; o su puesto al terminar. El
buscador corre en el navegador (sin tildes ni mayúsculas) sobre esa lista. En
kata por rondas el «próximo combate» es su turno de salida (`kata_round`,
`turn`). No aparecen las inscripciones pendientes o rechazadas (autoinscripción),
retiradas ni las marcadas **ausentes** en la acreditación.

Enlaces al perfil: cada persona trae su `public_id` y la interfaz enlaza su
nombre a `/competidor/<public_id>` (`personLink()`) en «¿Cuándo pelea?», los
resultados y la llave pública. Se incluye para todos: el perfil público ya
abrevia a los menores y no muestra datos sensibles (`services/public_profiles.py`).
Los equipos no tienen enlace.

Favoritos: cada competidor trae una clave opaca (`key`, hash del torneo y la
persona; no es el id y no sirve en otro torneo). La estrella la guarda en
`localStorage` del dispositivo (`hajime.favoritos.<slug>`), con try/catch: en
modo privado quedan solo mientras la pestaña esté abierta. «Mis favoritos» se
muestra arriba con su estado.

## Horarios estimados (`app/services/schedule.py`)

- **Datos:** `tatamis.planned_start` (hora local del torneo, se edita en
  Tatamis → Horarios), `tournaments.timezone` (defecto `America/Lima`) y
  `tournaments.match_overhead_seconds` (margen entre combates, 60 s).
- **Duración de un combate** = duración de la categoría (kumite: sus reglas;
  kata por banderas: dos ejecuciones) × ritmo real del tatami + margen. Una
  ejecución de kata dura `performance_seconds` de las reglas de kata de la
  categoría (`kata_rules`) o del torneo (`kata_defaults`), 3 minutos si no se
  configura. **Kata por rondas** no tiene combates: cada ejecución sin nota de
  la ronda en curso es un turno, en el orden de salida. **Grupos +
  eliminación**: primero los grupos (el orden de la cola ya lo hace) y luego la
  llave. Los ausentes (acreditación) no ocupan tiempo: su combate será un
  walkover y su ejecución no se hace. El ritmo es duración real /
  nominal de los últimos 10 combates cerrados (`started_at`→`finished_at`),
  acotado a 0,5–3 y mezclado con 1 mientras haya menos de 3.
- **Partida:** lo más tarde entre ahora, la hora planificada y el final
  esperado del combate en curso. Sin hora planificada, sin actividad y con el
  torneo sin iniciar, no se estima nada.
- Horas redondeadas al minuto (la instantánea no cambia de ETag en cada
  recálculo). Se calculan al armar la instantánea pública (no en cada visita) y
  en la cola del tatami del organizador y «Mi tatami» con las filas que esa
  consulta ya cargó (una consulta más: el torneo; otra si hay kata por rondas).
- La API las entrega en ISO con la zona del torneo (`…T11:40:00-05:00`); la
  interfaz las muestra en esa hora aunque el celular esté en otra zona.
- Sin la base de zonas horarias en la imagen (`tzdata`), `America/Lima` se
  resuelve como UTC−5 fijo (Perú no tiene horario de verano).

## Rendimiento: todo sobre la instantánea compartida

Cada vista pública es una fila de `public_snapshots` (`live`, `people`,
`overlay:<tatami>`, `category:<id>`) con la misma invalidación que el vivo
(`public_snapshots.invalidate` al confirmar escrituras): un solo proceso la
recalcula cuando algo cambió y todos los espectadores reciben el mismo JSON,
con ETag/304. Techos de consultas por cálculo (`tests/api/`): vivo ≤ 15 (8),
«¿cuándo pelea?» ≤ 8 (6), llave de una categoría ≤ 12, cola del tatami ≤ 10
(una consulta más que antes, por la hora estimada).

## Actualización en vivo por SSE (`GET /public/{token}/stream`)

- Parámetros: `live` (defecto sí), `people`, `tatami=<id>`. Eventos `live`,
  `people`, `overlay` (JSON de la instantánea), `gone` (enlace desactivado) y
  un comentario `: latido` cada 15 s. `retry: 3000`.
- Servidor (`app/services/public_stream.py`): un hilo por torneo con
  espectadores en cada proceso consulta la versión de las instantáneas (una
  consulta) cada 1 s, o antes si una escritura del mismo proceso lo despierta,
  con al menos 0,5 s entre vueltas; si cambió, la trae (recalcula con turno si
  hace falta) y la difunde. Por conexión se guarda solo el último mensaje
  pendiente por vista: un celular lento recibe directamente el más nuevo.
- Límite por proceso: `HAJIME_PUBLIC_SSE_MAX_CONNECTIONS` (500). Pasado el
  límite, 503 con `Retry-After` y el navegador sigue con el sondeo. Con
  `HAJIME_PUBLIC_CACHE_SECONDS=0` (sin instantánea) también 503.
- Proxies: `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no` y el
  latido. Cada conexión dura como máximo `HAJIME_PUBLIC_SSE_MAX_SECONDS` (900 s)
  y el navegador se reconecta solo; con `Last-Event-ID` no recibe de nuevo lo
  que ya tiene.
- Cliente (`frontend/src/app/features/public/feed.ts`): `EventSource` con
  `ngsw-bypass` (el service worker no debe interceptarlo); mientras reconecta o
  si el servidor lo rechaza, sondeo cada 5 s (el vivo) y cada 20 s
  («¿cuándo pelea?»); reintenta SSE al minuto. Lo usan `/t/:slug`,
  `/vivo/:token`, la pantalla grande (1 s de sondeo de respaldo) y el mosaico.
- **El overlay de OBS sigue con sondeo de 1 s**: la fuente de navegador de OBS
  y vMix a veces queda horas abierta sin foco y no siempre reconecta bien un
  EventSource; un GET por segundo por overlay (hay uno por tatami) es barato,
  sale de la misma instantánea y ya adelanta el reloj con su edad.
- Medición: `docs/pruebas-carga.md` («Actualización en vivo por SSE»).

## Compartir (metadatos y vista previa)

- En el navegador, la página del torneo pone con `Meta`/`Title` de Angular el
  título, la descripción (fechas, sede y ciudad) y `og:image` con el logo de
  Hajime (`icons/icon-512x512.png`).
- Los robots de vista previa (WhatsApp, Facebook, Telegram) no ejecutan
  JavaScript. El backend, que ya sirve el frontend (`main.mount_frontend`),
  inyecta en el `index.html` `<title>`, `description`, `og:title`,
  `og:description`, `og:url` y `og:image` (todo escapado) para
  `/t/<slug>`, `/t/<slug>/categoria/<id>`, `/competidor/<public_id>` (nombre
  público, abreviado si es menor, y dojo) y `/ranking/<temporada>` (solo si la
  temporada es pública). Ver `app/services/share_preview.py`.
- Caché: 60 s por proceso (se vacía al cambiar el público del torneo) y
  `Cache-Control: public, max-age=60`. Rutas no públicas o inexistentes reciben
  el `index.html` de siempre (modo SPA). `/index.html`, el que descarga el
  service worker, no se toca: quien tiene la app instalada navega con su copia
  y la página pone sus etiquetas al cargar.

## Planes

La pantalla grande por tatami usa el mismo marcador que el overlay: con
`HAJIME_BILLING_MODE=enforced` requiere el derecho `live_overlay` del plan
(402 si no lo tiene). El mosaico, el vivo, «¿cuándo pelea?» y las llaves no.

## Pendiente

- Logo propio del torneo u organización en `og:image` cuando exista.
- Repetir la prueba de SSE en Azure.
