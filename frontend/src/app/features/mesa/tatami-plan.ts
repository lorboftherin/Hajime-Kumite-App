/**
 * Lógica pura para resolver imprevistos desde la mesa: repartir categorías
 * entre tatamis con reglas rápidas, ordenar por código (A1, B1, A2, B2…) y
 * sugerir la categoría de quien llega tarde. Sin dependencias de Angular.
 */

export interface PlanCategory {
  id: number;
  code: string;
  name: string;
  sex: string; // M | F | X
  modality: string; // kata | kumite
  age_min: number | null;
  age_max: number | null;
  grade_min?: number | null;
  grade_max?: number | null;
  status: string;
  tatami_id: number | null;
  queue_position: number | null;
  is_team?: boolean;
}

/** Regla de reparto: la primera que calza decide el tatami. */
export interface PlanRule {
  sex: '' | 'M' | 'F';
  ageFrom: number | null;
  ageTo: number | null;
  modality: '' | 'kata' | 'kumite';
  tatamiId: number | null;
}

/** Clave de la columna «sin tatami». */
export const NO_TATAMI = 0;

const CODE_RE = /^\s*([A-Za-z]+)\s*(\d+)\s*$/;

/** Orden natural por código, igual que el servidor: número, luego letra (A1, B1, A2…). */
export function codeKey(
  c: Pick<PlanCategory, 'code' | 'queue_position' | 'id'>,
): Array<number | string> {
  const m = CODE_RE.exec(c.code ?? '');
  if (m) return [0, Number(m[2]), m[1].toUpperCase(), 0, c.id];
  return [1, 0, '', c.queue_position ?? 1e6, c.id];
}

export function compareKeys(a: Array<number | string>, b: Array<number | string>): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

export function sortByCode<T extends Pick<PlanCategory, 'code' | 'queue_position' | 'id'>>(
  cats: T[],
): T[] {
  return [...cats].sort((x, y) => compareKeys(codeKey(x), codeKey(y)));
}

/** ¿La categoría calza con la regla? Edad: la categoría entera dentro del rango. */
export function matchesRule(c: PlanCategory, r: PlanRule): boolean {
  if (r.sex && c.sex !== r.sex) return false;
  if (r.modality && c.modality !== r.modality) return false;
  const lo = c.age_min ?? c.age_max;
  const hi = c.age_max ?? c.age_min;
  if (r.ageFrom !== null && (lo === null || lo < r.ageFrom)) return false;
  if (r.ageTo !== null && (hi === null || hi > r.ageTo)) return false;
  return true;
}

/**
 * Aplica las reglas en orden (la primera que calza manda) y devuelve el
 * reparto: tatami → ids de categorías ordenados por código. Las categorías
 * que no calzan con ninguna regla se quedan donde estaban.
 */
export function applyRules(
  cats: PlanCategory[],
  rules: PlanRule[],
  tatamiIds: number[],
): Record<number, number[]> {
  const out: Record<number, PlanCategory[]> = { [NO_TATAMI]: [] };
  for (const t of tatamiIds) out[t] = [];
  for (const c of cats) {
    const rule = rules.find((r) => r.tatamiId !== null && matchesRule(c, r));
    const dest = rule ? (rule.tatamiId as number) : (c.tatami_id ?? NO_TATAMI);
    (out[dest] ?? out[NO_TATAMI]).push(c);
  }
  const ids: Record<number, number[]> = {};
  for (const [k, list] of Object.entries(out)) ids[Number(k)] = sortByCode(list).map((c) => c.id);
  return ids;
}

/** Reparto actual tal como está guardado (cada tatami en el orden de su cola). */
export function currentPlan(cats: PlanCategory[], tatamiIds: number[]): Record<number, number[]> {
  const out: Record<number, PlanCategory[]> = { [NO_TATAMI]: [] };
  for (const t of tatamiIds) out[t] = [];
  for (const c of cats) (out[c.tatami_id ?? NO_TATAMI] ?? out[NO_TATAMI]).push(c);
  const ids: Record<number, number[]> = {};
  for (const [k, list] of Object.entries(out)) {
    const sorted = Number(k) === NO_TATAMI ? sortByCode(list) : [...list].sort(byQueue);
    ids[Number(k)] = sorted.map((c) => c.id);
  }
  return ids;
}

function byQueue(a: PlanCategory, b: PlanCategory): number {
  return (a.queue_position ?? 1e6) - (b.queue_position ?? 1e6) || a.id - b.id;
}

/** Mueve un id una posición arriba (-1) o abajo (+1) dentro de su lista. */
export function moveWithin(list: number[], id: number, delta: -1 | 1): number[] {
  const i = list.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** Pasa una categoría a otro tatami; entra en su lugar según el código. */
export function moveTo(
  plan: Record<number, number[]>,
  id: number,
  dest: number,
  byId: Map<number, PlanCategory>,
): Record<number, number[]> {
  const out: Record<number, number[]> = {};
  for (const [k, list] of Object.entries(plan)) out[Number(k)] = list.filter((x) => x !== id);
  const target = [...(out[dest] ?? []), id];
  const cats = target.map((x) => byId.get(x)).filter((x): x is PlanCategory => !!x);
  // La que llega se ubica por código sin reordenar lo que la mesa ya ordenó a mano.
  const moved = byId.get(id);
  const rest = cats.filter((c) => c.id !== id);
  let pos = rest.length;
  if (moved) {
    const k = codeKey(moved);
    const idx = rest.findIndex((c) => compareKeys(codeKey(c), k) > 0);
    if (idx >= 0) pos = idx;
  }
  rest.splice(pos, 0, ...(moved ? [moved] : []));
  out[dest] = rest.map((c) => c.id);
  return out;
}

// --- Inscripción tardía ---

/** «8 kyu» → 3; «1 dan» → 11; vacío → null (mismo ordinal que el servidor). */
export function gradeOrdinal(grade: string | null | undefined): number | null {
  const m = /^\s*(\d{1,2})\s*(kyu|dan)\s*$/i.exec(grade ?? '');
  if (!m) return null;
  const n = Number(m[1]);
  return m[2].toLowerCase() === 'kyu' ? 11 - n : 10 + n;
}

/** Categorías que calzan con sexo, edad y grado (como la sugerencia del servidor). */
export function suggestFor(
  cats: PlanCategory[],
  sex: string,
  age: number | null,
  grade: string | null,
): PlanCategory[] {
  const g = gradeOrdinal(grade);
  return cats.filter((c) => {
    if (c.is_team || ['merged', 'cancelled', 'finished'].includes(c.status)) return false;
    if (c.sex !== 'X' && c.sex !== sex) return false;
    if (age !== null) {
      if (c.age_min !== null && age < c.age_min) return false;
      if (c.age_max !== null && age > c.age_max) return false;
    }
    if (g !== null) {
      if (c.grade_min != null && g < c.grade_min) return false;
      if (c.grade_max != null && g > c.grade_max) return false;
    }
    return true;
  });
}
