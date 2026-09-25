# Modelo de negocio: freemium en tres niveles

Decisión del 25/09/2026. Completa la sección 3 del documento maestro, que dejaba
la monetización abierta.

## Niveles

| Nivel | Para quién | Precio | Qué incluye |
| --- | --- | --- | --- |
| **Público** | Cualquiera, sin cuenta | Gratis | Torneos, llaves, resultados, medallero por dojo, seguimiento en vivo, perfil básico del competidor (medallas y torneos) |
| **Competidor** (suscripción) | Competidores adultos y padres o apoderados de menores | Mensual o anual | Historial completo, estadísticas e *insights*: perfil deportivo, línea de tiempo de cada combate, técnicas, forma, índice Hajime, insignias, comparación con rivales, avisos del próximo combate, tarjetas para compartir y certificados |
| **Premium** (membresía) | Organizadores, ligas y dojos | Mensual o anual (por organización) | Organizar torneos (inscripciones, llaves, mesa, varios tatamis, árbitros, reportes, Shadow Mode), transmisión en vivo con overlay, inscribir alumnos en torneos de otros organizadores, administrar el dojo y sus competidores |

El nivel Premium podría dividirse después en **Dojo** (administrar e inscribir
alumnos) y **Organizador** (crear torneos). Se decide con los primeros
clientes.

## Qué ya existe y a qué nivel pertenece

| Función actual | Nivel |
| --- | --- |
| Vivo público, resultados, medallero | Público |
| Perfil deportivo, hoja del combate, líderes, insignias, tarjeta para compartir | Competidor (en el público queda la versión básica) |
| Torneos, inscripciones, Excel, llaves, mesa, equipos, tatamis, árbitros, Shadow Mode, overlay | Premium |

## Qué falta construir, en orden

1. **Organizaciones y membresías (base de todo).**
   - Entidad *Organización* (liga, club organizador o dojo) dueña de sus torneos, usuarios y plantillas.
   - Las personas y dojos siguen siendo compartidos: así cada competidor tiene un solo historial en todos los torneos.
   - Planes y derechos (*entitlements*) verificados en la API, no solo en la pantalla.
   - Al principio el Admin activa las membresías a mano, sin cobro automático, para trabajar con organizaciones piloto.
2. **Portal público.**
   - Páginas abiertas y con buscador de torneos, dojos y perfiles básicos.
   - Generadas en el servidor (Angular SSR) para que Google las indexe.
3. **Cuentas de competidor.**
   - Registro abierto con verificación de correo.
   - *Reclamar perfil*: un adulto reclama el suyo; un padre o apoderado reclama el de su hijo o hija, validado por el dojo o sensei, o con el documento.
   - Suscripción que habilita historial completo, estadísticas y avisos.
4. **Cobros.**
   - Pasarela local con pagos recurrentes: Culqi, Mercado Pago o Izipay.
   - Comprobantes electrónicos para SUNAT (boleta y factura) mediante un proveedor OSE/PSE.
   - Periodo de prueba y cupones: por ejemplo, el primer torneo gratis para un organizador.
5. **Modo offline de la mesa (PWA).** Un organizador que paga no puede depender del Wi‑Fi del coliseo.

## Reglas que el modelo no puede romper

- **Los resultados siguen siendo gratis y públicos.** Pagar da más información y herramientas, nunca «ocultar» o cambiar resultados.
- **Menores de edad (Ley 29733):**
  - la suscripción no compra acceso a datos de menores ajenos;
  - el detalle completo de un menor lo ve su padre o apoderado (perfil reclamado) y su dojo;
  - el público y otros suscriptores ven lo básico, con nombre abreviado salvo autorización expresa;
  - la comparación con rivales menores usa solo resultados públicos.
- **Documento y fecha de nacimiento nunca se muestran** a nadie fuera del organizador y su dojo.
- **Consentimiento:** el de padres o apoderados debe cubrir expresamente la publicación de resultados y el uso de sus datos en estadísticas.

## Decisiones abiertas

- [ ] Precios en soles de cada nivel, y si el Premium cobra por mes, por torneo o por número de competidores.
- [ ] ¿Premium único o dividido en Dojo y Organizador?
- [ ] ¿Quién puede editar una persona o dojo compartidos entre organizaciones? Propuesta: el dojo reclamado; si nadie lo reclamó, la organización que la creó; con historial de cambios.
- [ ] Pasarela de pago y proveedor de comprobantes electrónicos.
- [ ] Validación legal: inscripción del banco de datos ante la autoridad, política de privacidad, términos de uso y consentimiento de menores que cubra la publicación y las estadísticas.
