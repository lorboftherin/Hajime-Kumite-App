// Lógica pura de las pantallas del organizador (sin Angular): se prueba de forma aislada.
import { joinList } from '../../shared/plural';

/**
 * Resumen de una inscripción en varias categorías, en una sola línea:
 * «Inscrito en Kumite -45 y Kata infantil; falló Kata 12–13 años: motivo».
 */
export function registrationSummary(
  ok: string[],
  failed: Array<{ name: string; reason: string }>,
): string {
  const parts: string[] = [];
  if (ok.length) parts.push($localize`:@@torneo.inscrito:Inscrito en ${joinList(ok)}:categorias:`);
  if (failed.length) {
    const f = failed.map((x) => `${x.name}: ${x.reason}`).join('; ');
    parts.push(
      ok.length
        ? $localize`:@@torneo.fallo-en:falló ${f}:fallidas:`
        : $localize`:@@torneo.no-pudo-inscribir-en:No se pudo inscribir en ${f}:fallidas:`,
    );
  }
  return parts.join('; ');
}

/**
 * Combates estimados de una categoría (para planificar la cola del tatami):
 * eliminación directa n−1 (+1 si hay combate por el 3.º; +2 aprox. con repechaje),
 * round robin n·(n−1)/2 y rondas de kata una ejecución por competidor.
 */
export function estimateMatches(
  entrants: number,
  format: string | null | undefined,
  thirdPlace?: string | null,
): number {
  const n = Math.max(0, Math.floor(entrants));
  if (n < 2) return 0;
  if (format === 'round_robin') return (n * (n - 1)) / 2;
  if (format === 'kata_rounds') return n;
  let total = n - 1;
  if (n >= 4 && thirdPlace === 'third_place_match') total += 1;
  if (n >= 4 && thirdPlace === 'repechage') total += 2;
  return total;
}

/** Mueve el elemento `i` una posición (−1 arriba, +1 abajo). Devuelve una lista nueva. */
export function moveItem<T>(list: T[], i: number, delta: -1 | 1): T[] {
  const j = i + delta;
  if (i < 0 || i >= list.length || j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** Agrega al final de la cola los que no estaban (sin duplicar). */
export function appendUnique<T>(list: T[], add: T[]): T[] {
  const have = new Set(list);
  return [...list, ...add.filter((x) => !have.has(x) && (have.add(x), true))];
}

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

/**
 * Diferencias campo a campo de una entrada de auditoría. El servidor ya guarda solo
 * los campos que cambiaron; si una foto trae campos extra, los iguales se omiten.
 */
export function auditChanges(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): FieldChange[] {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
  return keys
    .map((field) => ({ field, before: before?.[field], after: after?.[field] }))
    .filter((c) => JSON.stringify(c.before) !== JSON.stringify(c.after));
}

/** Valor legible para la auditoría: vacío como «—», sí/no, listas y objetos compactos. */
export function auditValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? $localize`:@@torneo.si:sí` : $localize`:@@torneo.no:no`;
  if (Array.isArray(v)) return v.length ? v.map((x) => auditValue(x)).join(', ') : '—';
  if (typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${k}: ${auditValue(x)}`)
      .join(' · ');
  }
  return String(v);
}
