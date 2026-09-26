// Errores de la API en el idioma de la interfaz (docs/idiomas.md).
//
// El backend responde {error: {code, message, details}} con el mensaje en
// español. En español se muestra tal cual (es el más preciso: nombra la
// categoría, el combate…). En otros idiomas se traduce por `code`; si el
// código no está aquí, o es genérico (NOT_FOUND, FORBIDDEN, CONFLICT,
// INVALID_STATE…), se usa el texto de los mensajes genéricos más comunes y,
// si tampoco está, el mensaje del servidor como respaldo.
import { IDIOMA_FUENTE, idiomaActual } from './idioma';

type Detalles = Record<string, unknown>;

/** Códigos con un significado estable (backend: grep `code=` y app/api/errors.py). */
const POR_CODIGO: Record<string, (d: Detalles) => string> = {
  // --- Genéricos con significado propio (app/api/errors.py) ---
  VERSION_CONFLICT: () =>
    $localize`:@@error.version-conflict:Otra persona modificó este dato. Recarga y vuelve a intentar.`,
  TOO_MANY_ATTEMPTS: () =>
    $localize`:@@error.too-many-attempts:Demasiados intentos. Espera unos minutos e intenta de nuevo.`,
  PLAN_REQUIRED: (d) =>
    typeof d['plan_name'] === 'string' && d['plan_name']
      ? $localize`:@@error.plan-required-nombre:Esta función necesita el plan ${d['plan_name']}:plan:.`
      : $localize`:@@error.plan-required:Esta función necesita un plan.`,
  WARNINGS: () => $localize`:@@error.warnings:Hay advertencias que requieren confirmación`,
  VALIDATION_ERROR: () => $localize`:@@error.validation-error:Datos inválidos`,
  INTERNAL_ERROR: () =>
    $localize`:@@error.internal-error:Error interno del servidor. Si se repite, avisa indicando el código de la petición.`,
  SERVER_BUSY: () => $localize`:@@error.server-busy:El servidor está ocupado, reintenta en unos segundos`,
  DB_WAKING: () => $localize`:@@error.db-waking:La base de datos está despertando, reintenta en unos segundos`,
  DB_UNAVAILABLE: () => $localize`:@@error.db-unavailable:La base de datos no responde, reintenta en unos segundos`,
  METHOD_NOT_ALLOWED: () => $localize`:@@error.method-not-allowed:Operación no permitida`,
  REFRESH_RACE: () => $localize`:@@error.refresh-race:La sesión ya se renovó en otra pestaña`,
  // --- Cuentas, perfiles y avisos ---
  ADULT_PROFILE: () => $localize`:@@error.adult-profile:Es el perfil de un adulto: lo reclama la propia persona`,
  MINOR_PROFILE: () =>
    $localize`:@@error.minor-profile:Es el perfil de un menor de edad: lo reclama su padre, madre o apoderado`,
  ALREADY_LINKED: () => $localize`:@@error.already-linked:La cuenta o el perfil ya están ligados`,
  PROFILE_TAKEN: () => $localize`:@@error.profile-taken:Este perfil ya está ligado a otra cuenta. Consulta con tu dojo.`,
  CLAIM_PENDING: () => $localize`:@@error.claim-pending:Ya tienes una solicitud pendiente para este perfil`,
  ALREADY_REVIEWED: () => $localize`:@@error.already-reviewed:La solicitud ya fue revisada`,
  CONSENT_REQUIRED: () =>
    $localize`:@@error.consent-required:Para reclamar el perfil de un menor debes aceptar la publicación de sus resultados y estadísticas`,
  EMAIL_NOT_VERIFIED: () => $localize`:@@error.email-not-verified:Confirma tu correo antes de reclamar un perfil`,
  EMAIL_TAKEN: () => $localize`:@@error.email-taken:Ese correo ya está en uso por otra cuenta`,
  INVALID_EMAIL: () => $localize`:@@error.invalid-email:Correo no válido`,
  NO_EMAIL: () => $localize`:@@error.no-email:Tu cuenta no tiene correo`,
  ALREADY_VERIFIED: () => $localize`:@@error.already-verified:Tu correo ya está verificado`,
  SIGNUP_CLOSED: () => $localize`:@@error.signup-closed:El registro abierto no está habilitado`,
  QUERY_TOO_SHORT: () => $localize`:@@error.query-too-short:Escribe al menos 3 letras del nombre`,
  PERSON_REQUIRED: () =>
    $localize`:@@error.person-required:Tu cuenta no está ligada a una persona: pide al organizador que la vincule`,
  PUSH_DISABLED: () => $localize`:@@error.push-disabled:Los avisos no están activos en este servidor`,
  PUSH_ENDPOINT: () => $localize`:@@error.push-endpoint:El servicio de avisos de este navegador no está admitido`,
  PUSH_KEYS: () => $localize`:@@error.push-keys:Las claves de la suscripción no son válidas`,
  PUSH_TARGET: () => $localize`:@@error.push-target:Indica una persona o un dojo`,
  PUSH_TOO_MANY: () => $localize`:@@error.push-too-many:Llegaste al máximo de perfiles o competidores que puedes seguir`,
  // --- Organización, pagos y planes ---
  ORGANIZATION_REQUIRED: () => $localize`:@@error.organization-required:Elige la organización del torneo`,
  COUPON_INVALID: () =>
    $localize`:@@error.coupon-invalid:El cupón no es válido para este plan (no existe, venció o ya se usó)`,
  TRIAL_USED: () =>
    $localize`:@@error.trial-used:La organización ya usó su periodo de prueba o ya tuvo un plan`,
  PAYER_EMAIL_REQUIRED: () =>
    $localize`:@@error.payer-email-required:Para el pago mensual automático indica el correo de tu cuenta de Mercado Pago`,
  // --- Torneo, inscripciones e importación ---
  REASON_REQUIRED: () => $localize`:@@error.reason-required:Esta acción requiere un motivo`,
  INVALID_SLUG: () =>
    $localize`:@@error.invalid-slug:La dirección solo puede tener letras minúsculas sin tildes, números y guiones (3 a 80 caracteres)`,
  SLUG_TAKEN: () => $localize`:@@error.slug-taken:Esa dirección ya la usa otro torneo`,
  INVALID_TIMEZONE: () => $localize`:@@error.invalid-timezone:Zona horaria desconocida`,
  INVALID_RULES: () => $localize`:@@error.invalid-rules:Las reglas de competencia no son válidas`,
  SELF_REGISTRATION_CLOSED: () =>
    $localize`:@@error.self-registration-closed:La inscripción en línea de este torneo está cerrada`,
  DOJO_REQUIRED: () => $localize`:@@error.dojo-required:Elige tu dojo`,
  ALREADY_REGISTERED: () =>
    $localize`:@@error.already-registered:La persona ya está inscrita o pendiente en esa categoría`,
  DUPLICATE_DOCUMENT: () => $localize`:@@error.duplicate-document:Ese documento ya pertenece a otra persona`,
  TEAM_CATEGORY: () => $localize`:@@error.team-category:La categoría es por equipos: inscribe un equipo`,
  NOT_TEAM_CATEGORY: () => $localize`:@@error.not-team-category:La categoría es individual: inscribe a cada persona`,
  TEAM_MEMBER_REPEATED: () => $localize`:@@error.team-member-repeated:Una persona aparece dos veces en el equipo`,
  SPLIT_TOO_FEW: () => $localize`:@@error.split-too-few:Se necesitan al menos 2 inscritos para dividir`,
  FILE_TOO_LARGE: () => $localize`:@@error.file-too-large:El archivo es demasiado grande`,
  EMPTY_FILE: () => $localize`:@@error.empty-file:El archivo no tiene datos`,
  INVALID_FILE: () => $localize`:@@error.invalid-file:El archivo no es un Excel válido (.xlsx)`,
  INVALID_TEMPLATE: () => $localize`:@@error.invalid-template:La plantilla tiene errores`,
  DUPLICATE_CODE: () => $localize`:@@error.duplicate-code:Hay un código de categoría repetido en la plantilla`,
  TOO_MANY_ROWS: () => $localize`:@@error.too-many-rows:La plantilla tiene demasiadas categorías`,
  // --- Llaves ---
  BRACKET_STARTED: () =>
    $localize`:@@error.bracket-started:Hay combates iniciados: la llave ya no se puede regenerar completa. Para cambios puntuales usa «Añadir a la llave» o «Quitar de la llave»`,
  CATEGORY_FINISHED: () => $localize`:@@error.category-finished:La categoría ya terminó`,
  ALREADY_IN_BRACKET: () => $localize`:@@error.already-in-bracket:Ya está en la llave`,
  NO_FREE_BYE: () =>
    $localize`:@@error.no-free-bye:La llave no tiene byes libres de primera ronda: regenérala si aún no empezó`,
  UNSUPPORTED_FORMAT: () =>
    $localize`:@@error.unsupported-format:En grupos + eliminación no se agrega a nadie con la llave generada: regenérala si aún no empezó`,
  GROUPS_TOO_FEW: () => $localize`:@@error.groups-too-few:No hay suficientes inscritos para esa cantidad de grupos`,
  ROUND_CLOSED: () => $localize`:@@error.round-closed:La primera ronda de kata ya terminó`,
  KATA_ORDER_MISMATCH: () =>
    $localize`:@@error.kata-order-mismatch:El orden debe incluir exactamente a todos los de la ronda`,
  // --- Mesa y combates ---
  CONFLICT_DEVICE: () =>
    $localize`:@@error.conflict-device:Otra tablet lleva la mesa de este combate. Pulsa «Tomar la mesa» para registrar desde aquí.`,
  MATCH_STARTED: () =>
    $localize`:@@error.match-started:Ese combate ya empezó: ciérralo en la mesa o usa walkover o corrección`,
  MATCH_NOT_READY: () => $localize`:@@error.match-not-ready:El combate no tiene dos participantes definidos`,
  EVENT_ID_CONFLICT: () => $localize`:@@error.event-id-conflict:Ese id de evento pertenece a otro combate`,
  GOLDEN_POINT_STARTED: () => $localize`:@@error.golden-point-started:El combate ya está en punto de oro`,
  DRAW_NOT_ALLOWED: () =>
    $localize`:@@error.draw-not-allowed:Solo un combate individual por equipos puede terminar en empate`,
  EXTRA_BOUT_NEEDS_HANTEI: () =>
    $localize`:@@error.extra-bout-needs-hantei:El combate extra no puede terminar empatado: decide por hantei`,
  HANTEI_VOTES: () =>
    $localize`:@@error.hantei-votes:Los votos del hantei no son válidos: 3 o 5 jueces y el color de la mayoría`,
  INVALID_INFRACTION: () => $localize`:@@error.invalid-infraction:Tipo de falta desconocido`,
  BOUT_STARTED: () => $localize`:@@error.bout-started:Ese combate ya empezó; no se cambia su alineación`,
  LINEUP_SIZE: () =>
    $localize`:@@error.lineup-size:La alineación no tiene la cantidad de combates del enfrentamiento`,
  NOT_TEAM_MATCH: () =>
    $localize`:@@error.not-team-match:Solo los enfrentamientos de kumite por equipos tienen alineación`,
  TEAM_INCOMPLETE: () =>
    $localize`:@@error.team-incomplete:Ninguno de los dos equipos presenta los integrantes mínimos: decide el organizador`,
  ALREADY_ASSIGNED: () => $localize`:@@error.already-assigned:Esa persona ya tiene esa asignación`,
};

/** Mensajes genéricos frecuentes (códigos NOT_FOUND, UNAUTHORIZED, FORBIDDEN…), por su texto exacto. */
const POR_TEXTO: Record<string, () => string> = {
  'Usuario o contraseña incorrectos': () => $localize`:@@error.usuario-contrasena-incorrectos:Usuario o contraseña incorrectos`,
  'Sesión inválida o expirada': () => $localize`:@@error.sesion-invalida:Sesión inválida o expirada`,
  'Sesión cerrada o expirada': () => $localize`:@@error.sesion-cerrada:Sesión cerrada o expirada`,
  'Se requiere iniciar sesión': () => $localize`:@@error.requiere-sesion:Se requiere iniciar sesión`,
  'La contraseña no es correcta': () => $localize`:@@error.contrasena-incorrecta:La contraseña no es correcta`,
  'La contraseña actual no es correcta': () =>
    $localize`:@@error.contrasena-actual-incorrecta:La contraseña actual no es correcta`,
  'No tienes acceso a este torneo': () => $localize`:@@error.sin-acceso-torneo:No tienes acceso a este torneo`,
  'Solo el dueño o un administrador de la organización puede hacer esto': () =>
    $localize`:@@error.solo-duenio-admin:Solo el dueño o un administrador de la organización puede hacer esto`,
  'Este enlace de seguimiento no existe o fue desactivado': () =>
    $localize`:@@error.enlace-seguimiento-inexistente:Este enlace de seguimiento no existe o fue desactivado`,
  'Este torneo no existe o no tiene la página pública activa': () =>
    $localize`:@@error.torneo-publico-inexistente:Este torneo no existe o no tiene la página pública activa`,
  'La invitación no existe o fue revocada': () =>
    $localize`:@@error.invitacion-inexistente:La invitación no existe o fue revocada`,
  'No encontrado': () => $localize`:@@error.no-encontrado:No encontrado`,
  'Datos inválidos': () => $localize`:@@error.validation-error:Datos inválidos`,
};

/** Códigos que se traducen en el cliente (para las pruebas y la documentación). */
export const CODIGOS_TRADUCIDOS: readonly string[] = Object.keys(POR_CODIGO);

/**
 * Mensaje de un error de la API para mostrar. En español, el del servidor; en
 * otros idiomas, la traducción por código, luego por texto conocido y, si no
 * hay, el del servidor.
 */
export function mensajeDeError(code: string, servidor: string, details: Detalles = {}): string {
  if (idiomaActual().codigo === IDIOMA_FUENTE.codigo) return servidor;
  return POR_CODIGO[code]?.(details) ?? POR_TEXTO[servidor]?.() ?? servidor;
}
