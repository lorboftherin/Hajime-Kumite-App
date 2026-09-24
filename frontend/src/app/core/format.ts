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

export const FORMAT_LABEL: Record<string, string> = {
  single_elimination: 'Eliminación directa',
  round_robin: 'Round robin',
  kata_rounds: 'Rondas de kata',
};

export const THIRD_PLACE_LABEL: Record<string, string> = {
  two_bronzes: 'Dos bronces',
  third_place_match: 'Combate por el 3.º',
  repechage: 'Repechaje',
};

export const METHOD_LABEL: Record<string, string> = {
  points: 'Puntos',
  point_gap: 'Diferencia de puntos',
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
};

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
};
