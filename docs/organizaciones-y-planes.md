# Organizaciones, planes y autoinscripción por dojo

Cómo funciona la base del modelo de negocio ([modelo-negocio.md](modelo-negocio.md)):
quién es dueño de cada torneo, qué funciones cubre cada plan, cómo se pasa de
la marcha blanca al cobro y cómo inscriben los dojos por su cuenta.

## Organizaciones

Una **organización** es una liga, un dojo o un organizador (`kind`: `league`,
`dojo`, `organizer`) con país, zona horaria y moneda (por defecto Perú,
`America/Lima`, `PEN`) y un logo opcional (ruta o URL).

- **Cada torneo pertenece a una organización** (`tournaments.organization_id`).
  Al migrar (0009) se creó la «Organización principal» (`slug` `principal`) y
  se le asignaron todos los torneos que existían.
- Las **plantillas de categorías** pueden ser globales (`organization_id`
  vacío, visibles para todos) o de una organización.
- Un **dojo** puede estar afiliado a una liga (`dojos.organization_id`); hoy es
  solo informativo.
- Las **personas y los dojos siguen siendo compartidos** entre organizaciones:
  cada competidor tiene un solo historial en todos los torneos.

### Miembros y permisos

| Rol en la organización | Puede |
| --- | --- |
| `owner` (dueño) | Todo lo del administrador y nombrar o quitar dueños. Siempre queda al menos uno. |
| `admin` | Editar la organización, invitar miembros y cambiar roles (salvo dueños). Es **organizador de todos los torneos** de la organización y crea torneos en ella. |
| `member` | Leer todos los torneos de la organización (como un árbitro). |

- Se invita a **cuentas existentes** por nombre de usuario (`POST /organizations/{id}/members`).
- Solo el **Admin Global** crea organizaciones (`POST /organizations`).
- Un organizador también puede tener el rol `organizer` con ámbito
  `organization` (Usuarios → roles de la persona): equivale a ser admin de esa
  organización para sus torneos.
- **Crear un torneo** exige elegir una organización que el usuario administra
  (el Admin Global, cualquiera). Si se omite `organization_id`, se usa la única
  que administra; el Admin sin organizaciones y el organizador global de antes
  (compatibilidad) crean en la organización principal.
- La **lista de torneos** muestra solo lo que el usuario puede ver: sus
  organizaciones, más los torneos o tatamis donde tiene un rol.

## Planes y derechos (*entitlements*)

La tabla `plans` guarda los niveles con sus precios (configuración, no código)
y las funciones que incluye cada uno. Las **funciones con derecho** son:

| Función | Qué cubre | Dónde se verifica |
| --- | --- | --- |
| `organize_tournaments` | Organizar torneos | Crear un torneo |
| `multi_tatami` | Varios tatamis | Crear un torneo con más de un tatami; agregar el segundo tatami en adelante |
| `live_overlay` | Overlay para transmisiones | `GET /public/{token}/tatamis/{id}` (el vivo público básico sigue gratis) |
| `shadow_mode` | Shadow Mode | Registrar el resultado oficial del papel |
| `excel_import` | Importar inscripciones desde Excel | Subir el archivo |
| `dojo_self_registration` | Autoinscripción por dojo | Abrir la inscripción en línea, generar enlaces y enviar inscripciones |
| `plus_insights` | Análisis de Competidor Plus | (para las pantallas de Plus, por construir) |
| `certificates` | Certificados descargables | (por construir) |

| Plan | Para | Mensual | Anual | Funciones |
| --- | --- | --- | --- | --- |
| `marcha_blanca` | Todos | — | — | Todas (plan de fundadores o de pruebas) |
| `publico` | Todos | Gratis | Gratis | — |
| `competidor` | Personas | Gratis | Gratis | — |
| `competidor_plus` | Personas | S/ 9,90 | S/ 49 | `plus_insights`, `certificates` |
| `dojo` | Organizaciones | S/ 69 | S/ 690 | Todas las de organización |
| `organizador` | Organizaciones | S/ 149 | S/ 1 490 | Todas las de organización |

**Los precios son provisionales** (decisión abierta en el modelo de negocio).
Se cambian sin tocar el código: `PATCH /plans/{code}` con
`{"price_pen_month": 79, "price_pen_year": 790}` (Admin Global) o en la tabla.
Al arrancar, la app solo agrega los planes que falten del catálogo
(`app/services/entitlements.py`), nunca pisa precios.

En el código: `entitlements.has(db, sujeto, "función")` (sujeto: organización,
persona o cuenta) y `entitlements.require(...)`, que responde:

```json
HTTP 402
{"error": {"code": "PLAN_REQUIRED", "message": "Varios tatamis requiere el plan Dojo: …",
           "details": {"feature": "multi_tatami", "feature_name": "Varios tatamis",
                       "plan": "dojo", "plan_name": "Dojo", "organization_id": 3}}}
```

La interfaz muestra ese mensaje con un botón **«Ver planes»**. El **Admin
Global nunca se bloquea** (opera la plataforma).

### Marcha blanca y cómo pasar a `enforced`

`HAJIME_BILLING_MODE` (por defecto `marcha_blanca`):

- `marcha_blanca`: toda cuenta tiene todas las funciones; las suscripciones se
  registran pero no se exigen. Es lo que corre en pruebas y en la marcha blanca.
- `enforced`: una organización necesita una **suscripción vigente** (estado
  `trial` o `active` y `current_period_end` vacío o futuro) a un plan que
  incluya la función; Competidor Plus se verifica por persona (o por la cuenta).

Para el lanzamiento:

1. Asignar antes los planes de quienes participaron en la marcha blanca (por
   ejemplo `marcha_blanca` con fecha de fin, como beneficio de fundador) y los
   de las organizaciones que ya pagan (ver abajo).
2. Configurar `HAJIME_BILLING_MODE=enforced` en el ambiente (en Azure, variable
   del Container App; en local, `.env` o variable de entorno) y reiniciar.
3. Revisar que `GET /api/v1/plans` responda `"mode": "enforced"`.

Volver atrás es cambiar la variable a `marcha_blanca`: no se pierde nada.

### Asignar planes a mano

En la página **Organización** (Admin Global) → «Suscripciones»: elegir el
plan, el estado y la fecha de fin (vacía = sin vencimiento) y «Asignar plan».
«Pagado 1 mes» / «Pagado 1 año» extienden el periodo desde hoy o desde el fin
vigente y la dejan activa; «Cancelar» la corta. Por la API:

```bash
# Suscripción manual de una organización (o person_id / user_id para Competidor Plus)
POST /api/v1/subscriptions
{"organization_id": 3, "plan_code": "dojo", "status": "active", "current_period_end": "2027-01-31T23:59:59-05:00"}

# Pago confirmado a mano (proveedor manual): +30 o +365 días
POST /api/v1/subscriptions/{id}/mark-paid
{"period": "year", "reference": "Yape 123456"}

# Corregir estado, plan o vencimiento
PATCH /api/v1/subscriptions/{id}
{"status": "canceled"}
```

Todo queda en la auditoría (`entity = subscription`).

### Cobros

Ver **[cobros.md](cobros.md)**: pasarelas reales detrás de la interfaz
`payments.Provider` (`HAJIME_PAYMENT_PROVIDER`: `manual` por defecto,
`mercadopago` o `culqi`), comprobantes de SUNAT con Nubefact
(`HAJIME_INVOICING_PROVIDER`), cupones, 30 días de prueba para Dojo y
Organizador, gracia tras un pago rechazado (`HAJIME_BILLING_GRACE_DAYS`) y la
lista de lo que el dueño tiene que crear en cada pasarela.

- «Planes» → **«Suscribirse»** (mensual o anual, cupón): Mercado Pago redirige
  a su página; Culqi abre su Checkout en `/pago/culqi/:id`; el proveedor
  `manual` sigue mostrando instrucciones y el Admin marca pagado.
- «Organización»: datos fiscales (RUC, razón social, domicilio), estado del
  plan con **Renovar** y **Cancelar suscripción**, y el historial de **pagos y
  comprobantes** (PDF/XML) para dueños y administradores.
- «Pagos» (Admin Global): búsqueda, reembolsos, reemisión de comprobantes y
  cupones.
- Competidor Plus: el mismo flujo con la cuenta del usuario como titular
  (`POST /me/checkout`), con DNI opcional para la boleta.

## Autoinscripción por dojo

1. **El organizador abre la inscripción en línea** en la pestaña
   «Solicitudes» del torneo (con fecha y hora de cierre opcional, hora de
   Lima). Solo se abre con el torneo en borrador o con inscripciones abiertas.
2. **Genera enlaces de invitación**: uno por dojo o uno general, y los envía
   (por WhatsApp, por ejemplo). Se pueden revocar.
3. **El sensei abre el enlace** con su cuenta (que debe estar ligada a una
   persona):
   - enlace de un dojo sin administrador → queda como `dojo_admin` de ese dojo;
   - dojo que ya tiene otro administrador, o enlace general (elige su dojo) →
     queda un pedido que el organizador aprueba o rechaza en «Solicitudes».
4. **«Mis competidores»**: el sensei ve y edita a las personas con membresía
   vigente en su dojo, incluidos documento y fecha de nacimiento (que solo ven
   el dojo y el organizador), y da de alta nuevas (con la misma detección de
   duplicados; de un posible duplicado de otro dojo solo ve el nombre).
5. **«Inscribir en torneo»**: elige un torneo abierto, marca competidores y
   categorías (con las categorías sugeridas) y envía. Si hay advertencias
   (edad, grado, peso…), las ve igual que el organizador y puede continuar con
   un motivo. Las inscripciones quedan **pendientes** (`status = pending`).
6. **El organizador aprueba o rechaza en lote** (el rechazo pide motivo, que
   el sensei ve en «Mis inscripciones»). Las pendientes y rechazadas no entran
   a las llaves, a los conteos, a la lista normal de inscripciones ni al
   historial. No se aprueba en una categoría fusionada, cancelada o que ya
   tiene llave: se informa para resolverla a mano.

El aviso por correo al sensei queda para el servicio de correo:
`self_registration.notify_registration_decision` hoy solo lo registra en el log.

## Pendientes

- Nota de crédito automática al reembolsar y recibo por correo (ver
  [cobros.md](cobros.md#pendientes)).
- Crear plantillas de una organización desde la interfaz (la columna existe;
  hoy las crea el Admin como globales).
- Definir si la membresía de dojo incluye Competidor Plus para sus alumnos y
  en qué se diferencian los planes Dojo y Organizador (hoy incluyen lo mismo).
