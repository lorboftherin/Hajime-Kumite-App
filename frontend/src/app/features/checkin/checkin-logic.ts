// Lógica pura de la mesa de acreditación (sin Angular): se prueba de forma aislada.
import { CheckinRow, CheckinStatus, WeighInResult } from '../../core/models';

/** Una tarjeta por persona (o por equipo): la mesa acredita a la persona, no a cada inscripción. */
export interface CheckinCard {
  key: string;
  person_id: number | null;
  name: string;
  dojo_id: number;
  dojo_name: string;
  code: string | null;
  rows: CheckinRow[];
  status: CheckinStatus;
  needsWeighIn: boolean;
  weight: number | null;
  /** Peor resultado de pesaje de sus inscripciones de kumite (over/under manda sobre ok). */
  weighResult: WeighInResult | null;
  /** Hay un fuera de peso sin mover ni aceptar. */
  unresolved: boolean;
}

export type CheckinView = 'all' | 'pending' | 'present' | 'absent' | 'out_of_weight';

/** Minúsculas y sin tildes, para buscar «Pérez» escribiendo «perez». */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function cardStatus(rows: CheckinRow[]): CheckinStatus {
  if (rows.every((r) => r.checkin_status === 'present')) return 'present';
  if (rows.every((r) => r.checkin_status === 'absent')) return 'absent';
  return 'pending';
}

export function groupByPerson(rows: CheckinRow[]): CheckinCard[] {
  const map = new Map<string, CheckinCard>();
  for (const r of rows) {
    const key = r.person_id ? `p${r.person_id}` : `r${r.registration_id}`;
    let c = map.get(key);
    if (!c) {
      c = {
        key,
        person_id: r.person_id,
        name: r.name,
        dojo_id: r.dojo_id,
        dojo_name: r.dojo_name,
        code: r.code,
        rows: [],
        status: 'pending',
        needsWeighIn: false,
        weight: null,
        weighResult: null,
        unresolved: false,
      };
      map.set(key, c);
    }
    c.rows.push(r);
  }
  const cards = [...map.values()];
  for (const c of cards) {
    c.rows.sort((a, b) => a.registration_id - b.registration_id);
    c.code = c.rows[0].code;
    c.status = cardStatus(c.rows);
    const weighed = c.rows.filter((r) => r.needs_weigh_in);
    c.needsWeighIn = weighed.length > 0;
    c.weight = weighed.find((r) => r.weight_kg !== null)?.weight_kg ?? null;
    const bad = weighed.find((r) => r.weigh_in_result === 'over' || r.weigh_in_result === 'under');
    c.weighResult =
      bad?.weigh_in_result ?? weighed.find((r) => r.weigh_in_result)?.weigh_in_result ?? null;
    c.unresolved = weighed.some(
      (r) =>
        (r.weigh_in_result === 'over' || r.weigh_in_result === 'under') && !r.weigh_in_resolved,
    );
  }
  return cards.sort((a, b) => fold(a.name).localeCompare(fold(b.name)));
}

export function filterCards(
  cards: CheckinCard[],
  q: string,
  dojoId: number,
  view: CheckinView,
): CheckinCard[] {
  const needle = fold(q);
  const code = normalizeCode(q);
  return cards.filter((c) => {
    if (dojoId && c.dojo_id !== dojoId) return false;
    if (view === 'out_of_weight') {
      if (!c.rows.some((r) => r.weigh_in_result === 'over' || r.weigh_in_result === 'under'))
        return false;
    } else if (view !== 'all' && c.status !== view) {
      return false;
    }
    if (!needle) return true;
    if (code && c.rows.some((r) => r.code === code)) return true;
    return fold(`${c.name} ${c.dojo_name}`).includes(needle);
  });
}

/** Peso tipeado en la tablet: acepta coma decimal. null si no es un peso razonable. */
export function parseWeight(text: string | number | null | undefined): number | null {
  if (text === null || text === undefined) return null;
  const n = typeof text === 'number' ? text : Number(String(text).trim().replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0 || n >= 300) return null;
  return Math.round(n * 100) / 100;
}

const CODE_ALPHABET = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;

/** Código de credencial tal como lo guarda el servidor (el lector puede traer prefijos o minúsculas). */
export function normalizeCode(text: string): string {
  let t = (text || '').trim().toUpperCase();
  if (t.includes(':')) t = t.slice(t.lastIndexOf(':') + 1);
  return t.replace(/[^0-9A-Z]/g, '');
}

/** ¿Lo tipeado (o leído) parece un código de credencial y no un nombre? */
export function looksLikeCode(text: string): boolean {
  const raw = (text || '').trim();
  if (!raw || /\s/.test(raw.replace(/^[^:]*:/, ''))) return false;
  return CODE_ALPHABET.test(normalizeCode(raw));
}

/** «hasta 45 kg», «45–50 kg», «más de 68 kg». */
export function rangeText(min: number | null, max: number | null): string {
  if (min !== null && max !== null) return $localize`:@@acreditacion.kg:${min}:min:–${max}:max: kg`;
  if (max !== null) return $localize`:@@acreditacion.hasta-kg:hasta ${max}:max: kg`;
  if (min !== null) return $localize`:@@acreditacion.mas-kg:más de ${min}:min: kg`;
  return '';
}
