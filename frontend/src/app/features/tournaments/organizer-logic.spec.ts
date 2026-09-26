import { describe, expect, it } from 'vitest';
import { joinList, plural, pluralWord } from '../../shared/plural';
import {
  appendUnique,
  auditChanges,
  auditValue,
  estimateMatches,
  moveItem,
  registrationSummary,
} from './organizer-logic';

describe('plural', () => {
  it('elige singular o plural según el número (0 va en plural)', () => {
    expect(plural(1, 'inscripción', 'inscripciones')).toBe('1 inscripción');
    expect(plural(3, 'inscripción', 'inscripciones')).toBe('3 inscripciones');
    expect(plural(0, 'categoría', 'categorías')).toBe('0 categorías');
    expect(pluralWord(1, 'evento', 'eventos')).toBe('evento');
  });

  it('une listas en español', () => {
    expect(joinList([])).toBe('');
    expect(joinList(['Kata'])).toBe('Kata');
    expect(joinList(['A', 'B'])).toBe('A y B');
    expect(joinList(['A', 'B', 'C'])).toBe('A, B y C');
  });
});

describe('registrationSummary', () => {
  it('resume en una línea lo inscrito y lo que falló', () => {
    expect(
      registrationSummary(['Kumite -45', 'Kata infantil'], [{ name: 'Kata 12–13 años', reason: 'ya inscrito' }]),
    ).toBe('Inscrito en Kumite -45 y Kata infantil; falló Kata 12–13 años: ya inscrito');
    expect(registrationSummary(['Kumite -45'], [])).toBe('Inscrito en Kumite -45');
    expect(registrationSummary([], [{ name: 'Kata', reason: 'cerrada' }])).toBe(
      'No se pudo inscribir en Kata: cerrada',
    );
  });
});

describe('cola del tatami', () => {
  it('sube y baja categorías sin salirse de la lista', () => {
    expect(moveItem([1, 2, 3], 2, -1)).toEqual([1, 3, 2]);
    expect(moveItem([1, 2, 3], 0, 1)).toEqual([2, 1, 3]);
    const same = [1, 2, 3];
    expect(moveItem(same, 0, -1)).toBe(same);
    expect(moveItem(same, 2, 1)).toBe(same);
  });

  it('agrega al final sin duplicar', () => {
    expect(appendUnique([4, 1], [2, 4, 3, 2])).toEqual([4, 1, 2, 3]);
  });

  it('estima los combates por formato', () => {
    expect(estimateMatches(8, 'single_elimination', 'two_bronzes')).toBe(7);
    expect(estimateMatches(8, 'single_elimination', 'third_place_match')).toBe(8);
    expect(estimateMatches(8, null, 'repechage')).toBe(9);
    expect(estimateMatches(5, 'round_robin')).toBe(10);
    expect(estimateMatches(6, 'kata_rounds')).toBe(6);
    expect(estimateMatches(1, 'single_elimination')).toBe(0);
    expect(estimateMatches(3, null, 'third_place_match')).toBe(2);
  });
});

describe('auditoría legible', () => {
  it('lista solo los campos que cambiaron', () => {
    expect(auditChanges({ name: 'A', seed: 1, x: [1] }, { name: 'B', seed: 1, x: [1] })).toEqual([
      { field: 'name', before: 'A', after: 'B' },
    ]);
    expect(auditChanges(null, { status: 'finished' })).toEqual([
      { field: 'status', before: undefined, after: 'finished' },
    ]);
  });

  it('muestra valores comprensibles', () => {
    expect(auditValue(null)).toBe('—');
    expect(auditValue(true)).toBe('sí');
    expect(auditValue([1, 2])).toBe('1, 2');
    expect(auditValue({ aka: 3, ao: 1 })).toBe('aka: 3 · ao: 1');
  });
});
