// Lógica pura del ranking (sin Angular).
import { RankingPoints, RankingSeason } from '../../core/models';

export interface SeasonForm {
  name: string;
  year: number;
  date_from: string;
  date_to: string;
  /** Torneos marcados; vacío = todos los que no son de prueba del rango de fechas. */
  tournament_ids: number[];
  points: RankingPoints;
  /** Multiplicador por torneo como texto editable («2», «1,5»). */
  multipliers: Record<number, string>;
  min_entrants_walkover_gold: number;
  is_public: boolean;
}

export function emptySeasonForm(year: number): SeasonForm {
  return {
    name: '',
    year,
    date_from: '',
    date_to: '',
    tournament_ids: [],
    points: { gold: 10, silver: 7, bronze: 5, participation: 1 },
    multipliers: {},
    min_entrants_walkover_gold: 2,
    is_public: false,
  };
}

export function seasonToForm(s: RankingSeason): SeasonForm {
  const mult: Record<number, string> = {};
  for (const [k, v] of Object.entries(s.multipliers ?? {})) mult[Number(k)] = String(v);
  return {
    name: s.name,
    year: s.year,
    date_from: s.date_from ?? '',
    date_to: s.date_to ?? '',
    tournament_ids: [...(s.tournament_ids ?? [])],
    points: { ...s.points },
    multipliers: mult,
    min_entrants_walkover_gold: s.min_entrants_walkover_gold,
    is_public: s.is_public,
  };
}

/** Cuerpo para POST/PATCH: multiplicadores válidos distintos de 1, fechas vacías = null. */
export function seasonPayload(f: SeasonForm): Record<string, unknown> {
  const multipliers: Record<string, number> = {};
  for (const [k, v] of Object.entries(f.multipliers)) {
    const n = Number(String(v).replace(',', '.'));
    if (Number.isFinite(n) && n > 0 && n !== 1) multipliers[k] = n;
  }
  return {
    name: f.name.trim(),
    year: Number(f.year),
    date_from: f.date_from || null,
    date_to: f.date_to || null,
    tournament_ids: [...f.tournament_ids].sort((a, b) => a - b),
    points: f.points,
    multipliers,
    min_entrants_walkover_gold: Number(f.min_entrants_walkover_gold),
    is_public: f.is_public,
  };
}

export function toggleId(ids: number[], id: number): number[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

/** «2 oros, 1 plata» para lectores de pantalla y tooltips. */
export function medalsText(g: number, s: number, b: number): string {
  const parts: string[] = [];
  if (g) parts.push(`${g} ${g === 1 ? 'oro' : 'oros'}`);
  if (s) parts.push(`${s} ${s === 1 ? 'plata' : 'platas'}`);
  if (b) parts.push(`${b} ${b === 1 ? 'bronce' : 'bronces'}`);
  return parts.join(', ') || 'sin medallas';
}
