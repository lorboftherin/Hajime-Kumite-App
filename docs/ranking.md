# Ranking por temporada y liga

Una **temporada** (o liga) suma los resultados de varios torneos: ranking de
competidores por categoría y ranking de dojos («mejor academia»). Se configura
en la página **Ranking** (Admin y organizadores) y, si se marca pública, se ve
sin iniciar sesión en `/ranking/<enlace>`.

## Configuración (`ranking_seasons`)

| Campo | Qué es |
| --- | --- |
| `name`, `year`, `slug` | Nombre, año y enlace público (se genera del nombre y el año) |
| `tournament_ids` | Torneos que cuentan. Vacío = **todos los que no son de prueba** entre `date_from` y `date_to` (o del año) |
| `points` | Puntos por lugar: oro 10, plata 7, bronce 5, participación 1 (por defecto) |
| `multipliers` | Por torneo: `{"12": 2}` hace que el nacional valga doble |
| `min_entrants_walkover_gold` | Mínimo de competidores para puntuar un podio **sin combate** (por defecto 2) |
| `is_public` | Vista pública sin inicio de sesión |

## Cómo se cuentan los puntos

- Solo cuentan las **categorías finalizadas**.
- El podio recibe los puntos de su lugar; el resto de quienes **compitieron**
  recibe los de participación. Compitió: tiene puesto, o siguió inscrito y no
  fue marcado ausente, o se retiró después de pelear (lesión). Quien «no se
  presentó» no suma.
- **Podio sin combate:** si el competidor no peleó ningún combate (ganó por
  walkover o era el único inscrito) y la categoría tuvo menos de
  `min_entrants_walkover_gold` competidores, cuenta como participación.
- Cada resultado se multiplica por el multiplicador de su torneo.
- En categorías por equipos, cada integrante suma los puntos del equipo; el
  dojo los suma una sola vez.
- **Desempate:** puntos, luego oros, platas y bronces. Mismo total = mismo puesto.

## Categoría equivalente

Para sumar resultados de torneos distintos, cada categoría se agrupa por sus
atributos: **modalidad, individual/equipos, sexo, rango de edad, rango de grado
y rango de peso** (el mismo de la acreditación: columnas `weight_min_kg`/
`weight_max_kg` o la etiqueta `weight_class`). Así «Kumite 12-13 M -45» de un
torneo y «Nacional Kumite -45» de otro suman juntas.

- La **etiqueta** es el nombre de la categoría de la plantilla si la categoría
  vino de una (mismo código en la plantilla del torneo); si no, su nombre.
- Una categoría **sin edad ni peso** (un «Open») no tiene con qué compararse: se
  agrupa por el nombre de la plantilla o, sin plantilla, por su código.

## Cálculo y caché

`app/services/ranking.py` calcula la temporada completa en unas diez consultas
(torneos, categorías, plantillas, podios, combates, kata e inscripciones) y
guarda el resultado materializado en `ranking_entries` (una fila por persona y
categoría equivalente, y una por dojo).

La temporada guarda una **huella** de los resultados con que se calculó
(cantidad y última modificación de los podios de sus torneos, más su propia
versión). Al leerla se compara con la actual en una consulta: si una categoría
se cerró o se reabrió, o cambió la configuración, se recalcula en ese momento
(«al cerrar una categoría» sin tocar el código de las llaves). También se puede
forzar con «Recalcular ahora» (`POST /ranking/seasons/{id}/recompute`).

## Nombres y privacidad

- Admin y organizadores ven nombres completos.
- El resto de usuarios y la vista pública ven a los **menores abreviados**
  («Diego R.», la misma regla del vivo público). La edad se calcula al cierre de
  la temporada; sin fecha de nacimiento se asume menor.
- La vista pública no expone multiplicadores ni la lista interna de ids.

## API

| Método y ruta | Uso |
| --- | --- |
| `GET /ranking/seasons` | Temporadas |
| `POST /ranking/seasons` · `PATCH/DELETE /ranking/seasons/{id}` | Configurar (Admin y organizadores) |
| `GET /ranking/seasons/{id}?modality&group` | Categorías equivalentes, tabla de personas y de dojos |
| `POST /ranking/seasons/{id}/recompute` | Recalcular ya |
| `GET /persons/{id}/ranking` | Puesto de la persona en cada temporada (perfil) |
| `GET /public/ranking/{slug}` | Vista pública (solo temporadas públicas) |

En la app: menú **Ranking** (selector de temporada, modalidad y categoría; tabla
de competidores y de dojos) y pestaña **Diplomas y ranking** del perfil de la
persona, con su puesto.
