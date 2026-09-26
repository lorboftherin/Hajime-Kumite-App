# Reglas deportivas configurables

Las decisiones de reglamento siguen abiertas (documento maestro §30 y
revisión v0.2 §2). Por eso **toda regla deportiva nueva es configurable por
torneo, con override por categoría**, y su valor por defecto mantiene el
comportamiento anterior salvo cuando lo anterior era un error (se indica).

La herencia es siempre la misma: valor por defecto del sistema → valor del
torneo → valor de la categoría (el más específico gana). En la API los
valores por defecto se publican en `GET /api/v1/rules/defaults`.

| Grupo | Torneo | Categoría |
| --- | --- | --- |
| Kumite | `kumite_rules` | `kumite_rules` (+ `duration_seconds`) |
| Kata | `kata_defaults` | `kata_rules` (+ `kata_method`, `kata_structure`, `kata_judges`) |
| Llaves, round robin, repechaje, separación | `competition_rules` | `competition_rules` |
| Edad | `age_mode` | — |
| Formato | `default_format` | `format` |
| Cupo y peso | — | `max_entrants`, `weight_class`, `weight_min_kg`, `weight_max_kg` |

Los valores inválidos se rechazan con `409 INVALID_RULES` y un mensaje en
español (p. ej. jueces de kata distintos de 3, 5 o 7).

## Kumite (`kumite_rules`, §18)

| Opción | Valores | Por defecto | Decisión abierta |
| --- | --- | --- | --- |
| `duration_seconds` | segundos | 120 (o la de la categoría) | — |
| `time_mode` | `effective` / `running` | `effective` | — |
| `auto_pause_on_point` | sí / no | sí | — |
| `point_values` | subconjunto de 1, 2, 3 | `[1, 2, 3]` | **Corrección:** antes se ignoraba la configuración. |
| `lead_victory` | puntos o `null` | 8 | — |
| `tie_rule` | `hantei` / `golden_point` / `senshu_hantei` | `hantei` | §30 empate |
| `sanction_levels` | lista de niveles | Chui 1, Chui 2, Chui 3, Hansoku-chui, Hansoku | §30 escala de sanciones |
| `sanction_preset` | `single` / `two_categories` | `single` (una escalera, como hasta ahora) | §30 escala de sanciones |
| `sanction_levels_c2` | lista de niveles | la misma que `sanction_levels` | ídem |
| `senshu_auto_loss` | sí / no | no (la mesa usa «quitar senshu») | revisión §2.4 |
| `senshu_loss_level` | nivel 1..n | 1 | ídem |
| `senshu_loss_last_seconds` | segundos | 15 | ídem |
| `golden_point_seconds` | segundos (0 = sin límite) | 60 | §30 empate |

**Tipo de falta.** Cada sanción puede llevar un tipo (opcional): contacto
excesivo (categoría 1), jogai, mubobi, simulación, evasión (categoría 2) u
otra (la mesa elige la escalera). Con `two_categories` cada categoría tiene su
propia escalera y el hansoku llega por cualquiera de las dos; con `single`
todo va a la misma escalera y el tipo solo queda registrado.

**Senshu automático.** Si está activo, el poseedor del senshu lo pierde al
recibir una sanción de nivel ≥ `senshu_loss_level` en los últimos
`senshu_loss_last_seconds` del tiempo reglamentario.

**Punto de oro.** Con `tie_rule = golden_point`, al empatar la mesa inicia el
periodo extra (evento `golden_point`). El reloj pasa a durar
`duration_seconds + golden_point_seconds`; el primer punto sugiere cerrar con
método «punto de oro». Si el periodo termina sin puntos, se sugiere hantei.

**Hantei con votos.** El evento `hantei` puede llevar los votos de 3 o 5
jueces (`votes`, opcional, solo registro). El color del hantei debe coincidir
con la mayoría de los votos emitidos.

**Cierre por hantei o decisión.** *Corrección:* antes no se validaba contra
el marcador; ahora se advierte (override) si el marcador indica otro ganador.

### Kumite por equipos (también en `kumite_rules`, §15)

| Opción | Valores | Por defecto |
| --- | --- | --- |
| `team_bouts` | 3 o 5 | 3 |
| `team_tie_rule` | `points` / `extra_bout` | `points` |
| `team_extra_bout_tie` | `hantei` / `repeat` | `hantei` (WKF). Antes se repetía el combate extra. |
| `team_empty_slot_walkover` | sí / no | sí: puesto vacío = walkover del rival con el marcador de la victoria por diferencia (8–0); sin nadie de ambos lados, combate no disputado (0–0). |
| `team_lock_order` | sí / no | sí: el orden declarado no cambia tras empezar el primer combate (salvo override). |
| `team_min_starters` | número o `null` | `null` (sin mínimo). Con mínimo, el equipo que no lo completa pierde el enfrentamiento (`incomplete_team`). |

Los combates que faltan cuando el enfrentamiento ya está decidido quedan
«no disputados» (estado `void`, método `not_disputed`) y salen de la cola del
tatami; si una corrección deja el enfrentamiento sin decidir, vuelven.

## Kata (`kata_defaults` / `kata_rules`, §19)

| Opción | Valores | Por defecto | Decisión abierta |
| --- | --- | --- | --- |
| `method` | `flags` / `scores` | `flags` | — |
| `structure` | `bracket` / `rounds` | `bracket` | — |
| `judges` | 3, 5 o 7 | 3 (banderas) / 5 (puntuación) | — |
| `min_score`, `max_score` | notas con un decimal | 5.0 y 10.0 | §30 rango de notas |
| `discard_each_side` | 0, 1 o 2 | 1 con 5 o 7 jueces, 0 con 3 | revisión §2.2 |
| `preset` | `wkf` o nada | nada | revisión §2.2 |
| `split` | sí / no | no | revisión §2.2 |
| `technical_weight` | 0–1 | 0.7 | ídem |
| `rounds` | lista de clasificados por ronda | `[]` (ronda única) | §19 rondas |
| `first_round_groups` | 1 a 4 | 1 | ídem |
| `round_order` | `reverse_rank` / `rank` / `random` | `reverse_rank` | ídem |
| `no_repeat_kata` | sí / no | no | §19 registro del kata |
| `flags_judges` | 3 o 5 | 3 | — |

- **Preset `wkf`:** 7 jueces, se descartan 2 notas altas y 2 bajas, y cada
  juez da dos notas (técnica y atlética). Cada serie se suma por separado y
  el total es técnico × 0.7 + atlético × 0.3 (dos decimales). Desempate:
  mayor técnica, luego mayor atlética (por confirmar con el reglamento).
  Lo que se fije explícitamente (p. ej. `judges: 5`) manda sobre el preset.
- **Puntuación en llave:** con método `scores` y estructura `bracket`, aka y
  ao reciben la nota del panel (`POST /matches/{id}/kata-scores`) y gana la
  mayor con los desempates de la puntuación; si siguen empatados decide el
  juez principal.
- **Banderas en una categoría por puntuación:** *corrección*; antes se decidía
  por banderas con 3 jueces sin aviso. Ahora es una excepción con override
  (`KATA_METHOD_MISMATCH`).
- **Rondas múltiples:** `rounds: [8, 4]` = pasan 8 a la 2.ª ronda y 4 a la
  final. Con `first_round_groups: 2` la primera ronda se divide en dos grupos
  y cada uno aporta la mitad de los clasificados. Las notas no se arrastran.
  La ronda siguiente se arma sola al completar la anterior; un empate en el
  corte la detiene hasta que el organizador lo resuelva (desempate manual).
  Si una corrección cambia los clasificados y la ronda siguiente ya tiene
  notas, se marca para revisión.
- **Orden de salida:** `PUT /categories/{id}/kata-order` (lista completa) o
  intercambio de dos posiciones (`PATCH /brackets/{id}/slots`); no se mueve a
  quien ya ejecutó.
- **Catálogo de katas:** `backend/app/data/katas.json` (Shotokan, Goju-ryu,
  Shito-ryu, Wado-ryu), editable como datos; `GET /kata-catalog`.

## Llaves y categorías (`competition_rules`, §17)

| Opción | Valores | Por defecto | Decisión abierta |
| --- | --- | --- | --- |
| `round_robin_criteria` | orden de: `wins`, `head_to_head`, `diff`, `points_for`, `fewer_sanctions`, `draw` | `wins, head_to_head, diff, points_for` | §17 round robin |
| `round_robin_bronzes` | 1 o 2 | 1 | revisión §2.5 |
| `round_robin_two_bronzes_min` | inscritos | 5 | ídem |
| `repechage_excluded_methods` | métodos | `kiken, shikkaku, hansoku` (WKF) | §17 terceros lugares |
| `separation` | `["dojo"]` o `["dojo", "city"]` | `["dojo"]` | revisión §2.1 |
| `groups` | 2 a 16 | 2 | §17 formatos |
| `group_qualifiers` | 1 a 4 | 2 | ídem |
| `shikkaku_tournament_wide` | sí / no | no | — |

- **Desempate de round robin:** los criterios se aplican en cascada; cada uno
  solo separa a quienes siguen empatados. `draw` es un sorteo reproducible
  con la semilla de la llave. Un empate sin resolver en las medallas deja la
  categoría abierta para que decida el organizador.
- **Repechaje:** quien perdió ante un finalista por un método excluido no
  entra al repechaje. Si en una mitad queda un solo rival elegible, recibe el
  bronce directo; si no queda ninguno, esa mitad no da bronce. *Cambia el
  comportamiento anterior (antes todos entraban), alineándolo con WKF.*
- **Separación por ciudad:** segundo criterio que solo desempata entre
  repartos igual de buenos por dojo. Sin ciudades la llave es idéntica a la
  que se generaba antes con la misma semilla.
- **Grupos + eliminación (`groups_knockout`):** N grupos todos contra todos
  (reparto parejo con separación por dojo y cabezas de serie en
  serpentina); pasan K por grupo a una llave de eliminación con cruces
  A1–B2, B1–A2 (dos del mismo grupo nunca se cruzan en primera ronda y, si
  se puede, quedan en mitades distintas). La fase final se arma al terminar
  todos los grupos y usa la regla de terceros lugares de la categoría.
- **Doble eliminación:** fuera de alcance (documento maestro §17, «a
  evaluar»). No se implementa.

### Cambios con la llave generada

- **Regenerar** solo si no hay combates iniciados; si los hay, el mensaje
  indica las operaciones puntuales.
- **Añadir a la llave** (`POST /categories/{id}/bracket/entrants`): ocupa un
  bye de primera ronda no disputado (y cuyo camino no empezó), eligiendo el
  que deja al nuevo más lejos de su dojo (y ciudad). Round robin: se agregan
  sus combates. Rondas de kata: entra al final del orden de la primera ronda.
- **Quitar de la llave** (`POST /categories/{id}/bracket/entrants/remove`):
  si su primer combate no empezó, su lugar queda como bye; si ya ganó, pierde
  por walkover su combate pendiente (o se registra solo en cuanto se conozca
  al rival). Round robin: se anulan sus combates pendientes y deja de
  clasificar (si ya había disputado todos, su tabla no cambia).
- **Cambio de categoría el día del torneo:** `PATCH /registrations/{id}` con
  `category_id` advierte (`BRACKET_MOVE_OUT` / `BRACKET_MOVE_IN`) y, con
  override, sale de una llave y entra a la otra con las operaciones anteriores.
- **Descalificación del torneo (shikkaku):** `POST /registrations/{id}/disqualify`
  retira todas sus inscripciones activas del torneo (bye o walkover en cada
  llave), con confirmación.
- **Walkover automático:** un combate listo y sin eventos en el que un lado
  ya no compite en la categoría (quitado, retirado, descalificado o movido)
  se cierra solo por walkover al cerrar otro combate de la categoría.
- Cada cambio guarda una versión nueva de la llave.

### Categorías

| Opción | Dónde | Por defecto | Decisión abierta |
| --- | --- | --- | --- |
| `age_mode` | torneo: `date` / `birth_year` | `date` (edad a la fecha de referencia) | §30 fecha de referencia |
| `max_entrants` | categoría | sin cupo | — |
| `weight_min_kg` / `weight_max_kg` | categoría | se deducen de la etiqueta | — |

- **`birth_year`:** edad = año de la fecha de referencia − año de nacimiento.
  Cambiar el modo recalcula la edad de todas las inscripciones.
- **Cupo:** al superarlo se advierte al inscribir (`CATEGORY_FULL`) y al
  generar la llave, y la categoría sugiere dividir.
- **Dividir** (`POST /categories/{id}/split`): por peso declarado, por grado o
  por sorteo (separando dojos). La original conserva la primera mitad y la
  nueva recibe la segunda; los rangos de peso o grado se ajustan al corte.
  Se deshace con `POST /categories/{id}/unsplit` si no hay combates iniciados.
- **Rango de peso:** la migración `0010_reglas_deportivas` lo deduce de las etiquetas
  existentes (`-45` = hasta 45 kg, `+84` = más de 84 kg, `45-50`). El pesaje
  real lo hará un trabajo posterior.
- **Sugerencias sin peso:** *corrección*; la sugerencia manual ignoraba el
  peso pero la importación lo exigía. Ahora, sin peso declarado, ambas
  sugieren las categorías compatibles en todo lo demás y la importación avisa
  que falta confirmar la categoría de peso. Con peso declarado, se filtra.

## Estadísticas (correcciones)

- El índice Hajime no suma una victoria por walkover (`walkover_win` = 0) ni
  una medalla sin competir (`uncontested_medal` = 0, p. ej. oro con un solo
  inscrito). Ambos pesos están en `MVP_WEIGHTS` por si se quiere dar un valor
  mínimo.
- La insignia «Primer combate» exige un combate disputado (o un kata
  ejecutado); inscribirse ya no basta.
- «Victoria más rápida» solo cuenta cierres por ippon, diferencia de puntos o
  hansoku, y compara la fracción del tiempo de la categoría (no segundos
  absolutos).
- «Mejor kata» compara el promedio por nota contada (total ÷ notas que
  suman), para no favorecer a paneles con más jueces.
