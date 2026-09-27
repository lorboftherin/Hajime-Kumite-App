# Pruebas de carga: cuántos usuarios aguanta Hajime

Medido el 26/09/2026 sobre la misma versión que corre en el contenedor, en
una máquina de 4 núcleos con SQLite. Azure (ambiente de pruebas) da **medio
núcleo por copia y hasta 3 copias**, y usa Azure SQL en vez de SQLite: los
números de abajo hay que tomarlos como el rendimiento de **una copia con un
núcleo**; en Azure, una copia rinde cerca de la mitad y tres copias, cerca de
1,5 veces. La prueba definitiva se corre contra Azure con
`backend/scripts/prueba_carga.py`: el resultado real, mucho peor que estos
números, está en «Resultado en Azure» más abajo.

## Resumen

| Pregunta | Respuesta |
| --- | --- |
| ¿Cuántas mesas pueden operar a la vez? | 8 tatamis a la vez sin errores; cada toque responde en decenas de milisegundos (ver «torneo completo»). |
| ¿Cuánta gente puede mirar el vivo? | 300 espectadores refrescando cada 5 s cuestan menos de una petición real por segundo: el vivo se calcula una vez y se comparte 2 s. Una copia atiende 600 peticiones/s del vivo. |
| ¿Se queda sin memoria? | No. 5 minutos con 300 espectadores y 8 mesas leyendo: 189 MB al inicio y 189 MB al final. Con dos procesos por contenedor, unos 400 MB de 1 GB. |
| ¿Qué pasa si hay más gente? | Azure levanta hasta 3 copias sola. Para un evento mucho mayor se sube ese límite y se paga solo ese fin de semana. |

## Qué se encontró y se corrigió

| Problema | Efecto medido | Corrección |
| --- | --- | --- |
| Cada espectador del vivo recalculaba tatamis, resultados, medallero y premios. | Con 50 espectadores, la mesa tardaba **4,6 s** por toque. | La respuesta del vivo (y del overlay) se calcula una vez y se comparte 2 s entre todos. La mesa pasó a **8 ms**. |
| Pocas conexiones a la base (5 + 10). | Con 300 espectadores y 8 mesas, peticiones esperando hasta 30 s y errores. | 20 conexiones fijas y hasta 40 extra. |
| 40 hilos atendiendo peticiones en un solo proceso. | 16 clientes leyendo la llave: **31 req/s** (con 1 hilo: 111 req/s; el intérprete perdía el tiempo cambiando de hilo). | 4 hilos por proceso y 2 procesos en el contenedor: **120 req/s**, cuatro veces más. |

## Rendimiento por endpoint (una copia, un proceso, antes de la corrección de hilos)

Peticiones por segundo y latencia mediana con 1, 16 y 64 clientes pidiendo sin pausa:

| Endpoint | 1 cliente | 16 clientes | 64 clientes |
| --- | --- | --- | --- |
| Lista de torneos | 224/s · 4 ms | 121/s · 133 ms | 112/s · 560 ms |
| Cola del tatami | 134/s · 7 ms | 78/s · 200 ms | 81/s · 786 ms |
| Llave de una categoría | 103/s · 9 ms | 33/s · 460 ms | 35/s · 1,8 s |
| Marcador de un combate | 134/s · 7 ms | 76/s · 208 ms | 77/s · 814 ms |
| Resultados del torneo | 86/s · 11 ms | 33/s · 476 ms | 34/s · 1,9 s |
| **Vivo público (compartido)** | 278/s · 2 ms | 542/s · 24 ms | 601/s · 102 ms |
| Ingreso (login) | 9/s · 106 ms | 36/s · 431 ms | 35/s · 1,7 s |

- El ingreso es lento a propósito: la contraseña se protege con un algoritmo
  costoso (PBKDF2-SHA256 con iteraciones configurables en `HAJIME_PASSWORD_ITERATIONS`), unos 100 ms por intento. Nadie entra 30 veces por segundo.
- Con los cambios de hilos y procesos, las lecturas bajo carga rinden entre 3 y
  4 veces más (llave con 16 clientes: de 33/s a 120/s).

## Torneo completo: 8 tatamis y 300 espectadores a la vez

`prueba_carga.py --tatamis 8 --espectadores 300`: 8 mesas operan 56 combates
punto por punto (con reenvíos por «red inestable») mientras 300 personas
refrescan el vivo cada 5 s.

| Servidor | Duración | Peticiones/s | Mesa: mediana · p95 | Vivo: mediana · p95 | Errores |
| --- | --- | --- | --- | --- | --- |
| Antes (1 proceso, 40 hilos, sin caché del vivo) | 191 s | 8 | 816 ms · 4,7 s | 6,8 s · 8,9 s | 0 |
| **Ahora (2 procesos × 4 hilos, vivo compartido)** | **52 s** | **71** | **14 ms · 651 ms** | **3 ms · 686 ms** | **0** |

El p95 de la mesa (651 ms) viene de que con SQLite las 8 mesas se turnan para
escribir; con Azure SQL cada escritura va por su lado. Los 56 combates
quedaron cerrados con su marcador igual a sus eventos.

## Memoria bajo carga sostenida

300 espectadores refrescando cada 5 s y 8 mesas leyendo cola y marcador cada
segundo, durante 5 minutos (17–18 peticiones/s sostenidas, 0 errores):

| Tiempo | RSS del proceso |
| --- | --- |
| 30 s | 189 MB |
| 150 s | 189 MB |
| 300 s | 189 MB |

Sin crecimiento: no hay fugas. La caché del vivo está acotada (se limpia lo
vencido al pasar de 500 entradas).

## La app en el celular (Chrome, Pixel 7, 4G simulado: 4 Mbit/s, 70 ms)

| Pantalla | Lista para usar | Descargado |
| --- | --- | --- |
| Ingreso, primera visita (descarga la app) | 2,1 s | 521 KB |
| Torneos | 0,7 s | 0 KB (ya está en el dispositivo) |
| Torneos, segunda visita | 0,6 s | 0 KB |
| Llave | 0,6 s | 0 KB |
| Mesa | 0,6 s | 0 KB |

- La app entera pesa 1,6 MB en disco y 521 KB por la red la primera vez; desde
  la segunda visita no se vuelve a descargar (service worker).
- La pestaña de la mesa usa 13 MB de memoria JavaScript; tras 100 toques
  seguidos (uno cada 30 ms, más rápido que cualquier mesa), 16 MB y ninguno
  quedó sin enviar.

## Límites conocidos y qué haría falta para más

- **Escrituras concurrentes:** con SQLite (instalación local en una laptop),
  8 mesas escribiendo a la vez se turnan en la base; con Azure SQL no.
- **Un contenedor es un solo servidor:** con 0,5 CPU, cada copia rinde la mitad
  de lo medido aquí. Para un evento con miles de espectadores: subir
  `--max-replicas`, o pasar a 1 CPU por copia.
- **Demora del vivo:** un espectador puede ver un punto unos segundos después
  de marcado (lo que el navegador reutiliza la respuesta,
  `HAJIME_PUBLIC_CACHE_SECONDS`, 3 s, más hasta 1,5 s de caché en memoria del
  servidor). Ver «Instantánea compartida del vivo».

## Resultado en Azure (ambiente de pruebas, 26/09/2026)

`prueba_carga.py --tatamis 8 --espectadores 200` contra
`https://hajime.lorboftherin.com` con la cuenta `claude-pruebas`, desde un
contenedor remoto cuyo viaje de ida y vuelta hasta Azure es de **0,5 s**
(`/health`, que no toca la base, tarda 500 ms; ese medio segundo está sumado
en todas las latencias de abajo). Dos corridas:

| Corrida | Combates | Duración | Peticiones/s | Mesa: mediana · p95 | Vivo: mediana · p95 | Errores |
| --- | --- | --- | --- | --- | --- | --- |
| 1 (torneo #3) | 35 en 5 tatamis | 682 s | 2,7 | 683 ms · 20,5 s | 1,6 s · 40,9 s | 3 mesas cayeron (ver abajo) |
| 2 (torneo #5) | 56 en 8 tatamis | 618 s | 6,1 | 716 ms · 27,9 s | 1,7 s · 21,2 s | 0 |

Los 56 combates de la segunda corrida quedaron cerrados. Pero el ambiente de
pruebas está **muy lejos** de los números medidos en local (52 s y 71
peticiones/s para el mismo torneo): un toque de mesa tarda 0,2 s de servidor
en condiciones normales y, bajo esta carga, el 5 % de los toques esperó más
de 20 s.

### Por qué

| Medición (sin carga, desde el mismo contenedor) | Secuencial | 16 a la vez |
| --- | --- | --- |
| `/health` (sin base de datos) | 512 ms | 16 req/s · mediana 0,9 s |
| Enlace público inexistente (una consulta a Azure SQL) | 563 ms | 16 req/s · mediana 0,8 s |
| Vivo público con caché (7 KB) | 1 083 ms | **3,3 req/s · mediana 2,0 s · máx 9,7 s** |

- **El vivo casi nunca sale de la caché.** La caché de 2 s vive en memoria
  de cada proceso: con 2 procesos por copia y hasta 3 copias hay hasta 6
  cachés separadas, y cada petición cae en cualquiera. De 20 llamadas
  seguidas al vivo, solo 4 fueron aciertos (500 ms, puro viaje de red); el
  resto recalculó todo. Y cuando 4 espectadores piden a la vez y ninguno
  encuentra la respuesta, los 4 la calculan en paralelo (la caché no agrupa
  cálculos en curso).
- **Cada cálculo del vivo cuesta ~0,5 s en Azure.** `public.live` hace
  decenas de consultas pequeñas (una por inscripción, persona y premio) y cada
  una es un viaje a Azure SQL; con 0,5 CPU por copia, además compite con las
  mesas. En local, con SQLite en el mismo proceso, esas consultas son gratis.
- **Las mesas esperan detrás del vivo.** Cada proceso atiende 4 peticiones a
  la vez; si las 4 están calculando el vivo, el toque de la mesa espera. De ahí
  el p95 de 20–28 s en mesa con una mediana de 0,7 s.
- **Ingreso lento bajo carga:** el login (PBKDF2, entonces con 390 000 iteraciones) pasó de 0,6 s a 4,7 s
  mientras corría la prueba: la CPU de la copia estaba saturada.
- **Corrida 1:** tres mesas murieron a los pocos segundos porque el servidor
  devolvió una respuesta que no era JSON (página de error del gateway) y el
  script no lo toleraba; ya se corrigió (se registra como error y la mesa
  reintenta la cola hasta 3 veces, como una tablet real). Además quedó un
  torneo #4 completo creado a las 04:48, un minuto antes de la corrida 2,
  que no corresponde a ninguna corrida lanzada a propósito; hay que borrarlo
  junto con #3 y #5 cuando ya no hagan falta.

### Qué haría falta

1. **Que el vivo no se recalcule por cada espectador en Azure:** agrupar las
   peticiones que llegan mientras se está calculando (una sola calcula, las
   demás esperan el resultado), subir `HAJIME_PUBLIC_CACHE_SECONDS` a 5 s
   (igual al refresco de la página) y, sobre todo, reducir las consultas de
   `public.live` a unas pocas (cargar inscripciones, personas y premios de una
   vez en lugar de uno por uno).
2. **Más CPU por copia** para un evento real: pasar de 0,5 a 1 CPU. Cada
   copia hoy rinde bastante menos de la mitad de lo medido en local.
3. Repetir esta prueba después de 1 y 2: la meta es que la mesa responda en
   menos de medio segundo el 95 % de las veces (descontando la red).

## Instantánea compartida del vivo (26/09/2026)

Respuesta a «Qué haría falta» (punto 1). Cuatro cambios:

1. **Una sola instantánea para todos los procesos y copias** (tabla
   `public_snapshots`, `app/services/public_snapshots.py`). Guarda el JSON ya
   armado del vivo y de cada overlay. Toda escritura que cambia algo visible
   (puntos y reloj, cierres, banderas y notas de kata, alineaciones, llaves,
   tatami, cola o estado de una categoría, activar o desactivar el enlace) la
   marca como vencida en su misma transacción, con una sola función
   (`invalidate`) llamada desde tres puntos comunes: `audit()`,
   `brackets.sync()` y `brackets.add_event()`. El vivo solo se recalcula si
   algo cambió (o si tiene más de 30 s), y **un solo proceso a la vez**: toma
   un turno con un UPDATE atómico; los demás siguen sirviendo la versión
   anterior mientras tanto. Dentro de cada proceso, además, un solo hilo por
   vista consulta la base; y delante hay una caché en memoria de 1,5 s.
2. **El navegador revalida en vez de descargar:** ETag y
   `Cache-Control: public, max-age=3`; si nada cambió, 304 sin cuerpo. El
   overlay no se guarda en el navegador (su reloj corre): el servidor adelanta
   el tiempo transcurrido desde que se calculó.
3. **Hilos propios para `/public`** (2 por proceso, `HAJIME_PUBLIC_THREADS`):
   el vivo ya no ocupa los 4 hilos que atienden a las mesas.
4. **Menos consultas.** Todo se carga por lotes (combates, inscripciones,
   resultados y eventos del torneo, una consulta cada uno); la llave ya no
   escribe al leerla (antes borraba y volvía a insertar el podio en cada GET
   y chocaba con las mesas), y se agregaron los índices de las lecturas
   calientes. En un torneo de 8 tatamis (prueba
   `tests/api/test_public_consultas.py`, que fija el techo):

| Lectura | Consultas antes | Consultas ahora | Techo en la prueba |
| --- | --- | --- | --- |
| Vivo público (un cálculo) | 346 | 8 | 15 |
| Cola del tatami (la mesa la pide seguido) | 159 | 8 | 10 |
| Overlay de un tatami | 20 | 6 | 10 |

Con ~2 ms por viaje a Azure SQL, un cálculo del vivo pasa de ~0,7 s de
consultas a ~16 ms, y además ocurre una vez por cambio en lugar de una vez
por espectador y proceso.

`prueba_carga.py --tatamis 8`, local (4 núcleos, SQLite, 2 procesos × 4 hilos,
como el contenedor), antes y después, mismo torneo (56 combates):

| Corrida | Duración | Peticiones/s | Mesa: mediana · p95 · máx | Vivo: mediana · p95 · máx | Errores |
| --- | --- | --- | --- | --- | --- |
| Antes, 300 espectadores | 69 s | 61 | 43 ms · 1 102 ms · 2 171 ms | 14 ms · 1 015 ms · 1 997 ms | 0 |
| **Ahora, 300 espectadores** | **42 s** | **79** | **16 ms · 40 ms · 238 ms** | **3 ms · 35 ms · 235 ms** | **0** |
| Antes, 1000 espectadores | 75 s | 106 | 94 ms · 1 315 ms · 2 997 ms | 18 ms · 853 ms · 2 550 ms | 0 |
| **Ahora, 1000 espectadores** | **43 s** | **215** | **21 ms · 69 ms · 375 ms** | **5 ms · 53 ms · 364 ms** | **0** |

El p95 de la mesa bajó de más de un segundo a 40–70 ms y ya no depende de
cuánta gente mira el vivo; el torneo termina en 42 s (el ritmo de las mesas)
en lugar de 69–75 s. Falta repetir la prueba en Azure (Azure SQL y 0,5 CPU
por copia) para confirmar la meta de la mesa por debajo de 0,5 s de servidor.

## Actualización en vivo por SSE (26/09/2026)

`GET /public/{token}/stream` empuja la instantánea del vivo cuando cambia en
lugar de que cada espectador pregunte cada 5 s (ver `docs/portal-publico.md`).
En cada proceso, **un solo hilo por torneo** consulta la versión de las
instantáneas (una consulta por vuelta, cada 1 s o antes si una escritura del
mismo proceso lo despierta, pero no más de una vuelta cada 0,5 s) y difunde a
todas las conexiones de ese proceso. Límite: 500 conexiones por proceso
(`HAJIME_PUBLIC_SSE_MAX_CONNECTIONS`); pasado el límite, 503 y el navegador
sigue con el sondeo.

`prueba_carga.py --sse N`, local (4 núcleos, SQLite, 2 procesos × 4 hilos, el
mismo equipo corre también el cliente de carga con sus 500 hilos): el tatami 1
queda para un marcador que anota un punto por segundo y se mide, en cada
conexión, desde el POST del punto hasta que lo recibe.

| Corrida | Mesa: mediana · p95 · máx | Vivo por sondeo: mediana · p95 | SSE: del POST a la llegada (mediana · p95 · máx) | Llegadas | Rechazadas |
| --- | --- | --- | --- | --- | --- |
| 7 mesas + 300 espectadores por sondeo, sin SSE (referencia) | 16 ms · 45 ms · 365 ms | 3 ms · 34 ms | — | — | — |
| 7 mesas + 500 SSE, sin intervalo mínimo (primera versión) | 62 ms · 305 ms · 612 ms | — | 255 ms · 686 ms · 1 382 ms | 10 000 / 10 000 | 0 |
| **7 mesas + 500 SSE** | **18 ms · 137 ms · 301 ms** | — | **402 ms · 913 ms · 1 046 ms** | 10 000 / 10 000 | 0 |
| **7 mesas + 300 por sondeo + 500 SSE** | **29 ms · 194 ms · 436 ms** | 30 ms · 203 ms | **327 ms · 725 ms · 900 ms** | 10 000 / 10 000 | 0 |
| 1 mesa + 1 100 SSE (límite 2 × 500) | 13 ms · 72 ms · 329 ms | — | 247 ms · 730 ms · 808 ms | 5 000 / 5 000 | **100 (503)** |

- Un punto llega a 500 pantallas en menos de un segundo (p95 0,7–0,9 s),
  contra 3–5 s del sondeo (caché del navegador más el refresco de 5 s).
- La primera versión despertaba al hilo en cada punto de cada mesa y
  recalculaba el vivo hasta ~15 veces por segundo: la mesa pasó de 16 a 62 ms
  de mediana. Con el intervalo mínimo de 0,5 s
  (`HAJIME_PUBLIC_SSE_MIN_INTERVAL`) se recalcula a lo sumo dos veces por
  segundo y proceso y la mesa vuelve a 18 ms de mediana. El p95 de la mesa
  (137–194 ms) sigue por encima de la referencia en parte porque en esta
  máquina el cliente de carga (500 hilos que leen y decodifican cada evento)
  compite por la misma CPU que el servidor.
- 1 100 conexiones contra 2 procesos: exactamente 100 rechazadas con 503; en
  el navegador esas páginas siguen con el sondeo y reintentan SSE al minuto.
- Memoria: cada conexión es una tarea del bucle de eventos con un diccionario
  de mensajes pendientes (solo el último por vista), sin copias por espectador.
- Detrás de un proxy: la respuesta lleva `Cache-Control: no-cache,
  no-transform` y `X-Accel-Buffering: no`, y un comentario de latido cada 15 s
  (Azure Container Apps corta conexiones inactivas a los 240 s). Cada conexión
  dura como máximo 15 minutos (`HAJIME_PUBLIC_SSE_MAX_SECONDS`); el navegador
  se reconecta solo y con `Last-Event-ID` no vuelve a descargar lo que tiene.
- Falta repetir en Azure: `prueba_carga.py --url https://… --tatamis 8
  --espectadores 200 --sse 500`.

## Avisos push con 500 suscripciones (26/09/2026)

Un torneo de 8 con 500 suscripciones siguiendo a dos competidores cada una
(`tests/api/test_avisos_push.py::test_carga_500_suscripciones_un_recorrido`).
Empezar un combate dispara **un** recorrido del torneo (no uno por
espectador): 49 ms para encolar 562 avisos (71–89 ms con 1000); sin nada
nuevo, 29–31 ms. Enviarlos (cifrado + VAPID, servidor falso, 8 hilos): 389 ms.
El recorrido corre después del commit en el hilo de avisos: la mesa no lo
espera. Detalle en [`avisos-push.md`](avisos-push.md).

## Cómo repetir la prueba contra Azure

Desde Azure Cloud Shell (pide la contraseña del admin, no se muestra; con
`--user` se usa otra cuenta administradora, p. ej. `claude-pruebas`):

```bash
cd ~/Hajime-Kumite-App && git pull
cd backend && python3 scripts/prueba_carga.py --url https://hajime.lorboftherin.com --tatamis 8 --espectadores 200
```

Crea un torneo «[CARGA] …» marcado como de prueba, opera todos sus combates
desde 8 mesas a la vez mientras 200 espectadores miran el vivo, y al final
muestra peticiones por segundo, latencias (mediana y p95) y errores. Tarda
unos 3–5 minutos. Se puede repetir con más `--espectadores` hasta encontrar el
límite del ambiente.
