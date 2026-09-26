// Formato de fechas y etiquetas en español (Perú). Todas las horas en America/Lima.

export const TZ = 'America/Lima';

/** El backend guarda UTC "naive": si no trae zona, se interpreta como UTC. */
export function parseUtc(v: string | Date | null | undefined): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const s = /[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : v + 'Z';
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

const dtFmt = new Intl.DateTimeFormat('es-PE', {
  timeZone: TZ,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const tFmt = new Intl.DateTimeFormat('es-PE', {
  timeZone: TZ,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const dFmt = new Intl.DateTimeFormat('es-PE', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });

export function fmtDateTime(v: string | null | undefined): string {
  const d = parseUtc(v);
  return d ? dtFmt.format(d) : '';
}

export function fmtTime(v: string | null | undefined): string {
  const d = parseUtc(v);
  return d ? tFmt.format(d) : '';
}

/** Fechas de calendario (YYYY-MM-DD): no se desplazan por zona horaria. */
export function fmtDate(v: string | null | undefined): string {
  if (!v) return '';
  const d = new Date(v.length === 10 ? v + 'T00:00:00Z' : v);
  return isNaN(d.getTime()) ? v : dFmt.format(d);
}

/** Fecha de hoy en Lima como YYYY-MM-DD. */
export function todayLima(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

export function mmss(totalSeconds: number): string {
  const neg = totalSeconds < 0;
  const s = Math.floor(Math.abs(totalSeconds));
  return `${neg ? '-' : ''}${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const TOURNAMENT_STATUS: Record<string, string> = {
  draft: 'Borrador',
  registration_open: 'Inscripciones abiertas',
  registration_closed: 'Inscripciones cerradas',
  in_progress: 'En curso',
  finished: 'Finalizado',
  cancelled: 'Cancelado',
};

export const CATEGORY_STATUS: Record<string, string> = {
  open: 'Abierta',
  empty: 'Vacía',
  merged: 'Fusionada',
  ready: 'Lista',
  in_progress: 'En curso',
  finished: 'Finalizada',
  cancelled: 'Cancelada',
};

export const MATCH_STATUS: Record<string, string> = {
  pending: 'Pendiente',
  ready: 'Listo',
  in_progress: 'En curso',
  finished: 'Finalizado',
  bye: 'Bye',
  void: 'Anulado',
  needs_review: 'Revisar',
};

export const REGISTRATION_STATUS: Record<string, string> = {
  active: 'Activa',
  withdrawn: 'Retirada',
};

export const IMPORT_ROW_STATUS: Record<string, string> = {
  new: 'Nueva',
  duplicate: 'Posible duplicado',
  error: 'Con error',
};

export const IMPORT_BATCH_STATUS: Record<string, string> = {
  preview: 'Vista previa',
  confirmed: 'Confirmada',
  cancelled: 'Cancelada',
};

export const DUPLICATE_REASON: Record<string, string> = {
  document: 'Mismo documento',
  name_birth: 'Mismo nombre y fecha',
  similar_name_birth: 'Nombre parecido y misma fecha',
  name_only: 'Mismo nombre',
  same_file: 'Repetido en el archivo',
};

/** "1 posible duplicado", "2 posibles duplicados" (la función vive en shared/plural). */
export { plural } from '../shared/plural';

export const FORMAT_LABEL: Record<string, string> = {
  single_elimination: 'Eliminación directa',
  round_robin: 'Round robin',
  kata_rounds: 'Rondas de kata',
  groups_knockout: 'Grupos + eliminación',
};

export const THIRD_PLACE_LABEL: Record<string, string> = {
  two_bronzes: 'Dos bronces',
  third_place_match: 'Combate por el 3.º',
  repechage: 'Repechaje',
};

export const METHOD_LABEL: Record<string, string> = {
  points: 'Puntos',
  point_gap: 'Diferencia de 8',
  senshu: 'Senshu',
  hantei: 'Hantei (jueces)',
  golden_point: 'Punto de oro',
  hansoku: 'Hansoku',
  kiken: 'Kiken (abandono)',
  shikkaku: 'Shikkaku (descalificación)',
  walkover: 'Walkover',
  decision: 'Decisión',
  flags: 'Banderas',
  bye: 'Bye',
  draw: 'Hikiwake (empate)',
  victories: 'Victorias',
  extra_bout: 'Combate extra',
  scores: 'Puntuación',
  incomplete_team: 'Alineación incompleta',
  not_disputed: 'No disputado',
};

/** Criterios de desempate de round robin (competition_rules.round_robin_criteria). */
export const RR_CRITERIA_LABEL: Record<string, string> = {
  wins: 'Victorias',
  head_to_head: 'Enfrentamiento directo',
  diff: 'Diferencia de puntos',
  points_for: 'Puntos a favor',
  fewer_sanctions: 'Menos sanciones',
  draw: 'Sorteo',
};

export const ROLE_LABEL: Record<string, string> = {
  organizer: 'Organizador',
  table_operator: 'Operador de mesa',
  dojo_admin: 'Admin de dojo',
  referee: 'Árbitro',
  sensei: 'Sensei',
};

export const SCOPE_LABEL: Record<string, string> = { tournament: 'torneo', dojo: 'dojo', tatami: 'tatami' };

export const EVENT_LABEL: Record<string, string> = {
  point: 'Punto',
  sanction: 'Sanción',
  start: 'Hajime (inicio)',
  pause: 'Yame (pausa)',
  resume: 'Hajime (reanuda)',
  time_adjust: 'Ajuste de tiempo',
  annul: 'Anulación',
  senshu_cancel: 'Senshu cancelado',
  hantei: 'Hantei',
  kiken: 'Kiken',
  shikkaku: 'Shikkaku',
  walkover: 'Walkover',
  finish: 'Fin del combate',
};

export const POINT_LABEL: Record<number, string> = { 1: 'Yuko', 2: 'Waza-ari', 3: 'Ippon' };

export const MODALITY_LABEL: Record<string, string> = { kumite: 'Kumite', kata: 'Kata' };
export const SEX_LABEL: Record<string, string> = { M: 'Masculino', F: 'Femenino', X: 'Mixto' };

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
      return 'warn';
    case 'cancelled':
    case 'error':
    case 'withdrawn':
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

export const ADVICE_LABEL: Record<string, string> = {
  empty: 'Sin inscritos',
  merge: 'Fusionar con otra',
  cancel: 'Cancelar',
  keep: 'Mantener',
  direct_final: 'Final directa',
  round_robin: 'Round robin',
  split: 'Dividir (supera el cupo)',
};

/** Ícono de medalla por puesto (1-3); '' si no hay medalla. */
export const MEDAL_ICON: Record<number, string> = { 1: '🥇', 2: '🥈', 3: '🥉' };

/** "🥇 Oro", "🥈 Plata", "🥉 Bronce", "5.º puesto" o "Sin puesto". */
export function placeLabel(place: number | null | undefined): string {
  if (!place) return 'Sin puesto';
  const name: Record<number, string> = { 1: 'Oro', 2: 'Plata', 3: 'Bronce' };
  return name[place] ? `${MEDAL_ICON[place]} ${name[place]}` : `${place}.º puesto`;
}

/** Marcador "propio – rival"; guion si el combate no tiene puntaje (p. ej. kiken). */
export function scoreText(score: [number | null, number | null] | null | undefined): string {
  if (!score || (score[0] === null && score[1] === null)) return '—';
  return `${score[0] ?? 0} – ${score[1] ?? 0}`;
}

/** Etiqueta en español de un método de victoria; el código tal cual si no se conoce. */
export function methodText(method: string | null | undefined): string {
  if (!method) return '—';
  return METHOD_LABEL[method] ?? method;
}

/** Marcador de un combate; una decisión por banderas (kata) no tiene marcador. */
export function matchScoreText(
  score: [number | null, number | null] | null | undefined,
  method: string | null | undefined,
): string {
  return method === 'flags' ? 'Banderas' : scoreText(score);
}

export const AUDIT_ACTION: Record<string, string> = {
  create: 'Creación',
  update: 'Edición',
  status: 'Cambio de estado',
  reopen: 'Reapertura',
  finish: 'Cierre de combate',
  refinish: 'Cierre tras reapertura',
  correct_winner: 'Corrección de ganador',
  correct_score: 'Corrección de marcador',
  official_result: 'Resultado oficial',
  merge: 'Fusión',
  unmerge: 'Fusión deshecha',
  revert_merge: 'Fusión revertida',
  withdraw: 'Retiro',
  generate: 'Generación de llave',
  swap: 'Intercambio en llave',
  generate_categories: 'Categorías desde plantilla',
  preview: 'Vista previa de importación',
  confirm: 'Importación confirmada',
  cancel: 'Cancelación',
  add_role: 'Rol asignado',
  remove_role: 'Rol quitado',
  change_password: 'Cambio de contraseña',
  anonymize: 'Anonimización',
  score: 'Notas de kata',
  correct_scores: 'Corrección de notas de kata',
  kata_tie_break: 'Desempate de kata',
  add_tatami: 'Tatami agregado',
  add_grade: 'Grado registrado',
  change_dojo: 'Cambio de dojo',
  add_consent: 'Consentimiento registrado',
  add_branch: 'Sede agregada',
  create_despite_duplicates: 'Creación pese a posibles duplicados',
  lineup: 'Alineación del enfrentamiento',
  lineup_extra: 'Combate extra agregado',
  undecide: 'Enfrentamiento sin decidir (corrección)',
  take_table: 'Tablet tomó la mesa',
  walkover: 'Walkover por retiro',
  queue: 'Cola del tatami',
  edit_row: 'Fila de importación corregida',
};

export const AUDIT_ENTITY: Record<string, string> = {
  match: 'Combate',
  category: 'Categoría',
  tournament: 'Torneo',
  registration: 'Inscripción',
  person: 'Persona',
  bracket: 'Llave',
  dojo: 'Dojo',
  import: 'Importación',
  user: 'Usuario',
  kata_performance: 'Ejecución de kata',
  template: 'Plantilla',
  team: 'Equipo',
  referee_assignment: 'Asignación de árbitro',
  tatami: 'Tatami',
};
