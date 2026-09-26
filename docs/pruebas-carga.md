# Pruebas de carga: cuántos usuarios aguanta Hajime

Medido el 26/09/2026 sobre la misma versión que corre en el contenedor, en
una máquina de 4 núcleos con SQLite. Azure (ambiente de pruebas) da **medio
núcleo por copia y hasta 3 copias**, y usa Azure SQL en vez de SQLite: los
números de abajo hay que tomarlos como el rendimiento de **una copia con un
núcleo**; en Azure, una copia rinde cerca de la mitad y tres copias, cerca de
1,5 veces. La prueba definitiva se corre contra Azure con
`backend/scripts/prueba_carga.py` (ver al final).

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
  costoso (bcrypt), unos 100 ms por intento. Nadie entra 30 veces por segundo.
- Con los cambios de hilos y procesos, las lecturas bajo carga rinden entre 3 y
  4 veces más (llave con 16 clientes: de 33/s a 120/s).

## Torneo completo: 8 tatamis y 300 espectadores a la vez

`prueba_carga.py --tatamis 8 --espectadores 300`, servidor configurado como el
contenedor (2 procesos × 4 hilos): PENDIENTE.

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
- **El vivo se comparte 2 s:** un espectador puede ver un punto hasta 2 s
  después de marcado. Se ajusta con `HAJIME_PUBLIC_CACHE_SECONDS`.

## Cómo repetir la prueba contra Azure

Desde Azure Cloud Shell (pide la contraseña del admin, no se muestra):

```bash
cd ~/Hajime-Kumite-App && git pull
cd backend && python3 scripts/prueba_carga.py --url https://hajime.lorboftherin.com --tatamis 8 --espectadores 200
```

Crea un torneo «[CARGA] …» marcado como de prueba, opera todos sus combates
desde 8 mesas a la vez mientras 200 espectadores miran el vivo, y al final
muestra peticiones por segundo, latencias (mediana y p95) y errores. Tarda
unos 3–5 minutos. Se puede repetir con más `--espectadores` hasta encontrar el
límite del ambiente.
