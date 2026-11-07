# Cobros: pasarelas, comprobantes, cupones y prueba gratis

> **Desactivado por decisión del dueño.** Por ahora Hajime no cobra: sin
> pasarela, sin suscripciones pagadas y sin comprobantes. El código sigue en
> el repositorio y se enciende con una variable (`HAJIME_PAYMENTS_ENABLED`,
> `false` por defecto). Ver [Cobros apagados y cómo activarlos](#cobros-apagados-y-cómo-activarlos).

## Cobros apagados y cómo activarlos

Con `HAJIME_PAYMENTS_ENABLED=false` (el valor por defecto):

- **Planes y derechos:** todo permitido, como en la marcha blanca, **aunque
  `HAJIME_BILLING_MODE=enforced`**: la API nunca responde 402 (sin forma de
  pagar, exigir un plan sería bloquear). Si alguien configura `enforced` con
  los cobros apagados, la API lo avisa en el log al arrancar (`hajime.pagos`,
  nivel WARNING) y lo ignora. `GET /plans` y `GET /billing/config` informan el
  modo efectivo (`marcha_blanca`).
- **API:** estas rutas siguen publicadas en el contrato (`docs/openapi.json`)
  pero responden **404** con el código `PAYMENTS_DISABLED` y el mensaje «Los
  cobros no están activos» (dependencia `COBROS` en `app/api/routers/billing.py`):

  | Ruta | Qué hace |
  | --- | --- |
  | `GET /plans/{code}/quote` | Precio con cupón antes de pagar |
  | `POST /organizations/{id}/checkout`, `POST /me/checkout` | Contratar o renovar |
  | `POST /organizations/{id}/trial` | Prueba gratis |
  | `POST /subscriptions/{id}/cancel` | Cancelación por el titular |
  | `POST /payments/culqi/charge` | Cargo de Culqi |
  | `POST /payments/webhook/{pasarela}` | Avisos de Mercado Pago y Culqi |
  | `POST /payments/{id}/refund` | Reembolso |
  | `POST /payments/{id}/invoice`, `POST /invoices/{id}/refresh` | Emitir o consultar comprobantes |
  | `GET/POST /coupons`, `PATCH /coupons/{id}` | Cupones |

  Se dejaron en el router (en vez de quitarlas) para que el contrato de la API
  no cambie al activar los cobros y para que la respuesta diga el motivo.
- **Siguen funcionando:** `GET /billing/config` (sin sesión, con
  `payments_enabled: false`), `GET /billing/alerts` (siempre vacío), las
  lecturas de suscripciones y del historial de pagos que hubiera, y la
  **asignación manual** del Admin Global (`POST/PATCH /subscriptions`,
  `POST /subscriptions/{id}/mark-paid`, `PATCH /plans/{code}`): no cobra nada
  ni envía correos, y sirve para dejar anotados los planes de fundadores.
- **Correos:** no sale ninguno de cobro (pago recibido o rechazado, gracia,
  «tu plan vence»). Los avisos de vencimiento no se revisan ni se reservan:
  al activar los cobros sale el que toque ese día.
- **Interfaz:** la app lee `GET /billing/config` al arrancar
  (`frontend/src/app/core/payments.ts`; si no responde, se considera apagado).
  Se ocultan el menú «Pagos», el aviso «tu plan vence», «Suscribirse»,
  «Probar gratis», cupones, «Mi Competidor Plus», «Renovar» / «Cancelar
  suscripción», «Pagos y comprobantes» y «Datos para el comprobante» en
  «Organización», y el botón «Ver planes» del aviso de plan requerido. Las
  rutas `/pago/*` y `/pagos` llevan al inicio. «Planes» queda como página
  informativa con el aviso «Durante la marcha blanca todo está incluido sin
  costo.».

**Cómo activarlos** (cuando el dueño decida cobrar):

1. Hacer lo de [acciones-del-duenio.md](acciones-del-duenio.md#cuando-se-decida-cobrar)
   y probar todo en TEST (ver [De la marcha blanca al cobro real](#de-la-marcha-blanca-al-cobro-real)).
2. En el ambiente: `HAJIME_PAYMENTS_ENABLED=true` (variable del Container App)
   y reiniciar. Con eso vuelven las rutas, los correos y la interfaz de pagos;
   la exigencia de planes sigue dependiendo de `HAJIME_BILLING_MODE`.
3. Comprobar `GET /api/v1/billing/config` → `"payments_enabled": true`.

Volver a apagarlos es poner la variable en `false`: los pagos, suscripciones y
comprobantes quedan registrados y todo vuelve a estar permitido.

Cómo se cobra la membresía de organización (Dojo, Organizador) y Competidor
Plus, cómo se emiten las boletas y facturas de SUNAT y qué tiene que hacer el
dueño para activarlo. La base (planes, derechos, marcha blanca) está en
[organizaciones-y-planes.md](organizaciones-y-planes.md).

## Resumen

| Pieza | Dónde | Selección |
| --- | --- | --- |
| Pasarela de pagos | `app/services/payments.py` (interfaz `Provider`) y `app/services/gateways/` | `HAJIME_PAYMENT_PROVIDER`: `manual` (por defecto), `mercadopago`, `culqi` |
| Comprobantes electrónicos | `app/services/invoicing.py` (interfaz `invoicing.Provider`) | `HAJIME_INVOICING_PROVIDER`: `none` (por defecto), `nubefact` |
| Precios, cupones, prueba, checkout | `app/services/checkout.py` | tablas `plans`, `coupons` |
| API | `app/api/routers/billing.py` | — |
| Interfaz | «Planes» → «Suscribirse»; `/pago/…`; «Organización» → «Pagos y comprobantes»; «Pagos» (Admin) | — |

Reglas que no cambian con la pasarela:

- **Nada de datos de tarjeta en el servidor.** Mercado Pago cobra en su página;
  Culqi Checkout (en el navegador) entrega un token de un solo uso. En
  `payments.raw` se guarda solo una lista blanca de campos (estado, monto,
  referencias): ni número, ni BIN, ni últimos dígitos, ni titular, ni el
  documento del pagador.
- **Nunca se confía solo en el aviso (webhook).** Primero se verifica la firma
  (o la autenticación) y luego se consulta el pago a la API de la pasarela;
  el estado sale de esa consulta.
- **Idempotente.** Cada pago queda en `payments` con el id de la pasarela
  (`provider_ref`, único): el mismo aviso dos veces no crea otra fila ni
  extiende otra vez el periodo. Las llamadas a la pasarela llevan clave de
  idempotencia (`X-Idempotency-Key`) y se reintentan con la misma clave.
- **Auditoría** de todo: checkout, pago aplicado, gracia, cancelación,
  reembolso, cupones (`entity = subscription | payment | coupon`).
- **Secretos solo por variables de entorno** (en Azure, secretos del Container
  App o Key Vault). Nunca en el código ni en los logs: la configuración los
  guarda como `SecretStr` y el cliente HTTP no registra cabeceras ni cuerpos.

## Ciclo de una suscripción

1. **Prueba gratis (opcional).** Dojo y Organizador traen 30 días de prueba
   (`plans.trial_days`, se cambia con `PATCH /plans/{code}`). Una sola vez por
   organización: «Probar 30 días gratis» en el diálogo de suscripción o
   `POST /organizations/{id}/trial`. Queda en estado `trial`.
2. **Checkout.** «Suscribirse» (o «Renovar») elige periodo mensual/anual y un
   cupón opcional. `POST /organizations/{id}/checkout` (organización) o
   `POST /me/checkout` (Competidor Plus, titular = la cuenta) crea la
   suscripción en `past_due` —o reutiliza la del mismo plan si ya existe, por
   ejemplo la de prueba— y el cobro en la pasarela.
3. **Pago aprobado** (aviso de la pasarela o cargo de Culqi): la suscripción
   pasa a `active` y `current_period_end` se extiende 30 o 365 días **desde el
   fin vigente** (o desde hoy): pagar durante la prueba no pierde días. Se
   emite el comprobante y se avisa al titular.
4. **Pago rechazado o vencido:** `past_due` con **gracia**
   (`HAJIME_BILLING_GRACE_DAYS`, 7 por defecto) contada desde el fin del
   periodo: se mantiene el acceso y el encabezado avisa. Una suscripción
   recurrente cuyo cobro no llegó a tiempo también conserva el acceso durante
   la gracia. Vencida la gracia, la API vuelve a responder 402.
5. **Cancelación por el titular** («Cancelar suscripción»): se detiene el cobro
   automático en la pasarela y se conserva el acceso hasta el fin del periodo
   pagado (`cancel_at_period_end`). Sin periodo pagado, se corta ya.
6. **Reembolso (Admin Global)**, en «Pagos»: llama a la API de la pasarela
   (`/v1/payments/{id}/refunds` o `/v2/refunds`) y, por defecto, cancela la
   suscripción. Si el pago tenía boleta o factura emitida, se emite sola la
   **nota de crédito** por anulación (ver abajo).

### Correos

Van por la bandeja de salida del servicio de correo (`mail.enqueue`, ver
[cuentas-y-correo.md](cuentas-y-correo.md)) con la plantilla de la marca
(`app/services/billing_mail.py`):

| Aviso | Cuándo | `kind` |
| --- | --- | --- |
| Pago recibido: monto, plan, periodo, vigencia y botón al comprobante (PDF) si ya se emitió | Pago aprobado | `payment_approved` |
| Pago no completado (con la fecha hasta la que dura la gracia, si la hay) | Pago rechazado | `payment_rejected` |
| Periodo de gracia: el cobro automático no llegó | Suscripción automática vencida sin cobro, o aviso de la pasarela | `billing_grace` |
| Tu plan vence en N días / mañana | 7 días y 1 día antes (suscripciones que no se renuevan solas) | `billing_d7`, `billing_d1` |

**Destinatarios:** los dueños (`owner`) de la organización que tienen correo;
si ninguno tiene, el «correo para comprobantes» de la organización. En
Competidor Plus, la cuenta titular, la cuenta ligada al perfil y quien pagó
(p. ej. el padre o la madre).

Los avisos de vencimiento se revisan una vez por hora desde el hilo
despachador de correo y con `python -m app.billing_reminders` (para un
Container Apps Job diario si el despachador está apagado). Cada aviso se
reserva en `subscriptions.reminder_key` con un UPDATE condicional: no se
repite aunque corran varios procesos. En marcha blanca no se envían.

El encabezado muestra a dueños y administradores «tu plan vence en N días»
(7 días antes; no aparece si la suscripción se renueva sola) y el aviso de
gracia (`GET /billing/alerts`).

## Cupones

Tabla `coupons`: `code` (único, en mayúsculas), `percent_off` o
`amount_off_pen` (céntimos), `plan_codes` (vacío = todos), `max_redemptions`,
`expires_at`, `first_period_only` y `active`. Se administran en «Pagos»
(Admin) o con `GET/POST /coupons` y `PATCH /coupons/{id}`.
`GET /plans/{code}/quote?period=month&coupon_code=X` muestra el precio antes
de pagar.

- Un cupón que cubre todo el primer periodo (100 %) activa la suscripción sin
  pasar por la pasarela (pago registrado con proveedor `coupon`, monto 0).
- Con `first_period_only` y pago mensual, el primer mes se cobra como pago
  único con descuento (no como suscripción automática); la renovación se paga
  a precio completo desde «Renovar».
- El uso se cuenta al aprobarse el primer pago. Pagar menos de lo esperado no
  activa nada (queda auditado como `amount_mismatch`).
- **Sembrado desactivado:** `PRIMER-TORNEO` (100 % del primer mes de Dojo u
  Organizador, «primer torneo gratis»). Para usarlo: «Pagos» → Cupones →
  marcar «Activo» (y, si se quiere, ponerle vencimiento o límite de usos).

## Mercado Pago (Perú)

**Cómo funciona.** Pago anual (o mensual con cupón del primer mes): preferencia
de **Checkout Pro** (`POST https://api.mercadopago.com/checkout/preferences`,
`Authorization: Bearer <access token>`); el navegador va a `init_point` y
vuelve a `/pago/exito`, `/pago/pendiente` o `/pago/error`. Mensual:
**suscripción** con `POST /preapproval` (`auto_recurring` mensual); Mercado
Pago cobra cada mes y avisa. Para el mensual se pide el **correo de la cuenta
de Mercado Pago** del pagador (lo exige `preapproval`).

**Avisos.** `POST /api/v1/payments/webhook/mercadopago`. Se verifica
`x-signature` (`ts=…,v1=…`): HMAC-SHA256, con la clave secreta, del
manifiesto `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`. Firma inválida
→ 401. Después se consulta `GET /v1/payments/{id}` (tipo `payment`),
`GET /authorized_payments/{id}` (`subscription_authorized_payment`) o
`GET /preapproval/{id}` (`subscription_preapproval`). Un pago que la API no
conoce (la prueba del panel) responde 200 e ignorado; si la API no responde,
502 para que Mercado Pago reintente.

**Cuenta y credenciales (dueño).**

1. Crear la cuenta de vendedor en [mercadopago.com.pe](https://www.mercadopago.com.pe)
   a nombre de la empresa (RUC) y validar la identidad.
2. En «Tus integraciones» → crear una aplicación («Pagos online», Checkout
   Pro y Suscripciones).
3. **Credenciales de prueba** (sandbox): *Access Token* de prueba y usuarios de
   prueba (vendedor y comprador). **Credenciales de producción**: se activan
   tras completar los datos del negocio.
4. **Webhooks** de la aplicación → URL
   `https://<dominio>/api/v1/payments/webhook/mercadopago`, eventos **Pagos**
   y **Planes y suscripciones** (y en su caso «Pagos autorizados»). Copiar la
   **clave secreta** que genera el panel.
5. Variables: `HAJIME_PAYMENT_PROVIDER=mercadopago`,
   `HAJIME_MP_ACCESS_TOKEN=<access token>`,
   `HAJIME_MP_WEBHOOK_SECRET=<clave secreta>`,
   `HAJIME_PUBLIC_URL=https://<dominio>` (las URL de retorno y de aviso; Mercado
   Pago no acepta `localhost`).

**Probar en sandbox.** Con el *Access Token* de prueba y el usuario comprador
de prueba, pagar con las [tarjetas de prueba](https://www.mercadopago.com.pe/developers/es/docs/checkout-pro/additional-content/your-integrations/test/cards)
(el nombre del titular decide el resultado: `APRO` aprobado, `OTHE`
rechazado, `CONT` pendiente). Revisar en «Pagos» (Admin) que el pago aparezca
con su estado y que la suscripción quede activa. Para probar el aviso sin
pagar: «Simular notificación» en el panel (responde «ignorado» porque el pago
no existe; sirve para comprobar la firma).

## Culqi

**Cómo funciona.** La página `/pago/culqi/:id` carga **Culqi Checkout**
(`https://checkout.culqi.com/js/v4`, solo en esa página) con la **llave
pública**. La tarjeta o Yape van directo a Culqi, que entrega un token; la app
lo envía a `POST /payments/culqi/charge` y el servidor crea el cargo
(`POST https://api.culqi.com/v2/charges`, `Authorization: Bearer <llave
secreta>`). El mismo token enviado dos veces no cobra dos veces.

**Mensual automático.** Si existe un plan de Culqi para el plan y periodo
(`HAJIME_CULQI_PLAN_IDS`) y el pagador indica nombre, apellido y celular, el
servidor crea cliente (`/v2/customers`), tarjeta (`/v2/cards`) y suscripción
(`/v2/recurrent/subscriptions/create`); los cobros llegan por aviso. Sin eso,
se cobra un pago único.

**Avisos.** `POST /api/v1/payments/webhook/culqi`. Si se configuró
`HAJIME_CULQI_WEBHOOK_SECRET`, se exige autenticación básica con esa
contraseña (401 si no coincide). En todo caso, el cargo se consulta con
`GET /v2/charges/{id}` antes de aplicar nada.

**Cuenta y credenciales (dueño).**

1. Afiliarse en [culqi.com](https://www.culqi.com) como empresa (RUC, cuenta
   bancaria para los abonos).
2. En CulqiPanel → Desarrollo → **API Keys**: llave pública (`pk_…`) y secreta
   (`sk_…`), de integración (prueba) y de producción.
3. (Mensual) **Planes** en CulqiPanel: uno por plan de Hajime con el mismo
   precio (Dojo S/ 69 mensual, Organizador S/ 149 mensual, Competidor Plus
   S/ 9,90 mensual) y anotar sus ids.
4. **Eventos / Webhooks** → URL `https://<dominio>/api/v1/payments/webhook/culqi`,
   eventos de cargos (`charge.creation.succeeded`, …) y de suscripciones;
   activar la autenticación básica con una contraseña larga.
5. Variables: `HAJIME_PAYMENT_PROVIDER=culqi`,
   `HAJIME_CULQI_SECRET_KEY=sk_…`, `HAJIME_CULQI_PUBLIC_KEY=pk_…`,
   `HAJIME_CULQI_WEBHOOK_SECRET=<contraseña del aviso>`,
   `HAJIME_CULQI_PLAN_IDS={"dojo:month":"pln_…","organizador:month":"pln_…","competidor_plus:month":"pln_…"}`.

**Probar en sandbox.** Con las llaves de integración, pagar con las
[tarjetas de prueba de Culqi](https://docs.culqi.com/es/documentacion/pagos-online/tarjetas-de-prueba/)
(hay tarjetas que aprueban y que devuelven cada tipo de rechazo). Verificar en
«Pagos» el estado y en CulqiPanel el cargo con el `subscription_id` en la
metadata.

> **Verificar en el sandbox antes de producción:** las rutas y los campos de
> suscripciones de Culqi (`/v2/recurrent/…`) y los nombres de los eventos
> cambian entre versiones de su API. El cargo único (`/v2/charges`) es la
> parte estable.

## Comprobantes electrónicos (SUNAT) con Nubefact

**Qué se emite.** Al aprobarse un pago con monto:

- **Factura** (serie `HAJIME_NUBEFACT_SERIE_FACTURA`, `FFF1` por defecto) a la
  organización **con RUC**, con su razón social y domicilio fiscal
  («Organización» → «Datos para el comprobante»).
- **Boleta** (serie `HAJIME_NUBEFACT_SERIE_BOLETA`, `BBB1`) en los demás casos:
  Competidor Plus con DNI si lo indicó (opcional) o sin documento («clientes
  varios»); organización sin RUC.

Los precios de los planes **incluyen IGV** (18 %): se informa gravada + IGV.
La numeración es correlativa por serie y se reserva en la base antes de
llamar a Nubefact: un reintento usa el mismo número y primero consulta si ya
existe. Se guardan serie, número, estado (aceptado, enviado, rechazado, con
error) y los enlaces al PDF, XML y CDR, que el titular descarga en «Pagos y
comprobantes». Si Nubefact falla, el pago sigue confirmado y el comprobante
queda «con error»: el Admin lo reintenta en «Pagos» («Emitir comprobante»).

**Nota de crédito.** Al reembolsar un pago cuya boleta o factura se emitió
(aceptada o enviada), se emite la nota de crédito (código SUNAT 07; en
Nubefact `tipo_de_comprobante` 3) con motivo **anulación de la operación**
(`tipo_de_nota_de_credito` 1), por el total, referenciando el comprobante.
Series: `HAJIME_NUBEFACT_SERIE_NC_FACTURA` (`FFF1`) y
`HAJIME_NUBEFACT_SERIE_NC_BOLETA` (`BBB1`); deben empezar con la misma letra
que el comprobante que anulan y tener su propia numeración. Misma reserva de
número y reintento que los comprobantes («Reintentar nota de crédito» en
«Pagos»). Si el comprobante de venta no llegó a emitirse, no hay nota.

**Ojo:** SUNAT exige el documento del cliente en boletas desde S/ 700 (p. ej.
Organizador anual sin RUC): pedir el RUC a esas organizaciones.

**Cuenta y credenciales (dueño).**

1. Contratar [Nubefact](https://www.nubefact.com) (OSE/PSE) con el RUC de la
   empresa y dar de alta las series de factura y boleta (deben empezar con F y B).
2. En el panel → «API (Integración)»: copiar la **RUTA** (URL única de la
   cuenta) y el **TOKEN**. Hay modo demo para probar sin enviar a SUNAT.
3. Variables: `HAJIME_INVOICING_PROVIDER=nubefact`,
   `HAJIME_NUBEFACT_URL=<ruta>`, `HAJIME_NUBEFACT_TOKEN=<token>` y, si se
   usan otras series, `HAJIME_NUBEFACT_SERIE_BOLETA` /
   `HAJIME_NUBEFACT_SERIE_FACTURA`.

## Variables

| Variable | Por defecto | Qué hace |
| --- | --- | --- |
| `HAJIME_PAYMENTS_ENABLED` | `false` | Interruptor general de cobros. `false`: todo lo de esta página apagado y todo permitido (ver arriba) |
| `HAJIME_BILLING_MODE` | `marcha_blanca` | `enforced` exige plan (ver organizaciones-y-planes.md); solo rige con `HAJIME_PAYMENTS_ENABLED=true` |
| `HAJIME_PAYMENT_PROVIDER` | `manual` | `manual`, `mercadopago` o `culqi` |
| `HAJIME_BILLING_GRACE_DAYS` | `7` | Días de acceso tras un pago rechazado o vencido |
| `HAJIME_PUBLIC_URL` | URL de la petición | `https://<dominio>`: retornos y URL de aviso de la pasarela (y enlaces de los correos) |
| `HAJIME_MP_ACCESS_TOKEN` | — | **Secreto.** Access Token de Mercado Pago |
| `HAJIME_MP_WEBHOOK_SECRET` | — | **Secreto.** Clave secreta de los avisos de Mercado Pago |
| `HAJIME_CULQI_SECRET_KEY` | — | **Secreto.** Llave secreta de Culqi (`sk_…`) |
| `HAJIME_CULQI_PUBLIC_KEY` | — | Llave pública de Culqi (`pk_…`), llega al navegador |
| `HAJIME_CULQI_WEBHOOK_SECRET` | — | **Secreto.** Contraseña de la autenticación básica del aviso de Culqi |
| `HAJIME_CULQI_PLAN_IDS` | `{}` | JSON `{"<plan>:month": "<id del plan en Culqi>"}` para el mensual automático |
| `HAJIME_INVOICING_PROVIDER` | `none` | `none` o `nubefact` |
| `HAJIME_NUBEFACT_URL` | — | **Secreto.** Ruta de la cuenta de Nubefact |
| `HAJIME_NUBEFACT_TOKEN` | — | **Secreto.** Token de Nubefact |
| `HAJIME_NUBEFACT_SERIE_BOLETA` / `_FACTURA` | `BBB1` / `FFF1` | Series dadas de alta en Nubefact |
| `HAJIME_NUBEFACT_SERIE_NC_BOLETA` / `_NC_FACTURA` | `BBB1` / `FFF1` | Series de las notas de crédito |
| `HAJIME_PAYMENT_HTTP_TIMEOUT` | `15` | Segundos por llamada a la pasarela o a Nubefact |
| `HAJIME_WEBHOOK_MAX_BYTES` | `65536` | Tamaño máximo del cuerpo de un aviso (413 si se pasa) |

## URL que se registran en las pasarelas

| Dónde | URL |
| --- | --- |
| Mercado Pago → Webhooks (Pagos, Planes y suscripciones) | `https://<dominio>/api/v1/payments/webhook/mercadopago` |
| Culqi → Eventos | `https://<dominio>/api/v1/payments/webhook/culqi` |
| Retornos (los arma la app, no se registran) | `https://<dominio>/pago/exito`, `/pago/pendiente`, `/pago/error` |

Los avisos no llevan sesión: los protege la firma (Mercado Pago), la
autenticación básica (Culqi) y la consulta a la API. El cuerpo se limita a
`HAJIME_WEBHOOK_MAX_BYTES`.

**CSP:** la app no envía `Content-Security-Policy` hoy. Si se agrega, permitir
`https://checkout.culqi.com` (script y marco) y `https://*.culqi.com`
(conexiones) **solo** en `/pago/culqi/*`; Mercado Pago no necesita excepciones
(es una redirección).

## De la marcha blanca al cobro real

1. En TEST: `HAJIME_PAYMENTS_ENABLED=true`, `HAJIME_BILLING_MODE=enforced`, la pasarela con credenciales de
   **prueba** y Nubefact en modo demo. Probar: suscribirse mensual y anual,
   cupón, prueba gratis, rechazo, reembolso, cancelación y el comprobante.
2. Revisar precios definitivos (`PATCH /plans/{code}`) y los días de prueba.
3. Asignar a mano los beneficios de la marcha blanca (plan `marcha_blanca` con
   fecha de fin, o un cupón).
4. En producción: credenciales de **producción**, URL de aviso registradas con
   el dominio de producción, `HAJIME_PUBLIC_URL`, y recién entonces
   `HAJIME_PAYMENTS_ENABLED=true` y `HAJIME_BILLING_MODE=enforced`. Comprobar `GET /api/v1/billing/config`.
5. Hacer un pago real pequeño (p. ej. Competidor Plus mensual) y reembolsarlo
   desde «Pagos» para confirmar todo el circuito.

Volver atrás es cambiar `HAJIME_BILLING_MODE` a `marcha_blanca` (se sigue
cobrando a quien quiera pagar, sin exigir) o `HAJIME_PAYMENTS_ENABLED` a
`false` (nada de cobros): los pagos y suscripciones quedan registrados.

## Conciliación

- «Pagos» (Admin) lista todos los pagos con su referencia de la pasarela
  (`provider_ref` = id del pago en Mercado Pago o del cargo en Culqi), titular,
  plan, monto, estado y comprobante; se busca por referencia, organización o
  usuario y se filtra por estado. `GET /api/v1/payments?status=approved`
  devuelve lo mismo en JSON.
- Cada mes, comparar los aprobados y reembolsados con el reporte de
  liquidaciones de la pasarela (Mercado Pago: «Reportes» → «Liquidaciones»;
  CulqiPanel: «Transacciones» / «Depósitos») por `provider_ref`, y con los
  comprobantes emitidos en Nubefact por serie y número.
- Un pago aprobado sin suscripción (aviso que no se pudo asociar) queda en el
  log (`hajime.pagos`) y en «Pagos» sin titular: asignarlo a mano con
  «Pagado 1 mes / 1 año» en «Organización».
- Comprobantes «con error»: reintentar desde «Pagos»; si SUNAT los rechazó,
  corregir los datos fiscales y emitir de nuevo (o anular en Nubefact).

## Competidor Plus por persona

El titular de Competidor Plus puede ser la **cuenta** (`user_id`) o un
**perfil** (`person_id`): el propio (cuenta ligada a la persona) o el de un
menor a cargo con tutela aprobada (un padre paga el Plus de su hijo). En el
diálogo «Suscribirse» se elige «¿Para quién?» entre los perfiles de
`/me/profiles`; por la API, `POST /me/checkout` con `person_id`. Otra cuenta
recibe 403. Los derechos (`plus_insights`, `certificates`) quedan en esa
persona; el pagador ve la suscripción, los pagos y los comprobantes (a nombre
del perfil, con DNI opcional) y puede cancelarla.

## Pendientes

- Izipay u otra pasarela: implementar `payments.Provider` y registrarla.
- Nota de crédito parcial (hoy se anula el total).
