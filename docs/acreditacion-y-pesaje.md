# Acreditación y pesaje

El día del torneo, antes de sortear las llaves, la mesa de acreditación marca
quién llegó y pesa a los competidores de kumite. Todo es **opcional**: si nadie
acredita, el torneo funciona igual que antes. Como en el resto de la app, se
advierte y no se bloquea.

## Datos

Cada inscripción (`registrations`) guarda:

| Campo | Qué es |
| --- | --- |
| `checkin_status` | `pending` (por defecto), `present` o `absent` |
| `checked_in_at`, `checked_in_by_id` | Cuándo y quién la marcó |
| `weight_kg`, `weighed_at` | Peso medido en la balanza oficial |
| `weigh_in_result` | `ok`, `over` (pasado) o `under` (debajo del mínimo) |
| `credential_code` | Código corto de la credencial (6 caracteres sin 0/O ni 1/I/L) |

Y el torneo (`tournaments`):

| Campo | Qué es |
| --- | --- |
| `checkin_required` | Check-in obligatorio: la verificación previa y las llaves avisan de los no acreditados |
| `weigh_in_tolerance_kg` | Tolerancia de peso (por defecto 0) |

**Rango de peso de una categoría.** Se lee de `weight_min_kg`/`weight_max_kg` si
la categoría los tiene (los agrega el trabajo de reglas deportivas); si no, se
deduce de la etiqueta `weight_class`: «-45» = hasta 45 kg, «+68» = más de 68 kg,
«45-50» = de 45 a 50 kg (`app/services/checkin.py`, `parse_weight_class`). Al
integrar ambos trabajos, `weight_range` usa las columnas y la etiqueta queda
solo como respaldo para categorías antiguas.

## La mesa de acreditación (tablet)

Torneo → pestaña **Acreditación**:

- **Buscador grande** por nombre o dojo (sin importar tildes). Escribir o leer
  un **código de credencial** y pulsar Enter acredita a la persona. Si la
  búsqueda deja una sola persona, Enter la marca presente.
- **QR:** el botón abre la cámara y lee el QR con la API `BarcodeDetector` del
  navegador (Chrome en Android, Safari 17+), sin librerías. Sin cámara o sin
  soporte se tipea el código; un lector USB también funciona (tipea y da Enter).
- **Una tarjeta por persona.** «Presente» es un toque y marca **todas** sus
  inscripciones del torneo (kumite y kata). Tocar de nuevo lo deshace.
  «Ausente» igual. Repetir un toque no cambia nada ni duplica la auditoría.
- **Peso:** campo con teclado numérico (acepta coma). El peso vale para todas
  sus categorías de kumite individual y, de paso, la acredita.
- **Filtros:** por dojo, pendientes, presentes, ausentes, fuera de peso.
  Contadores de presentes y ausentes por categoría al costado.
- **Ajustes** (menú ⋯): check-in obligatorio y tolerancia de peso.

### Fuera de peso

El peso se guarda igual y la respuesta trae una advertencia (`WEIGHT_OVER` o
`WEIGHT_UNDER`) con las **categorías sugeridas**: las mismas sugerencias de la
inscripción (sexo, edad, grado) filtradas por el rango de peso. El organizador:

- **Mueve** a una sugerida (`POST /registrations/{id}/weigh-in/move`, con motivo):
  usa la misma validación de inscripciones, que audita el cambio; o
- **Acepta** que compita donde está (`POST /registrations/{id}/weigh-in/accept`,
  con motivo): queda como advertencia aceptada `WEIGH_IN_OUT_OF_RANGE`.

Hasta resolverlo, la verificación previa muestra `WEIGHT_OUT_OF_RANGE`.

### Ausentes

- **Sin llave todavía:** al generar la llave, si hay ausentes, el servidor
  advierte (`ABSENT_ENTRANTS`). La app ofrece **Excluir ausentes**
  (`exclude_absent: true`): se retiran con el motivo «No se presentó» y no
  entran al sorteo; o incluirlos igual con motivo. Con check-in obligatorio,
  también advierte de los no acreditados (`NOT_CHECKED_IN`).
- **Con llave generada:** marcar ausente ofrece **Dar walkover**
  (`POST /registrations/{id}/no-show`): retira con «No se presentó» y reutiliza el
  walkover por retiro en todos sus combates pendientes.

Quien «no se presentó» no recibe certificado de participación ni puntos de
ranking.

## Credenciales

`/torneos/:id/credenciales` muestra la vista previa y abre el PDF
(`GET /tournaments/{id}/credentials.pdf`, 8 por hoja A4, con línea de corte):
nombre, dojo, categorías y QR con el código. Se puede filtrar por dojo para
ensobrarlas. El QR se genera en el servidor con el generador que ya trae
reportlab: sin dependencias nuevas.

Cada inscripción tiene su código único; la credencial lleva el de la primera
inscripción de la persona. Leer cualquiera de sus códigos la acredita en todas.

## API

| Método y ruta | Uso |
| --- | --- |
| `GET /tournaments/{id}/checkin?dojo_id&category_id&status&q&out_of_weight` | Lista y contadores por categoría |
| `POST /tournaments/{id}/checkin` `{registration_ids, status, whole_person}` | Marcar en lote |
| `POST /registrations/{id}/checkin` `{status, whole_person}` | Marcar una |
| `POST /tournaments/{id}/checkin/scan` `{code}` | Acreditar por código o QR |
| `POST /registrations/{id}/weigh-in` `{weight_kg}` | Pesar |
| `POST /registrations/{id}/weigh-in/move` `{category_id, reason}` | Mover por peso |
| `POST /registrations/{id}/weigh-in/accept` `{reason}` | Aceptar fuera de peso |
| `POST /registrations/{id}/no-show` | Ausente con llave: retiro y walkover |
| `GET /tournaments/{id}/credentials[.pdf]?dojo_id` | Credenciales |

Todo lo anterior es del organizador del torneo (o el Admin) y queda auditado.

## Verificación previa

`GET /tournaments/{id}/readiness` agrega:

- `NOT_CHECKED_IN` (advertencia), solo con check-in obligatorio.
- `WEIGHT_OUT_OF_RANGE` (advertencia): pesos fuera de rango sin mover ni aceptar.
