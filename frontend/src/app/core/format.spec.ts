import { describe, expect, it } from 'vitest';
import {
  fmtDate,
  fmtDateTime,
  limaInputToIso,
  matchScoreText,
  methodText,
  mmss,
  newId,
  parseUtc,
  placeLabel,
  plural,
  scoreText,
  utcToLimaInput,
} from './format';

describe('format', () => {
  it('convierte la fecha de cierre entre UTC (API) y la hora de Lima (formulario)', () => {
    expect(utcToLimaInput('2026-10-01T23:30:00')).toBe('2026-10-01T18:30');
    expect(utcToLimaInput(null)).toBe('');
    expect(limaInputToIso('2026-10-01T18:30')).toBe('2026-10-01T18:30:00-05:00');
    expect(limaInputToIso('')).toBeNull();
  });

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

  it('traduce métodos y no muestra marcador en decisiones por banderas', () => {
    expect(methodText('points')).toBe('Puntos');
    expect(methodText('flags')).toBe('Banderas');
    expect(methodText('otro')).toBe('otro');
    expect(matchScoreText([0, 0], 'flags')).toBe('Banderas');
    expect(matchScoreText([4, 1], 'points')).toBe('4 – 1');
  });

  it('concuerda singular y plural', () => {
    expect(plural(1, 'posible duplicado', 'posibles duplicados')).toBe('1 posible duplicado');
    expect(plural(2, 'posible duplicado', 'posibles duplicados')).toBe('2 posibles duplicados');
  });
});
