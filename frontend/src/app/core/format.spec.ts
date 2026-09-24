import { describe, expect, it } from 'vitest';
import { fmtDate, fmtDateTime, mmss, newId, parseUtc, placeLabel, scoreText } from './format';

describe('format', () => {
  it('interpreta fechas sin zona como UTC y las muestra en hora de Lima', () => {
    expect(parseUtc('2026-09-24T18:51:04')?.toISOString()).toBe('2026-09-24T18:51:04.000Z');
    expect(fmtDateTime('2026-09-24T18:51:04')).toContain('13:51:04');
  });

  it('no desplaza las fechas de calendario', () => {
    expect(fmtDate('2026-10-17')).toContain('17');
  });

  it('formatea el cronómetro', () => {
    expect(mmss(0)).toBe('0:00');
    expect(mmss(95)).toBe('1:35');
  });

  it('genera UUIDs', () => {
    expect(newId()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('etiqueta puestos y marcadores del historial', () => {
    expect(placeLabel(1)).toBe('🥇 Oro');
    expect(placeLabel(3)).toBe('🥉 Bronce');
    expect(placeLabel(5)).toBe('5.º puesto');
    expect(placeLabel(null)).toBe('Sin puesto');
    expect(scoreText([3, 1])).toBe('3 – 1');
    expect(scoreText([null, null])).toBe('—');
  });
});
