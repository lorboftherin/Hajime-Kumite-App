# Revisión del Documento Maestro v0.2

Revisión técnica hecha al iniciar la construcción (24/09/2026). El documento
está listo para construir: los principios, el alcance por incrementos y el plan
de pruebas son claros y coherentes entre sí. Lo que sigue son ambigüedades,
vacíos y decisiones que tomé para avanzar. Todo lo que decidí es configurable
o fácil de revertir.

## 1. Veredicto

| Aspecto | Estado |
| --- | --- |
| Visión, principios, alcance MVP | ✅ Claros y consistentes |
| Modelo de datos (sección 24) | ✅ Suficiente para el ERD; implementado con 29 tablas |
| Algoritmo de llaves (sección 17) | ⚠️ El paso 3 tal como está escrito no es óptimo (ver 2.1) |
| Reglas de kumite y kata | ⚠️ Hay 3 puntos a confirmar contra el reglamento (ver 2.2–2.4) |
| Protección de datos | ⚠️ Falta la validación legal (depende de ti) |
| Decisiones abiertas (sección 30) | Tomé las propuestas del documento como valores por defecto (ver 3) |

## 2. Ambigüedades e inconsistencias encontradas

### 2.1 Separación por dojo: "repartir en la secuencia" no alcanza (sección 17, paso 3)

Ordenar los dojos de mayor a menor y repartir a sus competidores siguiendo la
secuencia de siembra deja cruces evitables. Ejemplo con 8 inscritos (dojos
A=3, B=3, C=2): el reparto directo pone a dos de B juntos en primera ronda,
cuando existe una llave sin ningún cruce.

**Implementado:** partición recursiva. En cada nivel (mitades, luego cuartos,
etc.) cada dojo se reparte lo más parejo posible entre ambos lados, respetando
la capacidad de cada lado y los byes. Resultado verificado con 200 llaves
aleatorias de 2 a 64 inscritos: el número de cruces del mismo dojo en primera
ronda es siempre el mínimo matemático. Además, el caso del guion "4 de 8 del
mismo dojo" deja a los 4 en cuartos distintos.

### 2.2 Kata por puntuación con 7 jueces (sección 19)

El documento dice que con 5 o 7 jueces se descarta una nota alta y una baja.
Hasta donde sé, el reglamento WKF con 7 jueces descarta **dos** altas y **dos**
bajas, y además cada juez puntúa por separado desempeño técnico (70 %) y
atlético (30 %). **Implementado:** lo del documento como valor por defecto, con
`discard_each_side` configurable por torneo. **Por confirmar:** qué reglamento
usan los torneos objetivo.

### 2.3 "Subir" y "bajar" de nivel (sección 14)

"Bajar de nivel (kyu menor al mínimo de la categoría)" es ambiguo: un kyu con
número menor es un grado *más alto*. **Implementado** así, ambos como
advertencia con override:

- `GRADE_BELOW_MIN`: grado menor al de la categoría → **sube** de nivel (requiere autorización).
- `GRADE_ABOVE_MAX`: grado mayor al de la categoría → **baja** de nivel.

### 2.4 Senshu

La tabla de empate menciona "senshu + hantei", pero no dice cuándo se pierde
el senshu. **Implementado:** el senshu se asigna al primer punto sin respuesta
y existe el evento `senshu_cancel` para que la mesa lo retire cuando el árbitro
lo indique.

### 2.5 Regla de terceros lugares en round robin y kata por rondas

"Dos bronces" no tiene sentido en round robin, porque ahí hay una
clasificación completa (1.º, 2.º, 3.º…). **Implementado:**

- Round robin: oro, plata y un bronce al 3.º. Un empate sin resolver en los tres primeros deja la categoría sin cerrar hasta que el organizador decida.
- Kata por rondas: con "dos bronces" reciben bronce el 3.º y el 4.º; con "combate por el tercer puesto", solo el 3.º.

**Por confirmar:** si en round robin de 4 o 5 el 4.º también debe llevar bronce.

### 2.6 Repechaje en llaves pequeñas

Si un finalista solo venció a su rival de semifinal (por ejemplo, entró con
bye), no hay escalera de repechaje. **Implementado:** en ese caso el perdedor
de semifinal recibe el bronce directamente.

### 2.7 Categoría con un solo inscrito

El documento no lo cubre. **Implementado:** si se genera la llave con 1
inscrito, es campeón sin combates, y la categoría muestra el consejo
"fusionar / cancelar / mantener". **Por confirmar:** si ese oro cuenta en el
medallero (en muchos torneos locales sí).

### 2.8 Transiciones de estado del torneo

No hay transición de *En curso* a *Cancelado* (por ejemplo, un torneo
suspendido por fuerza mayor). Lo dejé fuera, tal como está el diagrama.
Agregarlo es una línea.

### 2.9 Numeración de combates para la comparación con el papel

Para comparar en Shadow Mode conviene que cada combate tenga un número visible
que la mesa oficial también use (por ejemplo, "T1-014"). Hoy cada combate
tiene un código dentro de su categoría (`R1-3`, `3P`, `REPA-1`). **Sugerencia:**
agregar un correlativo por tatami en MVP-2.

### 2.10 Medición del "≤ 3 s por evento"

La app guarda la hora del dispositivo y la hora de recepción de cada evento,
pero no la señal del árbitro. **Sugerencia:** medirlo con un observador o con
video durante el mock.

## 3. Decisiones abiertas (sección 30): qué dejé configurado

| Decisión | Valor por defecto aplicado | Dónde se cambia |
| --- | --- | --- |
| Terceros lugares | Dos bronces | Torneo (`default_third_place_rule`) y categoría |
| Escala de sanciones | Chui 1, Chui 2, Chui 3, Hansoku-chui, Hansoku | `kumite_rules.sanction_levels` del torneo o categoría |
| Rango de notas de kata | 5.0 a 10.0, un decimal | `kata_defaults.min_score/max_score` |
| Fecha de referencia de edad | Día del torneo | `age_reference_date` del torneo |
| Autenticación | Cuentas propias con JWT | `app/security.py` (migrar a Entra ID/Google solo toca ese módulo y el login) |
| Dispositivo de mesa | Tablet horizontal y laptop (diseño responsivo) | — |
| Plantilla de categorías | **Borrador** de 68 categorías (6–7 a Senior, pesos tipo WKF, bandas 10–7 kyu / 6 kyu+ en niños) | `python -m app.seed template`; editable como datos |
| Consentimiento de menores | Se registra quién, fecha, medio y alcance (`data_consents`) | Falta la validación legal |

## 4. Decisiones técnicas que tomé (y conviene que confirmes)

1. **Stored procedures.** La sección 22 pide SP para la persistencia. Empecé
   con SQLAlchemy (ORM y transacciones en Python), sin SP: acelera el MVP y
   permite correr todos los tests sin SQL Server. El principio clave sí se
   cumple: la base de datos nunca decide un resultado deportivo. Propongo
   agregar SP solo donde el volumen lo pida (medallero, historial, reportes),
   sin cambiar la API.
2. **Esquema.** `sql/001_schema.sql` se genera desde los modelos
   (`backend/scripts/export_ddl.py`). Cuando haya datos reales en PROD
   conviene pasar a migraciones con Alembic.
3. **Identificadores.** Enteros autoincrementales en todas las entidades,
   excepto los eventos de combate, que usan el UUID generado por el
   dispositivo (idempotencia y preparación offline).
4. **Advertencias.** Toda regla de negocio devuelve HTTP 409 con
   `code: "WARNINGS"`. El cliente reenvía la misma petición con
   `override: {reason}` y cada advertencia aceptada queda en `rule_overrides`.
   Solo se bloquea lo que corrompe datos: documento repetido, combate sin dos
   participantes, editar una posición cuyo combate ya empezó.
5. **Corrección tardía.** Cambiar el ganador de un combate cerrado muestra los
   combates siguientes afectados. Si el organizador acepta, esos combates
   pasan a `needs_review` y conservan sus eventos. El organizador los vuelve a
   cerrar con el ganador correcto.
6. **Nombre del proyecto.** Usé "Hajime" (nombre del repositorio).

## 5. Lo que queda para ti (no lo puedo hacer yo)

1. **Validar la plantilla de categorías** con los torneos objetivo: edades,
   pesos, bandas de grado y duración de combates.
2. **Confirmar el reglamento:** sanciones, senshu, kata con 7 jueces y bronce
   en round robin (puntos 2.2, 2.4 y 2.5).
3. **Asesoría legal (Ley 29733):** consentimiento de menores y registro del
   banco de datos ante la autoridad. Hasta donde sé, el reglamento de la ley
   se actualizó recientemente (DS 016-2024-JUS); confírmalo con el asesor.
   Es obligatorio antes de cargar datos reales en PROD.
4. **Azure:** crear la suscripción y los recursos (Azure SQL, App Service o
   Container Apps, Static Web Apps) y cargar los secretos
   (`HAJIME_JWT_SECRET`, `HAJIME_DATABASE_URL`). Ver `docs/despliegue.md`.
5. **GitHub:** revisar y aprobar el PR, y activar la protección de la rama
   principal.
6. **Probar en campo:** el torneo mock en un entrenamiento, con una tablet
   real, siguiendo el guion de la sección 27.
7. **Confirmar** la decisión sobre stored procedures (punto 4.1).
