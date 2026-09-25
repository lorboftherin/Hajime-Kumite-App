# Guía de prueba: torneo mock en entrenamiento

Esta guía lleva al equipo desde la instalación hasta el cierre del primer
torneo mock (sección 6 del documento maestro), siguiendo el guion de casos
difíciles de la sección 27. Tiempo estimado: 30 min de preparación el día
anterior y un entrenamiento completo para el mock.

## 1. Instalar (una sola vez)

Se necesita una laptop con [Docker Desktop](https://www.docker.com/products/docker-desktop/).
La laptop hace de servidor; tablets y celulares se conectan por Wi‑Fi.

**Opción A: imagen ya compilada (recomendada).** La publica el CI en cada
cambio. Si el repositorio es privado, primero `docker login ghcr.io` con tu
usuario de GitHub y un token con permiso `read:packages`.

```bash
docker run -d --name hajime -p 8000:8000 \
  -e HAJIME_ADMIN_PASSWORD='una-clave-segura' \
  -v hajime-data:/data \
  ghcr.io/lorboftherin/hajime-kumite-app:claude-gracious-feynman-qtapgx
```

**Opción B: compilar desde el código.**

```bash
git clone https://github.com/lorboftherin/Hajime-Kumite-App.git
cd Hajime-Kumite-App
HAJIME_ADMIN_PASSWORD='una-clave-segura' docker compose up -d --build
```

Abrir <http://localhost:8000> y entrar con `admin` y la clave elegida.

- Los datos quedan en el volumen `hajime-data`. Actualizar la app **no**
  borra datos: las migraciones se aplican solas al arrancar.
- Para usar tablets: conectarlas a la misma red y abrir
  `http://<IP-de-la-laptop>:8000` (la IP sale en *Configuración de red*).
- Respaldo antes y después del mock:
  `docker cp hajime:/data/hajime.db ./respaldo-$(date +%F).db`.

## 2. Preparar el equipo (día anterior)

1. **Usuarios** (menú del admin → *Usuarios*): crear una cuenta por persona.
   Al primer ingreso cada uno debe cambiar su contraseña.
2. **Roles** (*Personas* → persona → *Roles*): vincular cada usuario a su
   persona y darle rol:
   - `organizer` del torneo: inscribe, genera llaves, corrige.
   - `table_operator` del torneo: solo opera la mesa (no ve DNI ni fechas de
     nacimiento, como pide la sección 11).
3. **Torneo** (*Torneos* → *Nuevo*): plantilla *Plantilla base (borrador)*,
   marcar **Torneo de prueba**, 1 tatami. Pasar a *Inscripciones abiertas*.
4. **Inscripciones:** descargar la plantilla Excel (*Importar Excel*),
   llenarla con los alumnos del entrenamiento, subirla y revisar la vista
   previa fila por fila. Sin documento se puede; queda como "identidad
   incompleta".
5. **Categorías:** revisar las que tienen pocos inscritos (la app sugiere
   fusionar, final directa o round robin). Asignar cada categoría al tatami
   y su orden en la cola.
6. **Llaves:** generar e imprimir (*PDF*). Imprimir también la
   **planilla de mesa** del tatami (*Tatamis* → *Planilla PDF*, o
   `/api/v1/tatamis/<id>/scoresheet.pdf`): es el registro oficial en papel.

## 3. Durante el mock

- **Mesa oficial (papel):** cronómetro y planilla impresa. Anota marcador y
  ganador de cada combate por su número (`T1-001`, `T1-002`…).
- **Operador de la app:** *Tatamis* → *Abrir mesa* del combate en curso. El
  número del combate en la app es el mismo de la planilla.
- **Si la app falla, el torneo sigue en papel.** Anotar la hora y qué pasó.

### Guion de casos difíciles (sección 27)

Provocar cada caso a propósito y marcar el resultado.

| ✔ | Caso | Cómo provocarlo en la app | Resultado esperado |
| --- | --- | --- | --- |
| ☐ | Duplicado | Importar dos veces al mismo alumno con el nombre escrito distinto ("José Pérez" / "Jose Peres") | La vista previa lo marca "posible duplicado"; elegir *usar existente*. Si ya se creó, *Personas* → fusionar (Admin) |
| ☐ | Override | Inscribir a un alumno de grado alto en categoría de principiantes | Aparece la advertencia; aceptar con motivo; queda en *Auditoría* |
| ☐ | Fusión | Fusionar dos categorías de 2 inscritos | Categoría nueva con 4; las de origen quedan "Fusionada" |
| ☐ | Mismo dojo | Categoría con 4 de 8 del mismo dojo | La llave muestra "Cruces mismo dojo: 0" |
| ☐ | Retiro | Retirar a un competidor con la llave ya publicada | La app ofrece walkover o regenerar |
| ☐ | Empate | Terminar un combate empatado | Sugiere hantei (o punto de oro, según la regla) |
| ☐ | Error de mesa | Marcar un punto al color equivocado | *Deshacer último*: el marcador se corrige y el evento queda tachado |
| ☐ | Corrección tardía | Cambiar el ganador de un combate cuyo ganador ya avanzó | La app lista los combates afectados y pide motivo |
| ☐ | Reapertura | Cerrar el torneo, reabrirlo (Admin) y corregir un resultado | Auditoría con motivo; medallero actualizado |
| ☐ | Kata | Ronda de kata por puntuación con 5 jueces y un empate | Se desempata por la nota mínima descartada |
| ☐ | Sin conexión | Apagar el Wi‑Fi de la tablet, marcar 2 puntos, volver a encenderlo | Indicador "Sin conexión · 2 pendientes"; al volver se envían solos, sin duplicarse |
| ☐ | Equipo con suplente | *Inscripciones* → *Equipo*: tres titulares y un suplente de un dojo, más una persona de otro dojo | Advierte "pertenece a otro dojo"; la tabla muestra el equipo con sus integrantes |
| ☐ | Enfrentamiento por equipos | Abrir la mesa de un enfrentamiento de kumite por equipos, confirmar la alineación y operar los 3 combates | Cada combate se opera en la mesa normal; al cerrar el 2.º ganado por el mismo equipo, el enfrentamiento se decide y la llave avanza |
| ☐ | Hikiwake y combate extra | Empatar en victorias y en puntos (un combate en hikiwake) | La mesa pide un combate extra; al cerrarlo gana ese equipo por "Combate extra" |

### Torneo con varios tatamis (MVP-3)

1. **Un operador por tatami.** En *Personas*, abre la ficha de cada operador y agrégale el rol *Operador de mesa* con
   ámbito *Por tatami*: solo podrá registrar los combates de las categorías asignadas a ese tatami.
2. **Árbitros (opcional).** En la pestaña *Árbitros* del torneo registra a los árbitros (no necesitan dojo) y asígnalos
   a su tatami con el puesto (*Árbitro central*, *Juez 1*…). También se pueden importar con la columna *Rol* del Excel.
   En kata, la mesa los propone para anotar qué juez dio cada bandera o nota.
3. **Durante el torneo**, la pestaña *Tatamis* muestra el avance de cada tatami, el marcador del combate en curso,
   quién está operando ahora y sus árbitros. Si dos tablets abren el mismo combate, ambas ven un aviso: registren desde
   una sola.
4. **Ensayo antes del torneo.** Con el servidor encendido, simula varios tatamis operados a la vez (crea un torneo de
   prueba, que no cuenta en historiales ni estadísticas):

   ```bash
   cd backend
   python scripts/simulate_multi_tatami.py --url http://localhost:8000 --password <clave del admin> --tatamis 4
   ```

   Debe terminar con `RESULTADO: OK`. En esta máquina, 8 tatamis con 240 combates en paralelo terminaron sin errores.

## 4. Después del mock: comparación y hallazgos

1. En *Shadow Mode* (pestaña del torneo), cargar para cada combate el
   ganador y marcador **oficiales** de la planilla en papel.
2. La app calcula el porcentaje de coincidencia y lista las diferencias.
3. Por cada diferencia, anotar en *Hallazgo* si el error fue de la app o del
   papel (`error_source`).
4. Exportar resultados y medallero (*Resultados* → Excel/PDF).
5. Revisar *Auditoría*: cada corrección debe tener motivo.

### Criterios de éxito (sección 2), para anotar tras cada prueba

| Criterio | Meta | Resultado del mock |
| --- | --- | --- |
| Coincidencia de ganadores y medallas con el papel | 100 % tras correcciones; ≥ 95 % sin correcciones | |
| Combates retrasados por la app | 0 | |
| Segundos entre la señal del árbitro y el registro | ≤ 3 s (medir con un observador) | |
| Horas de preparación vs. proceso manual | ≥ 50 % menos | |
| Incidentes bloqueantes | 0 | |

### Plantilla de reporte de hallazgos

Para cada problema: **qué pasó**, **en qué pantalla**, **hora aproximada**,
**número de combate**, **qué se esperaba**, **captura de pantalla** si es
posible, y **gravedad** (bloqueó / molestó / cosmético). Se puede abrir como
*issue* en GitHub o mandarse en una lista; con eso se corrige en el siguiente
ciclo.
