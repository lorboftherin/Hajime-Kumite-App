# Modelo de negocio: gratis lo necesario, membresía para dojos y plan opcional para competidores

Decisión del 25/09/2026 (revisada el mismo día: el competidor ve gratis todo lo
necesario y puede pagar, si quiere, por información adicional). Completa
la sección 3 del documento maestro, que dejaba la monetización abierta.

## Etapas

| Etapa | Cobro |
| --- | --- |
| **Pruebas y marcha blanca** (ahora) | **Todo gratis para quien tenga cuenta.** Los niveles existen en el sistema, pero una sola opción de configuración da acceso completo a todas las cuentas. |
| **Lanzamiento** | Se activan los niveles de abajo y los cobros. Quienes participaron en la marcha blanca pueden recibir un beneficio (por ejemplo, meses gratis o precio de fundador). |

Así los permisos por nivel se construyen y prueban desde ya, y el día del
lanzamiento solo se cambia la configuración, sin tocar el código.

## Niveles

| Nivel | Para quién | Precio | Qué incluye |
| --- | --- | --- | --- |
| **Público** | Cualquiera, sin cuenta | Gratis | Torneos, llaves, resultados, medallero por dojo, seguimiento en vivo, perfil básico del competidor (medallas y torneos) |
| **Competidor** (cuenta) | Competidores adultos y padres o apoderados de menores | **Gratis** | Todo lo necesario del propio perfil (o del hijo o hija): historial completo de torneos, combates y resultados, hoja de cada combate, medallas, grados, estadísticas básicas (combates, victorias, puntos, técnicas), insignias, avisos del próximo combate y tarjetas para compartir |
| **Competidor Plus** (opcional) | Quien quiera más información | Mensual o anual, bajo | *Insights* adicionales: evolución en el tiempo (gráficos por temporada), análisis de técnicas y de cómo gana o pierde, índice Hajime y su tendencia, comparación con rivales (con datos públicos), preparación del próximo rival, metas y certificados oficiales descargables |
| **Dojo** (membresía) | Dojos, y también ligas u organizadores | Mensual o anual, por organización | Administrar el dojo y sus competidores, inscribir alumnos en torneos, organizar torneos (inscripciones, llaves, mesa, varios tatamis, árbitros, reportes, Shadow Mode) y transmisión en vivo con overlay |

**Lo necesario nunca se cobra.** El público y cualquier competidor con cuenta ven
sus resultados, su historial y lo esencial de su desempeño sin pagar. Los dojos
pagan por gestionar; el competidor paga solo si quiere análisis adicional
(Competidor Plus). La cuenta gratuita sirve además para reclamar el perfil,
recibir avisos y, por privacidad, ver el detalle completo del propio historial.

## Qué ya existe y a qué nivel pertenece

| Función actual | Nivel |
| --- | --- |
| Vivo público, resultados, medallero | Público |
| Hoja del combate, historial, perfil deportivo básico, líderes, insignias, tarjeta para compartir | Competidor, gratis con cuenta (el público ve la versión básica) |
| Índice Hajime con su tendencia, análisis de técnicas en el tiempo, comparación con rivales | Competidor Plus (por construir la mayor parte) |
| Torneos, inscripciones, Excel, llaves, mesa, equipos, tatamis, árbitros, Shadow Mode, overlay | Dojo (membresía) |

## Qué falta construir, en orden

1. **Organizaciones y membresías (base de todo).**
   - Entidad *Organización* (liga, club organizador o dojo) dueña de sus torneos, usuarios y plantillas.
   - Las personas y dojos siguen siendo compartidos: así cada competidor tiene un solo historial en todos los torneos.
   - Planes y derechos (*entitlements*) verificados en la API, no solo en la pantalla.
   - Durante la marcha blanca rige un plan «Marcha blanca» con acceso completo para toda cuenta; el Admin puede además activar membresías a mano.
2. **Portal público.**
   - Páginas abiertas y con buscador de torneos, dojos y perfiles básicos.
   - Generadas en el servidor (Angular SSR) para que Google las indexe.
3. **Cuentas de competidor (gratis).**
   - Registro abierto con verificación de correo.
   - *Reclamar perfil*: un adulto reclama el suyo; un padre o apoderado reclama el de su hijo o hija, validado por el dojo o sensei, o con el documento.
   - Historial completo, estadísticas básicas y avisos del propio perfil, gratis.
   - Competidor Plus opcional con los *insights* adicionales.
4. **Cobros (membresía de dojo y Competidor Plus).**
   - Pasarela local con pagos recurrentes: Culqi, Mercado Pago o Izipay.
   - Comprobantes electrónicos para SUNAT (boleta y factura) mediante un proveedor OSE/PSE.
   - Periodo de prueba y cupones: por ejemplo, el primer torneo gratis para un dojo organizador.
5. **Modo offline de la mesa (PWA).** Un organizador que paga no puede depender del Wi‑Fi del coliseo.

## Reglas que el modelo no puede romper

- **Los resultados siguen siendo gratis y públicos.** Pagar da herramientas de gestión o análisis adicional, nunca «ocultar» o cambiar resultados, ni poner detrás de un pago lo necesario del propio historial.
- **Menores de edad (Ley 29733):**
  - ninguna cuenta, gratis o de pago, da acceso a datos de menores ajenos; Competidor Plus analiza el propio perfil y, de los rivales, solo resultados públicos;
  - el detalle completo de un menor lo ve su padre o apoderado (perfil reclamado) y su dojo;
  - el público y otras cuentas ven lo básico, con nombre abreviado salvo autorización expresa;
  - la comparación con rivales menores usa solo resultados públicos.
- **Documento y fecha de nacimiento nunca se muestran** a nadie fuera del organizador y su dojo.
- **Consentimiento:** el de padres o apoderados debe cubrir expresamente la publicación de resultados y el uso de sus datos en estadísticas.

## Decisiones abiertas

- [ ] Fecha de lanzamiento y beneficio para quienes participaron en la marcha blanca.
- [ ] Precio en soles de la membresía de dojo: ¿por mes, por torneo organizado o por número de alumnos?
- [ ] Una liga u organizador que no es dojo, ¿paga la misma membresía o una distinta?
- [ ] Precio de Competidor Plus y si la membresía del dojo lo incluye para sus alumnos (sería un buen argumento de venta para los dojos).
- [ ] Qué entra exactamente en «lo necesario» y qué en Plus: la tabla de niveles es la propuesta inicial.
- [ ] ¿Quién puede editar una persona o dojo compartidos entre organizaciones? Propuesta: el dojo reclamado; si nadie lo reclamó, la organización que la creó; con historial de cambios.
- [ ] Pasarela de pago y proveedor de comprobantes electrónicos.
- [ ] Validación legal: inscripción del banco de datos ante la autoridad, política de privacidad, términos de uso y consentimiento de menores que cubra la publicación y las estadísticas.

## Plataformas: web primero, app del celular con el mismo código

| Paso | Qué | Por qué |
| --- | --- | --- |
| 1. Web + PWA (ahora) | La misma app Angular, instalable desde el navegador en celular, tablet y PC; portal público generado en el servidor (SSR) para Google; mesa con modo offline | Un solo código, sin tiendas ni comisiones, llega a todos los dispositivos, y el público entra con un enlace de WhatsApp sin instalar nada |
| 2. App en las tiendas (con tracción, Fase 6) | La misma app empaquetada con Capacitor para Google Play y App Store; notificaciones push nativas y cámara (QR) | Presencia en las tiendas y notificaciones más confiables, sin reescribir la interfaz |

No conviene hacer apps nativas separadas (Swift/Kotlin) ni reescribir en
Flutter o React Native: serían dos o tres interfaces que mantener para la misma
API. La API ya está pensada para varios clientes (sección 23).

### Cobros y tiendas

- **Decisión: app instalable en Google Play y App Store, con los cobros en la
  web.** Apple y Google cobran una comisión (de hasta 15–30 %) por suscripciones
  digitales vendidas dentro de sus apps. La app de las tiendas es gratis y el
  usuario entra con su cuenta; se paga en la web con la pasarela local.
- **Google Play:** se permiten apps «de solo consumo» (se entra con la cuenta y
  se usa lo pagado en otro lado). Dentro de la app no hay botón ni enlace de
  pago; se puede informar que existen otras opciones sin enlazar.
- **App Store:**
  - Membresía de dojo: se vende a organizaciones para sus miembros o alumnos,
    lo que Apple permite cobrar fuera de la app (regla 3.1.3(c), servicios a
    organizaciones).
  - Competidor Plus es una suscripción personal: para servicios multiplataforma
    Apple pide que también se pueda comprar dentro de la app (regla 3.1.3(b)).
    Propuesta inicial: no ofrecer Plus en la app de iPhone (se ve en la web) o,
    si crece, ofrecerlo también con compra dentro de la app y aceptar la
    comisión en esas compras.
  - Las reglas cambian por país y por fallos judiciales (Epic contra Apple en
    2025, acuerdo de Google en 2026): confirmarlas al publicar.
- **Requisitos de las tiendas:** cuenta de desarrollador (Apple, pago anual;
  Google, pago único), política de privacidad, borrar la cuenta desde la app y
  declarar el público objetivo. Como hay menores, las cuentas las tienen los
  adultos (competidores mayores de edad, padres o apoderados y dojos); la app
  no se publica como app infantil.

## Dominio y expansión a otros países

- **Dominio: `.com`** (no `.pe`), porque la plataforma podría venderse en otros
  países. Registrarlo en Cloudflare, a precio de costo. Pruebas (TEST) en un
  subdominio del dominio actual en Cloudflare; producción en el `.com` propio.
  Se sugiere reservar también las variantes más obvias de la marca si están
  libres.
- **Lo que ya sirve en cualquier país:** reglas de kumite y kata configurables
  por torneo, tipos de documento genéricos (DNI, CE, pasaporte, otro), API
  pensada para varios clientes.
- **Mercado: Perú.** Vender en otros países es un plan de largo plazo: no se
  invierte tiempo en eso ahora. Lo de abajo queda solo como referencia para
  cuando llegue el momento.
- **Lo que habría que preparar para vender fuera de Perú (largo plazo):**
  - país, zona horaria y moneda por organización y por torneo (hoy la hora se
    muestra en hora de Lima);
  - protección de datos por país: en Perú la Ley 29733; cada país nuevo tiene
    su propia ley y sus reglas sobre datos de menores;
  - cobros y comprobantes por país (la pasarela y la facturación electrónica
    cambian);
  - interfaz en español primero; preparar los textos para traducir (inglés,
    portugués) cuando haga falta;
  - región de Azure cercana a Latinoamérica y la opción de guardar los datos
    en la región que exija cada país.
