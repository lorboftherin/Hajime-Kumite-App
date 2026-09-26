import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bracketRounds,
  entryText,
  fightText,
  fold,
  hourText,
  loadFavorites,
  matchesQuery,
  saveFavorites,
  searchCompetitors,
  toggleFavorite,
  zoneOfIso,
} from './public-logic';
import { NextFight, PublicBracketMatch, PublicCompetitor } from './public-models';

const next = (over: Partial<NextFight> = {}): NextFight => ({
  tatami: 2,
  tatami_name: 'Tatami 2',
  number: 'T2-014',
  code: 'R1-3',
  status: 'ready',
  ahead: 3,
  eta: '2026-10-17T11:40:00-05:00',
  ...over,
});

const comp = (name: string, dojo: string): PublicCompetitor => ({
  key: name,
  name,
  dojo,
  team: false,
  entries: [],
});

describe('portal público: buscador', () => {
  it('ignora tildes y mayúsculas', () => {
    expect(fold('  Huamán ÑUÑO ')).toBe('huaman nuno');
    expect(matchesQuery('Mateo H. Dojo Kaze', 'kaze mateo')).toBe(true);
    expect(matchesQuery('Mateo H. Dojo Kaze', 'mizu')).toBe(false);
  });

  it('busca por nombre o dojo desde 2 letras', () => {
    const list = [
      comp('Diego R.', 'Dojo Kaze'),
      comp('Mateo H.', 'Dojo Mizu'),
      comp('Iker S.', 'Dojo Kaze'),
    ];
    expect(searchCompetitors(list, 'd')).toEqual([]);
    expect(searchCompetitors(list, 'kaze').map((c) => c.name)).toEqual(['Diego R.', 'Iker S.']);
    expect(searchCompetitors(list, 'mateo').map((c) => c.name)).toEqual(['Mateo H.']);
  });
});

describe('portal público: ¿cuándo pelea?', () => {
  it('arma la tarjeta con tatami, combate, faltantes y hora', () => {
    expect(fightText(next(), 'America/Lima')).toBe(
      'Pelea en Tatami 2, combate T2-014, faltan 3 combates (≈ 11:40)',
    );
    expect(fightText(next({ ahead: 1, eta: null }))).toBe(
      'Pelea en Tatami 2, combate T2-014, falta 1 combate',
    );
    expect(fightText(next({ ahead: 0, status: 'pending', eta: null }))).toBe(
      'Es el siguiente en Tatami 2, combate T2-014, rival por definir',
    );
    expect(fightText(next({ status: 'in_progress', ahead: 0 }))).toBe(
      'Peleando ahora en Tatami 2, combate T2-014',
    );
  });

  it('muestra el puesto al terminar', () => {
    const base = { category_id: 1, category: 'Kumite', next: null };
    expect(entryText({ ...base, state: 'placed', place: 1 })).toBe('Oro (1.º puesto)');
    expect(entryText({ ...base, state: 'waiting', place: null })).toBe(
      'Sin combate programado por ahora',
    );
  });

  it('la hora se ve en la zona del torneo', () => {
    expect(hourText('2026-10-17T16:40:00Z', 'America/Lima')).toBe('11:40');
    expect(zoneOfIso('2026-10-17T11:40:00-05:00')).toBe('Etc/GMT+5');
    expect(hourText('2026-10-17T11:40:00-05:00', zoneOfIso('2026-10-17T11:40:00-05:00'))).toBe(
      '11:40',
    );
    expect(hourText(null)).toBe('');
  });
});

describe('portal público: favoritos', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('se guardan por torneo en el dispositivo', () => {
    const keys = toggleFavorite(new Set(), 'abc');
    saveFavorites('copa-2026', keys);
    expect([...loadFavorites('copa-2026')]).toEqual(['abc']);
    expect(loadFavorites('otra').size).toBe(0);
    expect([...toggleFavorite(keys, 'abc')]).toEqual([]);
  });

  it('sin almacenamiento no rompe la página', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('bloqueado');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('bloqueado');
    });
    expect(loadFavorites('x').size).toBe(0);
    expect(() => saveFavorites('x', new Set(['a']))).not.toThrow();
  });
});

describe('portal público: llave', () => {
  it('agrupa por ronda con su nombre', () => {
    const m = (round: number, position: number, kind = 'main'): PublicBracketMatch => ({
      code: `R${round}-${position}`,
      kind,
      round,
      position,
      status: 'ready',
      aka: null,
      ao: null,
      score: [0, 0],
      winner: null,
      method: null,
    });
    const rounds = bracketRounds([
      m(3, 1),
      m(1, 2),
      m(1, 1),
      m(2, 1),
      m(2, 2),
      m(1, 3),
      m(1, 4),
      m(2, 1, 'third_place'),
    ]);
    expect(rounds.map((r) => r.label)).toEqual(['Cuartos de final', 'Semifinal', 'Final']);
    expect(rounds[0].matches.map((x) => x.position)).toEqual([1, 2, 3, 4]);
  });
});
