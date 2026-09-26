# Avisos push: «te toca pronto»

Avisos en el celular o la computadora del competidor, su familia, su sensei o
cualquier espectador: «Diego R.: te toca en ~3 combates», «¡A tatami! Diego R.»,
«Diego R. ganó contra Luis P. (3–1)», medallas al cerrar la categoría y, para
las cuentas, inscripciones revisadas y perfiles aprobados. Usa **Web Push**
estándar (sin Firebase en la web) con el service worker de Angular.

## Cómo se usa

| Dónde | Quién | Qué hace «Avisarme» (campana) |
| --- | --- | --- |
| Página pública `/t/:slug` («¿Cuándo pelea?», junto a la estrella) | Cualquiera, sin cuenta | Sigue a ese competidor **en ese torneo** con su clave opaca `key`. Vence al terminar el torneo. |
| «Mis perfiles» | Competidor adulto o padre, madre o apoderado | Sigue el propio perfil o el del menor a cargo en **todos** los torneos. |
| «Mis competidores» | Sensei / admin de dojo | Sigue a un alumno (campana en la fila) o a **todo el dojo** (campana de arriba). |
| `/avisos` (enlace en «Mi cuenta» y en la página pública) | Todos | Activar o desactivar los avisos en el dispositivo y elegir cuáles recibir: turno, resultados, medallas, cuenta. |

Cada suscripción es de **un navegador en un dispositivo**: seguir en el
celular no avisa en la computadora. Tocar un aviso abre la página correcta: el
vivo del torneo con el competidor resaltado arriba (`/t/<slug>?seguir=<key>`),
«Mis perfiles» o «Mis competidores».

## Qué se avisa y cuándo

Lo calcula `app/services/push_eval.py` **una vez por torneo**, no por
espectador:

1. Al confirmar una escritura con torneo (lo mismo que invalida la instantánea
   pública: cierres, puntos y reloj de la mesa, cola, llaves, acreditación…),
   el oyente de `public_snapshots` anota el torneo y despierta al hilo de
   avisos del proceso. La mesa no espera: el recorrido corre después del
   commit, en otro hilo y con otra sesión, como mucho una vez por segundo y
   torneo.
2. El recorrido carga el torneo por lotes (como «¿cuándo pelea?»), arma la cola
   de cada tatami con `schedule.timeline` y trae con **una consulta** a quién
   siguen las suscripciones (claves del torneo, perfiles inscritos o dojos
   inscritos). Sin seguidores, son dos consultas y termina.
3. Inserta los avisos en `notification_outbox` en un solo INSERT. La unicidad
   `(suscripción, tipo, ref)` deduplica: se puede recorrer el torneo muchas
   veces, o en varios procesos a la vez, y cada aviso sale una sola vez.
4. Red de seguridad: cada `HAJIME_PUSH_SWEEP_SECONDS` (30 s) se recorren los
   torneos en curso aunque el cambio lo haya hecho otro proceso o copia.

| Tipo | Regla | Vigencia |
| --- | --- | --- |
| `soon` «Te toca en ~N combates» | Le faltan `HAJIME_PUSH_SOON_AHEAD` (3) combates o menos en la cola de su tatami | 10 min (`HAJIME_PUSH_TURN_TTL_SECONDS`), urgencia alta |
| `next` «¡A tatami!» | Todos los de delante están en curso: su combate es el siguiente. Si ya salió, no se manda `soon` de ese combate. | 10 min, urgencia alta; queda en pantalla hasta tocarla |
| `result` «Ganó / perdió contra … (marcador)» | Combate cerrado en los últimos 30 min, después de empezar a seguirlo | 1 h |
| `medal` «Medalla de oro/plata/bronce» | Puesto 1 a 3 al finalizar la categoría (resultados de las últimas 2 h) | 6 h |
| `registration` | El organizador aprueba o rechaza una autoinscripción: al sensei que la pidió (un aviso por lote) y a la cuenta de la persona y su apoderado | 24 h |
| `claim` | Se aprueba el reclamo de un perfil | 24 h |

Los de turno solo salen si la hora estimada del combate está dentro de los
próximos 90 minutos: una llave armada días antes (o un torneo sin hora
planificada ni actividad) no avisa. Un aviso de turno por combate y tipo por
suscripción, aunque siga a los dos competidores de ese combate. En el
dispositivo, `next` reemplaza a `soon` del mismo combate (misma etiqueta
`tag`), y en el servicio de push un aviso de turno aún no entregado se
reemplaza por el más nuevo (cabecera `Topic`).

**Privacidad** (Ley 29733, como el portal): el nombre sigue la regla del
torneo (abreviado «Diego R.» por defecto) y **siempre** abreviado para menores
o si no se conoce la edad. Nunca documento, fecha de nacimiento ni ids
internos. Los favoritos anónimos solo funcionan mientras la página pública
del torneo esté activa y se borran al día siguiente del último día del torneo;
las suscripciones anónimas sin nada que seguir se borran a los 2 días.

## Envío

`app/services/push.py` + `app/services/webpush.py`:

- **Cifrado** `aes128gcm` (RFC 8188/8291) con [`http-ece`](https://pypi.org/project/http-ece/)
  (de web-push-libs, el mismo que usa `pywebpush`) y `cryptography`. No se usa
  `pywebpush` porque trae `requests` y `aiohttp`; el POST es `urllib`.
- **VAPID** (RFC 8292): JWT ES256 firmado con la clave privada (`aud` = origen
  del servicio de push, 12 h), cabecera `Authorization: vapid t=…, k=…`.
- Cabeceras `TTL` (lo que le queda de vigencia), `Urgency`, `Topic` (turno) y
  `Content-Encoding: aes128gcm`.
- Un lote de hasta 100 avisos se reserva con un solo UPDATE condicional
  (`claimed_by` + *lease* de `HAJIME_PUSH_LEASE_SECONDS`), los POST salen en
  paralelo (8 hilos) y el resultado se guarda en una transacción.
- **404/410**: el navegador canceló la suscripción → se borra con lo que seguía.
  **429/5xx o sin red**: se reintenta con espera creciente (5 s, 10 s, 20 s…
  hasta 5 min) hasta `HAJIME_PUSH_MAX_ATTEMPTS`. Otro 4xx: se descarta.
  Pasada su vigencia, un aviso ya no sale (`expired`).
- El endpoint de una suscripción debe ser **https** y de un servicio de push
  conocido (`HAJIME_PUSH_ALLOWED_HOSTS`: FCM, Mozilla, Windows, Apple): el
  servidor le hace POST, y así no se lo puede usar para llegar a otras URL.
- Para cambiar una suscripción sin sesión hay que mandar su `endpoint` y su
  secreto `auth` (solo los conoce el navegador que se suscribió).

Quién envía: un **hilo por proceso** de la API (lo arranca el *lifespan* si
hay claves VAPID y `HAJIME_PUSH_DISPATCHER=true`; no con SQLite en memoria) y/o
`python -m app.push_worker` (una pasada: recorre los torneos en curso y envía
lo pendiente; con `--loop` se queda). Pueden correr a la vez.

## API

| Ruta | Sesión | Qué hace |
| --- | --- | --- |
| `GET /push/config` | No | `{enabled, public_key, soon_ahead}`; `enabled: false` si faltan las claves |
| `POST /push/subscriptions` | Opcional | Suscribe o actualiza el navegador (`endpoint`, `keys`, `preferences`). Con sesión queda ligado a la cuenta. 409 `PUSH_DISABLED`, `PUSH_ENDPOINT`, `PUSH_KEYS` |
| `POST /push/subscriptions/state` | No | Preferencias y a quién sigue (`tournament` = slug o token: sus claves) |
| `PUT /push/subscriptions/preferences` | No | Qué avisos recibir |
| `POST /push/subscriptions/unsubscribe` | No | Borra la suscripción y lo que seguía |
| `PUT /push/follows` | No | Claves que sigue en un torneo público (reemplaza la lista, máx. 100) |
| `PUT /me/push/follows` | Sí | Seguir un perfil (`person_id`: propio, menor a cargo o alumno del dojo) o un dojo (`dojo_id`: sensei o admin del dojo); `follow: false` deja de seguir |

Tablas (migración `0015_avisos_push`): `push_subscriptions`, `push_follows`,
`notification_outbox`.

## Claves VAPID y variables

```bash
cd backend && python -m app.seed vapid-keys   # imprime las tres variables (no toca la base)
```

| Variable | Por defecto | Uso |
| --- | --- | --- |
| `HAJIME_VAPID_PUBLIC_KEY` | — | Clave pública (base64url, 65 bytes). Va al navegador. |
| `HAJIME_VAPID_PRIVATE_KEY` | — | Clave privada (base64url de 32 bytes, o PEM). **Secreto.** Sin las dos claves, los avisos quedan apagados. |
| `HAJIME_VAPID_SUBJECT` | `mailto:soporte@hajime.pe` | Contacto para los servicios de push (`mailto:` o `https:`) |
| `HAJIME_PUSH_DISPATCHER` | `true` | Hilo de avisos en cada proceso de la API |
| `HAJIME_PUSH_POLL_SECONDS` | `2` | Cada cuánto revisa la bandeja si nadie lo despierta |
| `HAJIME_PUSH_SWEEP_SECONDS` | `30` | Pasada por los torneos en curso |
| `HAJIME_PUSH_SOON_AHEAD` | `3` | «Te toca en ~N combates» |
| `HAJIME_PUSH_TURN_TTL_SECONDS` | `600` | Vigencia de los avisos de turno |
| `HAJIME_PUSH_MAX_ATTEMPTS`, `HAJIME_PUSH_LEASE_SECONDS`, `HAJIME_PUSH_TIMEOUT` | `5`, `60`, `10` | Reintentos, reserva de un lote y espera del POST |
| `HAJIME_PUSH_ALLOWED_HOSTS` | `["fcm.googleapis.com","push.services.mozilla.com","notify.windows.com","push.apple.com"]` | Servicios de push aceptados (sufijo del host, JSON) |

Las claves son **las mismas en todas las copias** y no se cambian a la ligera:
con otra clave pública, todas las suscripciones existentes dejan de servir y
cada navegador tiene que volver a tocar «Avisarme» (se borran solas con el
primer 404/410 o se quedan sin avisos). Guárdalas en Key Vault / secretos del
Container App como el JWT.

## Cómo probar

- **Pruebas automáticas:** `pytest -q tests/api/test_avisos_push.py`. Un
  servidor push falso (se reemplaza `webpush._post`) recibe los avisos; la
  prueba descifra cada uno con la clave del «navegador» (`http_ece.decrypt`) y
  valida el JWT de VAPID con la clave pública, las cabeceras, la
  deduplicación, 404/410, 5xx, vencimiento y la carga de 500 suscripciones.
- **A mano en local:** `python -m app.seed vapid-keys` y exporta las tres
  variables; compila el frontend en producción (`npx ng build`, el service
  worker no corre con `ng serve`) y sírvelo desde la API
  (`HAJIME_STATIC_DIR=../frontend/dist/hajime/browser uvicorn app.main:app`).
  Abre `http://localhost:8000/t/<slug>` (Chrome permite push en `localhost`),
  toca la campana de un competidor, empieza combates en la mesa y mira el
  aviso. `chrome://serviceworker-internals` permite mandar un push de prueba.
- Firefox y Chrome de escritorio y Android funcionan en cualquier pestaña.

## Limitaciones

- **iPhone y iPad:** Safari solo entrega Web Push a la **app instalada**
  (Compartir → «Agregar a pantalla de inicio») y desde iOS/iPadOS 16.4. En
  Safari sin instalar, la campana explica cómo hacerlo. Apple no garantiza la
  entrega si el iPhone está en modo de bajo consumo o «No molestar».
- **Android con ahorro de batería** puede demorar los avisos unos minutos; por
  eso los de turno tienen urgencia alta y vigencia corta (un «te toca» con 20
  minutos de retraso ya no sirve).
- **Navegación privada** y navegadores sin service worker: no hay avisos.
- **App de Android (Capacitor):** el WebView no tiene Web Push. La campana se
  oculta y se muestra «La app de Android todavía no recibe avisos. Instala
  Hajime desde el navegador…». Ver el camino a FCM abajo.
- Cada dispositivo sigue por separado (no se sincroniza entre el celular y la
  computadora de la misma cuenta).

## Camino a FCM (app de Android)

Preparado pero **no activado**: hace falta un proyecto de Firebase y sus
credenciales.

1. Crear el proyecto en Firebase, registrar la app `com.hajime.torneos` (el
   `appId` de `capacitor.config.ts`) y descargar `google-services.json` a
   `frontend/android/app/` (no se sube al repositorio: va como secreto del
   workflow de release).
2. `npm install @capacitor/push-notifications && npx cap sync android`.
3. En `PushService` (frontend), si `isMobileApp`: `PushNotifications.requestPermissions()`,
   `register()` y escuchar `registration` (token FCM) y
   `pushNotificationActionPerformed` (abrir `data.url` con el router).
4. Backend: guardar el token en `push_subscriptions` con un tipo nuevo (p. ej.
   columna `kind` = `fcm`, endpoint = token) en una migración aditiva, y en
   `webpush.send` enviar esos por la API HTTP v1 de FCM
   (`https://fcm.googleapis.com/v1/projects/<id>/messages:send`) con una
   cuenta de servicio (OAuth2, `HAJIME_FCM_CREDENTIALS` como secreto). El
   recorrido, la bandeja y la deduplicación no cambian.
5. Quitar el mensaje «La app de Android todavía no recibe avisos» cuando
   `PushService` tenga el camino FCM.

## Rendimiento (medido)

26/09/2026, 4 núcleos, SQLite, `tests/api/test_avisos_push.py`: torneo de 8
competidores con **500 suscripciones** siguiendo a dos competidores cada una.

| Qué | Tiempo |
| --- | --- |
| Recorrido sin avisos nuevos (todo deduplicado) | 29–31 ms |
| Empieza un combate: recorrido + INSERT de 562 avisos | 49 ms |
| Mismo caso con 1000 avisos (cada una sigue al 3.º y al 4.º de la cola) | 71–89 ms |
| Envío de 562 avisos (cifrado + firma VAPID, servidor falso, 8 hilos) | 389 ms (0,7 ms c/u) |

El encolado queda en decenas de milisegundos y fuera de la petición de la
mesa. En Azure SQL cada consulta es un viaje de red (~6 consultas por
recorrido): se espera del orden de 100–200 ms por recorrido. El envío real
depende de la latencia de FCM/Apple (50–200 ms por POST, 8 en paralelo).

## Pendiente

- Probar en Azure con navegadores reales (Chrome Android, iPhone instalado).
- App de Android con FCM (arriba).
- Avisos de kata por rondas: hoy «te toca» sí (su turno de salida), el
  resultado llega con la medalla.
