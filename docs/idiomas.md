# Idiomas de la interfaz

Hajime se usa en español (Perú) y la interfaz también está disponible en
**inglés** y **portugués de Brasil**. El español es el idioma fuente y el de
siempre: si no hay preferencia ni el navegador pide otro idioma conocido, la
app arranca en español.

| Código | Locale (fechas, números, plurales) | Nombre en el selector |
| --- | --- | --- |
| `es` (por defecto) | `es-PE` | Español |
| `en` | `en-US` | English |
| `pt-BR` | `pt-BR` | Português (Brasil) |

## Cómo funciona

**Un solo build con traducciones en tiempo de ejecución** (`@angular/localize`):

1. El texto fuente está en español dentro del código: atributos `i18n` /
   `i18n-<atributo>` en las plantillas y `` $localize`:@@id:…` `` en TypeScript,
   cada uno con un **ID estable y con sentido** (`@@mesa.hajime`,
   `@@torneo.resumen.iniciar-torneo`, `@@error.version-conflict`).
2. `src/main.ts` llama a `cargarIdioma()` (`src/app/core/i18n/idioma.ts`)
   **antes** de `bootstrapApplication`:
   - elige el idioma: preferencia guardada en `localStorage`
     (`hajime.idioma`, leída con `try/catch` porque puede no existir) →
     `navigator.languages` (`pt`, `pt-PT` → pt-BR; `en-GB` → en) → español;
   - si no es español, descarga `i18n/<código>.json` (`cache: 'no-cache'`),
     registra los datos del locale (`pt-BR` en un chunk aparte que solo se
     descarga si hace falta; `en-US` viene con
     Angular) y llama a `loadTranslations`;
   - si algo falla (sin red, 404, JSON inválido) **arranca en español** y deja
     un aviso en la consola: la app nunca se queda en blanco por un idioma;
   - fija `$localize.locale` y `<html lang>`.
3. `LOCALE_ID` sale de `localeActual()` (`app.config.ts`), así que los pipes
   `date`, `number` y `currency` y los formateadores de `core/format.ts`
   (`fmtDateTime`, `fmtSoles`, `joinList`…) usan el locale elegido. Los soles
   siguen siendo soles: en español se muestran como siempre (`S/ 1,234.50`); en
   otros idiomas, con el formato de moneda de `Intl` para `PEN`.
4. Cambiar de idioma (selector «Idioma» en **Mi cuenta** y al pie del inicio de
   sesión, del directorio público, del seguimiento en vivo y del perfil
   público) guarda la preferencia **en ese dispositivo** y **recarga** la
   página. Recargar es lo más simple y seguro: todos los textos, incluidos los
   que ya se calcularon, salen en el idioma nuevo. La cola de eventos de la
   mesa vive en IndexedDB y sobrevive a la recarga.

Los archivos de traducción viven en `frontend/src/locale/`:

- `messages.json`: textos fuente extraídos (lo genera `npm run i18n:extract`;
  no se edita a mano ni pasa por Prettier).
- `en.json`, `pt-BR.json`: `{ "locale": …, "translations": { id: texto } }`.
  Se publican en `/i18n/` (asset de `angular.json`) y el service worker los
  precarga, así que el idioma elegido funciona sin red.

### Reglas del código

- **Nada de `$localize` a nivel de módulo** (constantes exportadas, campos
  estáticos): los `import` se evalúan antes de que `main.ts` cargue las
  traducciones y quedarían en español. ESLint lo impide
  (`no-restricted-syntax` en `eslint.config.js`). Para tablas de etiquetas se
  usan `etiquetas(() => ({ … }))` y `lista(() => [ … ])`
  (`core/i18n/etiquetas.ts`), que se construyen la primera vez que se leen; los
  títulos de ruta son funciones (`title: () => $localize…`).
- **Plurales con ICU** en las plantillas
  (`{n, plural, =1 {1 combate} other {{{n}} combates}}`) y el ICU como mensaje
  completo, no metido dentro de otro (si no, Angular genera IDs numéricos para
  el submensaje). En TypeScript, dos mensajes (`…-1` / `…-n`); `plural()` sigue
  existiendo para el código que lo usa con palabras sueltas.
- Etiquetas `aria-*` con valores interpolados: `[attr.aria-label]="metodo()"`
  con `$localize` en el componente.
- **Términos de karate sin traducir:** hajime, yame, senshu, hantei, kiken,
  shikkaku, ippon, waza-ari, yuko, chui, hansoku, kata, kumite, tatami, dojo,
  sensei (en portugués «tatame» y «dojô», que es como se escriben allá).

### Glosario

| Español | English | Português (Brasil) |
| --- | --- | --- |
| Llave | Bracket | Chave / chaveamento |
| Combate | Match (bout en equipos) | Luta |
| Grupos | Pools | Grupos |
| Round robin | Round robin | Todos contra todos |
| Repechaje | Repechage | Repescagem |
| Walkover | Walkover | W.O. |
| Cabeza de serie | Seed | Cabeça de chave |
| Competidor | Competitor | Atleta |
| Acreditación | Check-in | Credenciamento |
| Sanción | Penalty | Penalidade |
| Plantilla | Template | Modelo |
| Sede | Branch | Unidade |
| Apoderado | Guardian | Responsável |
| Planilla (papel) | Scoresheet | Súmula |
| Marcha blanca | Soft launch | Fase de testes |

## Errores de la API

El backend responde `{error: {code, message, details}}` con el mensaje en
español. `ApiError.from` (`core/api-error.ts`) pasa por `mensajeDeError`
(`core/i18n/errores.ts`):

- en **español** se muestra el mensaje del servidor tal cual (es el más
  preciso: nombra la categoría, el combate…);
- en otro idioma se traduce **por código** (`VERSION_CONFLICT`,
  `PLAN_REQUIRED` con `details.plan_name`, `WARNINGS`, `DB_WAKING`,
  errores de cuentas, cobros, llaves, mesa…); si el código es genérico
  (`NOT_FOUND`, `CONFLICT`, `INVALID_STATE`…) se busca el texto exacto entre
  los mensajes genéricos más comunes; y si tampoco está, **se muestra el
  mensaje del servidor** como respaldo. Nunca se pierde el error.

Los textos de las advertencias (`409 WARNINGS`) que arma el backend siguen en
español en todos los idiomas.

## Tareas habituales

```bash
cd frontend
npm run i18n:extract   # ng extract-i18n → src/locale/messages.json + resumen de lo que falta
npm run i18n:check     # lo que corre CI: re-extrae en una carpeta temporal y falla si
                       # messages.json no está al día, falta/sobra un ID en en/pt-BR,
                       # hay una traducción vacía o no respeta los marcadores
node scripts/i18n.mjs resumen --podar   # quita de en/pt-BR los IDs que ya no existen
```

**Agregar o cambiar un texto:** márcalo con un ID nuevo (si cambia el sentido,
cambia el ID para que se vuelva a traducir), `npm run i18n:extract`, agrega la
traducción del ID en `en.json` y `pt-BR.json` (respetando `{$INTERPOLATION}`,
`{$START_TAG_STRONG}`, los ICU…) y `npm run i18n:check`.

**Agregar un idioma:** una entrada en `IDIOMAS` (`core/i18n/idioma.ts`); si su
locale no es `en-US`, sus datos en `DATOS_LOCALE` (mismo archivo); el archivo
`src/locale/<código>.json`; el código en `IDIOMAS` de `scripts/i18n.mjs`; y el
glosario de arriba.

## Alternativas descartadas

- **Un build por idioma** (`ng build --localize`, lo recomendado por Angular):
  traduce en compilación y no cuesta nada en ejecución, pero multiplica los
  builds, las rutas (`/en/…`), el service worker y el Dockerfile, y cambiar de
  idioma sería navegar a otra app. Para una app que se instala como PWA y en
  Capacitor, un solo build es mucho más simple.
- **ngx-translate / Transloco:** claves en JSON en tiempo de ejecución, pero el
  texto deja de estar en el código (las plantillas se vuelven ilegibles y las
  pruebas e2e por texto pierden su referencia), no hay extracción ni
  verificación de marcadores y agregan una dependencia más.
- **Cargar las traducciones con `import()` dentro del bundle:** evita un fetch,
  pero mete los tres idiomas en el build; con `fetch` a `/i18n/*.json` cada
  quien descarga solo el suyo (~50 kB comprimido) y el service worker lo guarda.

Costo medido del enfoque elegido: el bundle inicial pasó de 451.56 kB
(126.27 kB transferidos) a 507.61 kB (143.44 kB); casi todo es el texto
fuente con sus IDs y metadatos. En español no se descarga nada más.

## Pendiente (siguientes pasos)

- **Correos y PDF** (diplomas, credenciales, llaves, planillas) y los textos
  que arma el backend (advertencias, nombres de categorías generadas) siguen
  en español. El paso natural es que la API reciba `Accept-Language` y
  traduzca sus plantillas con el mismo glosario.
- **Preferencia por cuenta:** hoy el idioma se guarda por dispositivo; podría
  guardarse también en el usuario para los correos.
- **Zona horaria y moneda por organización:** las horas siguen siendo las de
  Lima y los montos en soles, aunque cambie el idioma.
- El `manifest.webmanifest` (nombre y descripción al instalar) sigue en
  español.
