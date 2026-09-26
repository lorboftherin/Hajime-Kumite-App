import { describe, expect, it } from 'vitest';
import { RankingSeason } from '../../core/models';
import {
  emptySeasonForm,
  medalsText,
  seasonPayload,
  seasonToForm,
  toggleId,
} from './ranking-logic';

describe('ranking', () => {
  it('arma el cuerpo de la temporada', () => {
    const f = {
      ...emptySeasonForm(2026),
      name: ' Liga Lima ',
      tournament_ids: [5, 2],
      multipliers: { 5: '2', 2: '1', 9: 'x', 7: '1,5' },
    };
    expect(seasonPayload(f)).toEqual({
      name: 'Liga Lima',
      year: 2026,
      date_from: null,
      date_to: null,
      tournament_ids: [2, 5],
      points: { gold: 10, silver: 7, bronze: 5, participation: 1 },
      multipliers: { 5: 2, 7: 1.5 },
      min_entrants_walkover_gold: 2,
      is_public: false,
    });
  });

  it('carga una temporada existente en el formulario', () => {
    const s: RankingSeason = {
      id: 1,
      name: 'Liga',
      slug: 'liga-2026',
      year: 2026,
      date_from: '2026-03-01',
      date_to: null,
      tournament_ids: [],
      points: { gold: 12, silver: 8, bronze: 6, participation: 2 },
      multipliers: { '3': 2 },
      min_entrants_walkover_gold: 3,
      is_public: true,
      computed_at: null,
      version: 4,
    };
    const f = seasonToForm(s);
    expect(f.multipliers).toEqual({ 3: '2' });
    expect(seasonPayload(f)['date_from']).toBe('2026-03-01');
    expect(seasonPayload(f)['multipliers']).toEqual({ 3: 2 });
  });

  it('marca y desmarca torneos', () => {
    expect(toggleId([1, 2], 2)).toEqual([1]);
    expect(toggleId([1], 3)).toEqual([1, 3]);
  });

  it('describe medallas', () => {
    expect(medalsText(2, 1, 0)).toBe('2 oros, 1 plata');
    expect(medalsText(0, 0, 0)).toBe('sin medallas');
  });
});
