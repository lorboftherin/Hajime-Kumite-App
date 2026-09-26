// Formato de fechas y etiquetas según el idioma elegido (es-PE por defecto). Todas las horas en America/Lima.
import { etiquetas } from './i18n/etiquetas';
import { localeActual } from './i18n/idioma';

export const TZ = 'America/Lima';

/** El backend guarda UTC "naive": si no trae zona, se interpreta como UTC. */
export function parseUtc(v: string | Date | null | undefined): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const s = /[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : v + 'Z';
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// Formateadores por locale (el idioma se elige al arrancar; ver core/i18n/idioma.ts).
// La zona horaria sigue siendo la de Lima para todos los idiomas: la zona por
// organización es un paso siguiente (docs/idiomas.md).
const formatos = new Map<string, Intl.DateTimeFormat>();
function formato(tipo: 'dt' | 't' | 'd'): Intl.DateTimeFormat {
  const locale = localeActual();
  const clave = `${tipo}|${locale}`;
  let f = formatos.get(clave);
  if (!f) {
    const hora = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false } as const;
    f =
      tipo === 'dt'
        ? new Intl.DateTimeFormat(locale, { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', ...hora })
        : tipo === 't'
          ? new Intl.DateTimeFormat(locale, { timeZone: TZ, ...hora })
          : new Intl.DateTimeFormat(locale, { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });
    formatos.set(clave, f);
  }
  return f;
}

export function fmtDateTime(v: string | null | undefined): string {
  const d = parseUtc(v);
  return d ? formato('dt').format(d) : '';
}

export function fmtTime(v: string | null | undefined): string {
  const d = parseUtc(v);
  return d ? formato('t').format(d) : '';
}

/** Fechas de calendario (YYYY-MM-DD): no se desplazan por zona horaria. */
export function fmtDate(v: string | null | undefined): string {
  if (!v) return '';
  const d = new Date(v.length === 10 ? v + 'T00:00:00Z' : v);
  return isNaN(d.getTime()) ? v : formato('d').format(d);
}

/** Fecha de hoy en Lima como YYYY-MM-DD. */
/** Lima no tiene horario de verano: UTC−5 todo el año. */
const LIMA_OFFSET_MS = 5 * 3600 * 1000;

/** UTC de la API («2026-10-01T23:00:00») → valor de un input datetime-local en hora de Lima. */
export function utcToLimaInput(utc: string | null | undefined): string {
  if (!utc) return '';
  const ms = Date.parse(utc.endsWith('Z') || /[+-]\d\d:\d\d$/.test(utc) ? utc : utc + 'Z');
  if (Number.isNaN(ms)) return '';
  return new Date(ms - LIMA_OFFSET_MS).toISOString().slice(0, 16);
}

/** Valor de <input type="datetime-local"> (hora de Lima) → ISO con zona para la API. */
export function limaInputToIso(v: string): string | null {
  return v ? `${v}:00-05:00` : null;
}

export function todayLima(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

/**
 * Monto en soles: «S/ 69» o «S/ 34.50» en español (formato de es-PE); en otros
 * idiomas con el formato de moneda del locale («PEN 34.50», «PEN 34,50»). La
 * moneda por organización es un paso siguiente (docs/idiomas.md).
 */
export function fmtSoles(v: number): string {
  const frac = { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 };
  const locale = localeActual();
  if (locale === 'es-PE') return 'S/ ' + v.toLocaleString('es-PE', frac);
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'PEN', ...frac }).format(v);
}

export function mmss(totalSeconds: number): string {
  const neg = totalSeconds < 0;
  const s = Math.floor(Math.abs(totalSeconds));
  return `${neg ? '-' : ''}${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const TOURNAMENT_STATUS: Record<string, string> = etiquetas(() => ({
  draft: $localize`:@@estado-torneo.borrador:Borrador`,
  registration_open: $localize`:@@estado-torneo.inscripciones-abiertas:Inscripciones abiertas`,
  registration_closed: $localize`:@@estado-torneo.inscripciones-cerradas:Inscripciones cerradas`,
  in_progress: $localize`:@@estado-torneo.curso:En curso`,
  finished: $localize`:@@estado-torneo.finalizado:Finalizado`,
  cancelled: $localize`:@@estado-torneo.cancelado:Cancelado`,
}));

export const CATEGORY_STATUS: Record<string, string> = etiquetas(() => ({
  open: $localize`:@@estado-categoria.abierta:Abierta`,
  empty: $localize`:@@estado-categoria.vacia:Vacía`,
  merged: $localize`:@@estado-categoria.fusionada:Fusionada`,
  ready: $localize`:@@estado-categoria.lista:Lista`,
  in_progress: $localize`:@@estado-categoria.curso:En curso`,
  finished: $localize`:@@estado-categoria.finalizada:Finalizada`,
  cancelled: $localize`:@@estado-categoria.cancelada:Cancelada`,
}));

export const MATCH_STATUS: Record<string, string> = etiquetas(() => ({
  pending: $localize`:@@estado-combate.pendiente:Pendiente`,
  ready: $localize`:@@estado-combate.listo:Listo`,
  in_progress: $localize`:@@estado-combate.curso:En curso`,
  finished: $localize`:@@estado-combate.finalizado:Finalizado`,
  bye: $localize`:@@estado-combate.bye:Bye`,
  void: $localize`:@@estado-combate.anulado:Anulado`,
  needs_review: $localize`:@@estado-combate.revisar:Revisar`,
}));

export const REGISTRATION_STATUS: Record<string, string> = etiquetas(() => ({
  active: $localize`:@@estado-inscripcion.activa:Activa`,
  withdrawn: $localize`:@@estado-inscripcion.retirada:Retirada`,
  pending: $localize`:@@estado-inscripcion.pendiente:Pendiente`,
  rejected: $localize`:@@estado-inscripcion.rechazada:Rechazada`,
}));

export const ORG_ROLE_LABEL: Record<string, string> = etiquetas(() => ({ owner: $localize`:@@rol-organizacion.dueno:Dueño`, admin: $localize`:@@rol-organizacion.administrador:Administrador`, member: $localize`:@@rol-organizacion.miembro:Miembro` }));
export const ORG_KIND_LABEL: Record<string, string> = etiquetas(() => ({ league: $localize`:@@tipo-organizacion.liga:Liga`, dojo: 'Dojo', organizer: $localize`:@@tipo-organizacion.organizador:Organizador` }));
export const SUBSCRIPTION_STATUS: Record<string, string> = etiquetas(() => ({
  trial: $localize`:@@estado-suscripcion.prueba:Prueba`,
  active: $localize`:@@estado-suscripcion.activa:Activa`,
  past_due: $localize`:@@estado-suscripcion.pago-pendiente:Pago pendiente`,
  canceled: $localize`:@@estado-suscripcion.cancelada:Cancelada`,
}));

export const IMPORT_ROW_STATUS: Record<string, string> = etiquetas(() => ({
  new: $localize`:@@estado-fila-importacion.nueva:Nueva`,
  duplicate: $localize`:@@estado-fila-importacion.posible-duplicado:Posible duplicado`,
  error: $localize`:@@estado-fila-importacion.error:Con error`,
}));

export const IMPORT_BATCH_STATUS: Record<string, string> = etiquetas(() => ({
  preview: $localize`:@@estado-importacion.vista-previa:Vista previa`,
  confirmed: $localize`:@@estado-importacion.confirmada:Confirmada`,
  cancelled: $localize`:@@estado-importacion.cancelada:Cancelada`,
}));

export const DUPLICATE_REASON: Record<string, string> = etiquetas(() => ({
  document: $localize`:@@motivo-duplicado.mismo-documento:Mismo documento`,
  name_birth: $localize`:@@motivo-duplicado.mismo-nombre-fecha:Mismo nombre y fecha`,
  similar_name_birth: $localize`:@@motivo-duplicado.nombre-parecido-misma-fecha:Nombre parecido y misma fecha`,
  name_only: $localize`:@@motivo-duplicado.mismo-nombre:Mismo nombre`,
  same_file: $localize`:@@motivo-duplicado.repetido-archivo:Repetido en el archivo`,
}));

/** "1 posible duplicado", "2 posibles duplicados" (la función vive en shared/plural). */
export { plural } from '../shared/plural';

export const FORMAT_LABEL: Record<string, string> = etiquetas(() => ({
  single_elimination: $localize`:@@formato-llave.eliminacion-directa:Eliminación directa`,
  round_robin: $localize`:@@formato-llave.round-robin:Round robin`,
  kata_rounds: $localize`:@@formato-llave.rondas-kata:Rondas de kata`,
  groups_knockout: $localize`:@@formato-llave.grupos-eliminacion:Grupos + eliminación`,
}));

export const THIRD_PLACE_LABEL: Record<string, string> = etiquetas(() => ({
  two_bronzes: $localize`:@@tercer-puesto.dos-bronces:Dos bronces`,
  third_place_match: $localize`:@@tercer-puesto.combate-3:Combate por el 3.º`,
  repechage: $localize`:@@tercer-puesto.repechaje:Repechaje`,
}));

export const METHOD_LABEL: Record<string, string> = etiquetas(() => ({
  points: $localize`:@@metodo.puntos:Puntos`,
  point_gap: $localize`:@@metodo.diferencia-8:Diferencia de 8`,
  senshu: 'Senshu',
  hantei: $localize`:@@metodo.hantei-jueces:Hantei (jueces)`,
  golden_point: $localize`:@@metodo.punto-oro:Punto de oro`,
  hansoku: 'Hansoku',
  kiken: $localize`:@@metodo.kiken-abandono:Kiken (abandono)`,
  shikkaku: $localize`:@@metodo.shikkaku-descalificacion:Shikkaku (descalificación)`,
  walkover: $localize`:@@metodo.walkover:Walkover`,
  decision: $localize`:@@metodo.decision:Decisión`,
  flags: $localize`:@@metodo.banderas:Banderas`,
  bye: $localize`:@@metodo.bye:Bye`,
  draw: $localize`:@@metodo.hikiwake-empate:Hikiwake (empate)`,
  victories: $localize`:@@metodo.victorias:Victorias`,
  extra_bout: $localize`:@@metodo.combate-extra:Combate extra`,
  scores: $localize`:@@metodo.puntuacion:Puntuación`,
  incomplete_team: $localize`:@@metodo.alineacion-incompleta:Alineación incompleta`,
  not_disputed: $localize`:@@metodo.no-disputado:No disputado`,
}));

/** Criterios de desempate de round robin (competition_rules.round_robin_criteria). */
export const RR_CRITERIA_LABEL: Record<string, string> = etiquetas(() => ({
  wins: $localize`:@@criterio-desempate.victorias:Victorias`,
  head_to_head: $localize`:@@criterio-desempate.enfrentamiento-directo:Enfrentamiento directo`,
  diff: $localize`:@@criterio-desempate.diferencia-puntos:Diferencia de puntos`,
  points_for: $localize`:@@criterio-desempate.puntos-favor:Puntos a favor`,
  fewer_sanctions: $localize`:@@criterio-desempate.menos-sanciones:Menos sanciones`,
  draw: $localize`:@@criterio-desempate.sorteo:Sorteo`,
}));

export const ROLE_LABEL: Record<string, string> = etiquetas(() => ({
  organizer: $localize`:@@rol.organizador:Organizador`,
  table_operator: $localize`:@@rol.operador-mesa:Operador de mesa`,
  dojo_admin: $localize`:@@rol.admin-dojo:Admin de dojo`,
  referee: $localize`:@@rol.arbitro:Árbitro`,
  sensei: 'Sensei',
}));

export const SCOPE_LABEL: Record<string, string> = etiquetas(() => ({
  organization: $localize`:@@alcance.organizacion:organización`,
  tournament: $localize`:@@alcance.torneo:torneo`,
  dojo: 'dojo',
  tatami: 'tatami',
}));

export const EVENT_LABEL: Record<string, string> = etiquetas(() => ({
  point: $localize`:@@evento.punto:Punto`,
  sanction: $localize`:@@evento.sancion:Sanción`,
  start: $localize`:@@evento.hajime-inicio:Hajime (inicio)`,
  pause: $localize`:@@evento.yame-pausa:Yame (pausa)`,
  resume: $localize`:@@evento.hajime-reanuda:Hajime (reanuda)`,
  time_adjust: $localize`:@@evento.ajuste-tiempo:Ajuste de tiempo`,
  annul: $localize`:@@evento.anulacion:Anulación`,
  senshu_cancel: $localize`:@@evento.senshu-cancelado:Senshu cancelado`,
  hantei: 'Hantei',
  kiken: 'Kiken',
  shikkaku: 'Shikkaku',
  walkover: $localize`:@@evento.walkover:Walkover`,
  finish: $localize`:@@evento.fin-combate:Fin del combate`,
}));

export const POINT_LABEL: Record<number, string> = { 1: 'Yuko', 2: 'Waza-ari', 3: 'Ippon' };

export const MODALITY_LABEL: Record<string, string> = { kumite: 'Kumite', kata: 'Kata' };
export const SEX_LABEL: Record<string, string> = etiquetas(() => ({ M: $localize`:@@sexo.masculino:Masculino`, F: $localize`:@@sexo.femenino:Femenino`, X: $localize`:@@sexo.mixto:Mixto` }));

export const GRADES: string[] = [
  ...Array.from({ length: 10 }, (_, i) => `${10 - i} kyu`),
  ...Array.from({ length: 10 }, (_, i) => `${i + 1} dan`),
];

export function statusTone(status: string): string {
  switch (status) {
    case 'finished':
    case 'active':
    case 'new':
      return 'ok';
    case 'in_progress':
    case 'registration_open':
    case 'ready':
      return 'info';
    case 'needs_review':
    case 'duplicate':
    case 'registration_closed':
    case 'merged':
    case 'pending':
      return 'warn';
    case 'cancelled':
    case 'error':
    case 'withdrawn':
    case 'rejected':
    case 'void':
      return 'danger';
    default:
      return '';
  }
}

export function newId(): string {
  const c: Crypto = globalThis.crypto;
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  // Respaldo para contextos no seguros (http en LAN): UUID v4 con getRandomValues.
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const ADVICE_LABEL: Record<string, string> = etiquetas(() => ({
  empty: $localize`:@@sugerencia.sin-inscritos:Sin inscritos`,
  merge: $localize`:@@sugerencia.fusionar-otra:Fusionar con otra`,
  cancel: $localize`:@@sugerencia.cancelar:Cancelar`,
  keep: $localize`:@@sugerencia.mantener:Mantener`,
  direct_final: $localize`:@@sugerencia.final-directa:Final directa`,
  round_robin: $localize`:@@sugerencia.round-robin:Round robin`,
  split: $localize`:@@sugerencia.dividir-supera-cupo:Dividir (supera el cupo)`,
}));

/** Ícono de medalla por puesto (1-3); '' si no hay medalla. */
export const MEDAL_ICON: Record<number, string> = { 1: '🥇', 2: '🥈', 3: '🥉' };

/** "🥇 Oro", "🥈 Plata", "🥉 Bronce", "5.º puesto" o "Sin puesto". */
export function placeLabel(place: number | null | undefined): string {
  if (!place) return $localize`:@@formato.sin-puesto:Sin puesto`;
  const name: Record<number, string> = { 1: $localize`:@@medalla.oro:Oro`, 2: $localize`:@@medalla.plata:Plata`, 3: $localize`:@@medalla.bronce:Bronce` };
  return name[place] ? `${MEDAL_ICON[place]} ${name[place]}` : $localize`:@@formato.puesto-n:${place}:puesto:.º puesto`;
}

/** Marcador "propio – rival"; guion si el combate no tiene puntaje (p. ej. kiken). */
export function scoreText(score: [number | null, number | null] | null | undefined): string {
  if (!score || (score[0] === null && score[1] === null)) return '—';
  return `${score[0] ?? 0} – ${score[1] ?? 0}`;
}

/** Etiqueta de un método de victoria en el idioma de la interfaz; el código tal cual si no se conoce. */
export function methodText(method: string | null | undefined): string {
  if (!method) return '—';
  return METHOD_LABEL[method] ?? method;
}

/** Marcador de un combate; una decisión por banderas (kata) no tiene marcador. */
export function matchScoreText(
  score: [number | null, number | null] | null | undefined,
  method: string | null | undefined,
): string {
  return method === 'flags' ? $localize`:@@metodo.banderas:Banderas` : scoreText(score);
}

export const AUDIT_ACTION: Record<string, string> = etiquetas(() => ({
  create: $localize`:@@auditoria.accion.creacion:Creación`,
  update: $localize`:@@auditoria.accion.edicion:Edición`,
  status: $localize`:@@auditoria.accion.cambio-estado:Cambio de estado`,
  reopen: $localize`:@@auditoria.accion.reapertura:Reapertura`,
  finish: $localize`:@@auditoria.accion.cierre-combate:Cierre de combate`,
  refinish: $localize`:@@auditoria.accion.cierre-tras-reapertura:Cierre tras reapertura`,
  correct_winner: $localize`:@@auditoria.accion.correccion-ganador:Corrección de ganador`,
  correct_score: $localize`:@@auditoria.accion.correccion-marcador:Corrección de marcador`,
  official_result: $localize`:@@auditoria.accion.resultado-oficial:Resultado oficial`,
  merge: $localize`:@@auditoria.accion.fusion:Fusión`,
  unmerge: $localize`:@@auditoria.accion.fusion-deshecha:Fusión deshecha`,
  revert_merge: $localize`:@@auditoria.accion.fusion-revertida:Fusión revertida`,
  withdraw: $localize`:@@auditoria.accion.retiro:Retiro`,
  generate: $localize`:@@auditoria.accion.generacion-llave:Generación de llave`,
  swap: $localize`:@@auditoria.accion.intercambio-llave:Intercambio en llave`,
  generate_categories: $localize`:@@auditoria.accion.categorias-desde-plantilla:Categorías desde plantilla`,
  preview: $localize`:@@auditoria.accion.vista-previa-importacion:Vista previa de importación`,
  confirm: $localize`:@@auditoria.accion.importacion-confirmada:Importación confirmada`,
  cancel: $localize`:@@auditoria.accion.cancelacion:Cancelación`,
  add_role: $localize`:@@auditoria.accion.rol-asignado:Rol asignado`,
  remove_role: $localize`:@@auditoria.accion.rol-quitado:Rol quitado`,
  change_password: $localize`:@@auditoria.accion.cambio-contrasena:Cambio de contraseña`,
  anonymize: $localize`:@@auditoria.accion.anonimizacion:Anonimización`,
  score: $localize`:@@auditoria.accion.notas-kata:Notas de kata`,
  correct_scores: $localize`:@@auditoria.accion.correccion-notas-kata:Corrección de notas de kata`,
  kata_tie_break: $localize`:@@auditoria.accion.desempate-kata:Desempate de kata`,
  add_tatami: $localize`:@@auditoria.accion.tatami-agregado:Tatami agregado`,
  add_grade: $localize`:@@auditoria.accion.grado-registrado:Grado registrado`,
  change_dojo: $localize`:@@auditoria.accion.cambio-dojo:Cambio de dojo`,
  add_consent: $localize`:@@auditoria.accion.consentimiento-registrado:Consentimiento registrado`,
  add_branch: $localize`:@@auditoria.accion.sede-agregada:Sede agregada`,
  create_despite_duplicates: $localize`:@@auditoria.accion.creacion-pese-posibles:Creación pese a posibles duplicados`,
  lineup: $localize`:@@auditoria.accion.alineacion-enfrentamiento:Alineación del enfrentamiento`,
  lineup_extra: $localize`:@@auditoria.accion.combate-extra-agregado:Combate extra agregado`,
  undecide: $localize`:@@auditoria.accion.enfrentamiento-sin-decidir:Enfrentamiento sin decidir (corrección)`,
  take_table: $localize`:@@auditoria.accion.tablet-tomo-mesa:Tablet tomó la mesa`,
  walkover: $localize`:@@auditoria.accion.walkover-retiro:Walkover por retiro`,
  queue: $localize`:@@auditoria.accion.cola-tatami:Cola del tatami`,
  edit_row: $localize`:@@auditoria.accion.fila-importacion-corregida:Fila de importación corregida`,
  self_registration: $localize`:@@auditoria.accion.inscripcion-linea:Inscripción en línea`,
  request: $localize`:@@auditoria.accion.solicitud-inscripcion:Solicitud de inscripción`,
  approve: $localize`:@@auditoria.accion.aprobacion:Aprobación`,
  reject: $localize`:@@auditoria.accion.rechazo:Rechazo`,
  cancel_request: $localize`:@@auditoria.accion.solicitud-retirada:Solicitud retirada`,
  revoke: $localize`:@@auditoria.accion.revocacion:Revocación`,
  add_member: $localize`:@@auditoria.accion.miembro-agregado:Miembro agregado`,
  update_member: $localize`:@@auditoria.accion.rol-miembro-cambiado:Rol de miembro cambiado`,
  remove_member: $localize`:@@auditoria.accion.miembro-quitado:Miembro quitado`,
  mark_paid: $localize`:@@auditoria.accion.pago-confirmado:Pago confirmado`,
  checkout: $localize`:@@auditoria.accion.plan-solicitado:Plan solicitado`,
}));

export const AUDIT_ENTITY: Record<string, string> = etiquetas(() => ({
  match: $localize`:@@auditoria.entidad.combate:Combate`,
  category: $localize`:@@auditoria.entidad.categoria:Categoría`,
  tournament: $localize`:@@auditoria.entidad.torneo:Torneo`,
  registration: $localize`:@@auditoria.entidad.inscripcion:Inscripción`,
  person: $localize`:@@auditoria.entidad.persona:Persona`,
  bracket: $localize`:@@auditoria.entidad.llave:Llave`,
  dojo: 'Dojo',
  import: $localize`:@@auditoria.entidad.importacion:Importación`,
  user: $localize`:@@auditoria.entidad.usuario:Usuario`,
  kata_performance: $localize`:@@auditoria.entidad.ejecucion-kata:Ejecución de kata`,
  template: $localize`:@@auditoria.entidad.plantilla-2:<ng-container i18n="@@auditoria.entidad.plantilla">Plantilla</ng-container>`,
  team: $localize`:@@auditoria.entidad.equipo:Equipo`,
  referee_assignment: $localize`:@@auditoria.entidad.asignacion-arbitro:Asignación de árbitro`,
  tatami: 'Tatami',
  organization: $localize`:@@auditoria.entidad.organizacion-2:Organización`,
  subscription: $localize`:@@auditoria.entidad.suscripcion:Suscripción`,
  invitation: $localize`:@@auditoria.entidad.invitacion:Invitación`,
  dojo_admin_request: $localize`:@@auditoria.entidad.pedido-admin-dojo:Pedido de admin de dojo`,
}));
