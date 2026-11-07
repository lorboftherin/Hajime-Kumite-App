# Cuentas de competidor y correo

Cómo funcionan el correo transaccional, la recuperación de contraseña, el
registro abierto y el reclamo de perfiles. Contexto de negocio en
[`modelo-negocio.md`](modelo-negocio.md) («Cuentas de competidor» y «Reglas que
el modelo no puede romper»).

## Correo transaccional

Ningún correo sale dentro de una petición HTTP. La petición solo agrega una fila
a `outbox_emails` en su misma transacción; si la petición falla, el correo no
existe, y si el proveedor está caído, la petición no se entera.

Quién los envía:

- **Hilo despachador** en cada proceso de la API (lo arranca el *lifespan*).
  Revisa la bandeja cada `HAJIME_MAIL_POLL_SECONDS`. Se apaga con
  `HAJIME_MAIL_DISPATCHER=false`. No arranca con SQLite en memoria (pruebas).
- **`python -m app.mail_worker`**: envía lo pendiente y termina (para un
  Container Apps Job programado, p. ej. cada minuto). Con `--loop` se queda
  revisando.

Pueden correr varios a la vez: cada correo se **reserva** con un `UPDATE`
condicional (`status='sending'`, `locked_until` = ahora + `HAJIME_MAIL_LEASE_SECONDS`).
Solo gana el proceso cuyo `UPDATE` afecta la fila. Si ese proceso muere a mitad
del envío, la reserva vence y otro lo retoma. Cada fallo suma un intento y se
reintenta con espera creciente (30 s, 1 min, 2 min… hasta 1 h) hasta
`HAJIME_MAIL_MAX_ATTEMPTS`; un error permanente (destinatario rechazado,
configuración inválida, 4xx de ACS) pasa directo a `failed`. `last_error`
guarda el motivo.

Estados: `pending` → `sending` → `sent` | `failed` (o de nuevo `pending` para
reintentar).

### Proveedores (`HAJIME_MAIL_PROVIDER`)

| Proveedor | Para qué | Variables |
| --- | --- | --- |
| `console` (por defecto) | Desarrollo y pruebas: escribe el correo en el log y lo guarda en memoria. **En `prod` solo deja una advertencia en el log**: no envía nada | — |
| `smtp` | Cualquier servidor SMTP con STARTTLS (biblioteca estándar `smtplib`) | `HAJIME_SMTP_HOST`, `HAJIME_SMTP_PORT` (587), `HAJIME_SMTP_USER`, `HAJIME_SMTP_PASSWORD`, `HAJIME_SMTP_FROM`, `HAJIME_SMTP_STARTTLS` (`true`) |
| `acs` | Azure Communication Services Email por REST, firmado con HMAC-SHA256 (sin SDK) | `HAJIME_ACS_ENDPOINT` (`https://<recurso>.communication.azure.com`), `HAJIME_ACS_ACCESS_KEY` (clave del recurso, secreto), `HAJIME_ACS_SENDER` (remitente verificado, p. ej. `DoNotReply@<dominio>`) |

Comunes: `HAJIME_MAIL_FROM` (remitente por defecto, `Nombre <correo>`) y
`HAJIME_PUBLIC_URL` (URL pública de la interfaz: los enlaces de los correos y
el logo, `<URL>/icons/hajime-logo-horizontal.png`, apuntan allí).

Las credenciales van como **secretos** del Container App (nunca en el código ni
en los scripts). Para ACS: crear el recurso *Email Communication Service*,
verificar el dominio (registros SPF y DKIM en Cloudflare), conectarlo al recurso
*Communication Services* y copiar su *endpoint* y clave.

### Plantillas

`app/services/mail.render()` arma un HTML simple con la marca (washi de fondo,
tarjeta kinu, botón shu; colores de `docs/marca/README.md`) y **siempre** una
versión en texto plano. El texto de cada correo vive en el servicio que lo envía
(`app/services/accounts.py`, `app/services/claims.py`).

| Correo | Cuándo |
| --- | --- |
| Crear contraseña nueva | `POST /auth/forgot-password` con un correo que tiene cuenta |
| Contraseña cambiada | Tras usar el enlace de recuperación |
| Confirma tu correo | Registro, cambio de correo (propio o por el Admin), reenvío |
| Ya tienes una cuenta | Registro con un correo que ya existe |
| Solicitud aprobada / no aprobada | Revisión de un reclamo de perfil |
| Nueva solicitud de perfil | Reclamo nuevo: a los `dojo_admin` y senseis del dojo de la persona que tengan correo (no si se aprobó solo) |
| Inscripciones revisadas | El organizador aprueba o rechaza en lote las inscripciones pedidas por un sensei: un correo por sensei con las aprobadas y las rechazadas con su motivo (`self_registration.notify_registration_decisions`) |

Además del correo, las cuentas con avisos push activos en un dispositivo
reciben «Inscripciones revisadas» (el sensei, uno por lote; la persona y su
apoderado, uno por inscripción) y «Perfil aprobado». Ver
[`avisos-push.md`](avisos-push.md).

## Correo en las cuentas

- `users.email` es único entre las cuentas que lo tienen (las antiguas quedan
  sin correo) y se guarda en minúsculas; `users.email_verified_at` marca la
  verificación.
- Se entra con el usuario **o** con el correo.
- El Admin asigna o cambia el correo en **Usuarios**; cada cuenta, en **Mi
  cuenta** (pide la contraseña actual). Un correo nuevo queda sin verificar y se
  envía el enlace (vence en 48 h; `POST /auth/verify-email/resend` pide otro).
- Borrar la cuenta quita el correo y las tutelas de menores.

### Recuperar la contraseña

1. `POST /auth/forgot-password {email}` responde **siempre lo mismo** (202),
   exista o no la cuenta. Límites: 3 correos por dirección y hora (sin cambiar
   la respuesta) y 20 solicitudes por IP y hora (429).
2. El enlace `…/restablecer-clave#<token>` lleva el token en el fragmento (no
   llega a los logs del servidor). Solo se guarda su hash SHA-256; vence en
   **1 hora**; pedir otro invalida los anteriores.
3. `POST /auth/reset-password {token, new_password}` lo gasta con un `UPDATE`
   condicional (un solo uso aunque lleguen dos a la vez), cambia la contraseña,
   **cierra todas las sesiones** y avisa por correo.

## Registro abierto y reclamo de perfiles

Se activa con `HAJIME_OPEN_SIGNUP=true` (apagado por defecto).
`GET /auth/options` le dice a la pantalla de acceso si mostrar «Crear cuenta».

- `POST /auth/signup {email, password, display_name}` responde igual si el
  correo ya tenía cuenta (a esa dirección le llega «Ya tienes una cuenta»).
  Límite: 10 registros por IP y hora. La cuenta nace sin roles.
- **Hay que verificar el correo antes de reclamar un perfil.**

Flujo del reclamo:

1. Buscar el perfil (`GET /profiles/search?q=&dojo_id=`): solo nombre
   abreviado, dojo y torneos ya disputados. Nunca documento ni fecha de
   nacimiento.
2. Solicitar (`POST /profile-claims`) con el identificador público:
   - `self`: un adulto reclama el suyo. Si el perfil es de un menor, se rechaza.
   - `parent` o `guardian`: padre, madre o apoderado de un **menor**. Debe
     aceptar (`consent: true`) la publicación de resultados y el uso de los
     datos en estadísticas.
   - Opcional: los 4 últimos dígitos del documento. Se comparan en el servidor
     y **no se guardan**: solo queda `document_match`. Máximo 5 comprobaciones
     por perfil al día y 5 solicitudes por cuenta al día.
3. Revisa (`GET /profile-claims`, `POST /profile-claims/{id}/review`) el
   **dojo** de la persona (usuario con rol `dojo_admin` o `sensei` de ese dojo),
   un organizador o el Admin. El sensei no ve la fecha de nacimiento.
4. Al aprobar:
   - `self` → `users.person_id` queda ligado a la persona.
   - menor → fila en `guardianships` y consentimiento en `data_consents`
     (alcance «publicación de resultados y estadísticas», medio «cuenta Hajime
     (aceptación en línea, solicitud N)»).

Aprobación automática: con `HAJIME_AUTO_APPROVE_SELF_CLAIM=true`, un reclamo
`self` de un adulto (fecha de nacimiento conocida) con los 4 dígitos correctos
se aprueba solo. **Los menores siempre los revisa una persona.** Ante la duda
(sin fecha de nacimiento), el perfil se trata como de menor.

Con el perfil reclamado, `GET /persons/{id}/history` y `/stats` quedan abiertos
a la propia persona y a su padre, madre o apoderado verificado. También los ve
el `dojo_admin` del dojo donde la persona tiene membresía vigente (los mismos
permisos sobre personas que le dan las organizaciones). De los rivales (que
pueden ser menores), quien no es organizador ve solo el nombre abreviado.

La hoja del combate (`GET /matches/{id}/summary`) la leen quienes leen el
torneo y, además, la persona que peleó y su apoderado verificado; para ellos el
rival va con el nombre abreviado.
`GET /me/profiles` lista el propio perfil y los de los menores a cargo;
`DELETE /me/guardianships/{id}` deja una tutela.

Anonimizar a una persona borra sus tutelas y consentimientos; fusionar dos
personas mueve reclamos y tutelas a la que queda.

## Perfil público

`GET /public/persons/{public_id}` (sin sesión, caché pública de 60 s) y la
página `/competidor/<public_id>`:

- `persons.public_id`: identificador aleatorio de 12 caracteres (no secuencial);
  la migración `0011_cuentas` lo rellena para las personas existentes.
- Nombre abreviado («Diego R.») si es menor o no se conoce la edad; completo
  para adultos con fecha de nacimiento.
- Dojo actual, medallas y torneos **ya disputados** (en curso o terminados):
  se excluyen los de prueba y los futuros (no se anuncia dónde estará un menor).
- Nunca documento, fecha de nacimiento, datos de contacto, rivales ni el id
  interno.

En la interfaz, `personLink(publicId)` (`frontend/src/app/shared/person-link.ts`)
arma el enlace; el vivo lo usará cuando su respuesta incluya el `public_id` de
cada competidor.

## Variables nuevas (resumen)

| Variable | Por defecto | Uso |
| --- | --- | --- |
| `HAJIME_MAIL_PROVIDER` | `console` | `console`, `smtp` o `acs` |
| `HAJIME_MAIL_FROM` | `Hajime <no-responder@localhost>` | Remitente por defecto |
| `HAJIME_PUBLIC_URL` | `http://localhost:4200` | URL de la interfaz para enlaces y logo de los correos |
| `HAJIME_SMTP_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_FROM` / `_STARTTLS` | — / `587` / — / — / — / `true` | SMTP |
| `HAJIME_ACS_ENDPOINT` / `_ACCESS_KEY` / `_SENDER` | — | Azure Communication Services Email |
| `HAJIME_MAIL_DISPATCHER` | `true` | Hilo despachador en cada proceso |
| `HAJIME_MAIL_POLL_SECONDS` | `5` | Cada cuánto revisa la bandeja |
| `HAJIME_MAIL_MAX_ATTEMPTS` | `6` | Intentos antes de marcar `failed` |
| `HAJIME_MAIL_LEASE_SECONDS` | `120` | Reserva de un correo mientras se envía |
| `HAJIME_OPEN_SIGNUP` | `false` | Registro abierto de cuentas de competidor |
| `HAJIME_AUTO_APPROVE_SELF_CLAIM` | `false` | Aprobación automática de adultos con documento coincidente |

## Pendiente

- Validación legal del texto de privacidad (`/privacidad`, marcado como
  provisional) y del consentimiento en línea de padres y apoderados.
