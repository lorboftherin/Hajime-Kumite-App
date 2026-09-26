import { describe, expect, it } from 'vitest';
import { CheckinRow } from '../../core/models';
import {
  filterCards,
  fold,
  groupByPerson,
  looksLikeCode,
  normalizeCode,
  parseWeight,
  rangeText,
} from './checkin-logic';

function row(p: Partial<CheckinRow>): CheckinRow {
  return {
    registration_id: 1,
    person_id: 1,
    team_id: null,
    name: 'Ana Pérez',
    dojo_id: 10,
    dojo_name: 'Dojo Kaze',
    category_id: 100,
    category_name: 'Kumite -45',
    category_status: 'open',
    modality: 'kumite',
    weight_class: '-45',
    weight_min_kg: null,
    weight_max_kg: 45,
    needs_weigh_in: true,
    status: 'active',
    checkin_status: 'pending',
    checked_in_at: null,
    weight_kg: null,
    weighed_at: null,
    weigh_in_result: null,
    weigh_in_resolved: false,
    code: 'ABC234',
    version: 1,
    ...p,
  };
}

describe('acreditación', () => {
  it('agrupa las inscripciones de una persona en una tarjeta', () => {
    const cards = groupByPerson([
      row({
        registration_id: 2,
        category_name: 'Kata',
        modality: 'kata',
        needs_weigh_in: false,
        code: 'ZZZ999',
      }),
      row({ registration_id: 1, checkin_status: 'present' }),
      row({ registration_id: 3, person_id: 2, name: 'Bruno Díaz', code: 'QQQ222' }),
    ]);
    expect(cards.map((c) => c.name)).toEqual(['Ana Pérez', 'Bruno Díaz']);
    const ana = cards[0];
    expect(ana.rows.length).toBe(2);
    expect(ana.code).toBe('ABC234'); // el de su primera inscripción
    expect(ana.status).toBe('pending'); // presente en una, pendiente en otra
    expect(ana.needsWeighIn).toBe(true);
  });

  it('la tarjeta queda presente o ausente solo si todas sus inscripciones lo están', () => {
    const [c] = groupByPerson([
      row({ checkin_status: 'absent' }),
      row({ registration_id: 2, checkin_status: 'absent' }),
    ]);
    expect(c.status).toBe('absent');
  });

  it('marca el fuera de peso sin resolver', () => {
    const [c] = groupByPerson([row({ weight_kg: 47, weigh_in_result: 'over' })]);
    expect(c.weight).toBe(47);
    expect(c.weighResult).toBe('over');
    expect(c.unresolved).toBe(true);
    const [ok] = groupByPerson([
      row({ weight_kg: 47, weigh_in_result: 'over', weigh_in_resolved: true }),
    ]);
    expect(ok.unresolved).toBe(false);
  });

  it('filtra por nombre sin tildes, dojo, estado, fuera de peso y código', () => {
    const cards = groupByPerson([
      row({}),
      row({
        registration_id: 3,
        person_id: 2,
        name: 'Bruno Díaz',
        dojo_id: 11,
        dojo_name: 'Mizu',
        checkin_status: 'present',
        code: 'QQQ222',
      }),
      row({
        registration_id: 4,
        person_id: 3,
        name: 'Carla Soto',
        weigh_in_result: 'under',
        weight_kg: 30,
        code: 'RRR333',
      }),
    ]);
    expect(filterCards(cards, 'perez', 0, 'all').map((c) => c.name)).toEqual(['Ana Pérez']);
    expect(filterCards(cards, 'mizu', 0, 'all').map((c) => c.name)).toEqual(['Bruno Díaz']);
    expect(filterCards(cards, '', 11, 'all').length).toBe(1);
    expect(filterCards(cards, '', 0, 'pending').map((c) => c.name)).toEqual([
      'Ana Pérez',
      'Carla Soto',
    ]);
    expect(filterCards(cards, '', 0, 'out_of_weight').map((c) => c.name)).toEqual(['Carla Soto']);
    expect(filterCards(cards, 'qqq222', 0, 'all').map((c) => c.name)).toEqual(['Bruno Díaz']);
  });

  it('lee pesos con coma o punto y rechaza lo absurdo', () => {
    expect(parseWeight('45,3')).toBe(45.3);
    expect(parseWeight(' 45.256 ')).toBe(45.26);
    expect(parseWeight(52)).toBe(52);
    expect(parseWeight('')).toBeNull();
    expect(parseWeight('abc')).toBeNull();
    expect(parseWeight('0')).toBeNull();
    expect(parseWeight('450')).toBeNull();
  });

  it('reconoce códigos de credencial', () => {
    expect(normalizeCode(' hj:abc234 ')).toBe('ABC234');
    expect(looksLikeCode('abc234')).toBe(true);
    expect(looksLikeCode('HJ:ABC234')).toBe(true);
    expect(looksLikeCode('ana perez')).toBe(false);
    expect(looksLikeCode('ABC10')).toBe(false);
  });

  it('describe rangos de peso', () => {
    expect(rangeText(null, 45)).toBe('hasta 45 kg');
    expect(rangeText(45, 50)).toBe('45–50 kg');
    expect(rangeText(68, null)).toBe('más de 68 kg');
    expect(fold('  ÁÉÍ ')).toBe('aei');
  });
});
