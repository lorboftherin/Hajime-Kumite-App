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
