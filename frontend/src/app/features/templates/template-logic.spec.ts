import { describe, expect, it } from 'vitest';
import { TemplateItem } from '../../core/models';
import { blankRow, moveRow, toEditRow, toPayload, validateRows } from './template-logic';

const item: TemplateItem = {
  id: 7,
  code: 'K1',
  name: 'Kumite 10-11 M -35',
  modality: 'kumite',
  is_team: false,
  sex: 'M',
  age_min: 10,
  age_max: 11,
  grade_min: 1,
  grade_max: 4,
  weight_class: '-35',
  format: null,
  third_place_rule: 'repechage',
  duration_seconds: 90,
  kumite_rules: { lead_victory: 8 },
  kata_method: null,
  kata_structure: null,
  kata_judges: null,
  sort_order: 0,
};

describe('plantillas en tabla', () => {
  it('ida y vuelta conserva los campos que la tabla no muestra', () => {
    const [p] = toPayload([toEditRow(item)]);
    expect(p).toEqual({ ...item, sort_order: 0 });
  });

  it('una fila nueva copia modalidad, sexo y edades de la anterior', () => {
    const r = blankRow(toEditRow(item));
    expect(r.id).toBeNull();
    expect([r.modality, r.sex, r.age_min, r.age_max]).toEqual(['kumite', 'M', '10', '11']);
    expect(r.code).toBe('');
    expect(blankRow().modality).toBe('kumite');
  });

  it('valida códigos repetidos, faltantes y rangos', () => {
    const a = toEditRow(item);
    const b = { ...toEditRow(item), id: null, code: 'k1' };
    const c = {
      ...blankRow(),
      code: 'K9',
      name: 'X',
      age_min: '14',
      age_max: '12',
      duration_seconds: 'dos',
    };
    const errs = validateRows([a, b, c, { ...blankRow(), name: '' }]);
    expect(errs).toContain('Fila 2: el código k1 ya está en la fila 1');
    expect(errs).toContain('Fila 3: la edad mínima es mayor que la máxima');
    expect(errs).toContain('Fila 3: la duración debe ser un número de segundos');
    expect(errs).toContain('Fila 4: falta el código');
    expect(errs).toContain('Fila 4: falta el nombre');
    expect(validateRows([a])).toEqual([]);
  });

  it('el orden de la tabla es el orden de la plantilla', () => {
    const rows = [toEditRow(item), { ...toEditRow(item), id: 8, code: 'K2' }];
    const moved = moveRow(rows, 1, -1);
    expect(toPayload(moved).map((r) => [r.code, r.sort_order])).toEqual([
      ['K2', 0],
      ['K1', 1],
    ]);
    expect(moveRow(rows, 0, -1)).toBe(rows);
  });
});
