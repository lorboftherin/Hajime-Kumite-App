import {
  NO_TATAMI,
  PlanCategory,
  PlanRule,
  applyRules,
  currentPlan,
  gradeOrdinal,
  moveTo,
  moveWithin,
  sortByCode,
  suggestFor,
} from './tatami-plan';

function cat(
  id: number,
  code: string,
  sex: string,
  lo: number,
  hi: number,
  extra: Partial<PlanCategory> = {},
) {
  return {
    id,
    code,
    name: code,
    sex,
    modality: code.startsWith('A') ? 'kata' : 'kumite',
    age_min: lo,
    age_max: hi,
    grade_min: null,
    grade_max: null,
    status: 'ready',
    tatami_id: 1,
    queue_position: id,
    ...extra,
  } satisfies PlanCategory;
}

const rule = (r: Partial<PlanRule>): PlanRule => ({
  sex: '',
  ageFrom: null,
  ageTo: null,
  modality: '',
  tatamiId: null,
  ...r,
});

describe('tatami-plan', () => {
  it('ordena por código: número y luego letra (A1, B1, A2, B2, A10)', () => {
    const cats = [
      cat(1, 'B2', 'M', 6, 7),
      cat(2, 'A10', 'M', 6, 7),
      cat(3, 'A2', 'M', 6, 7),
      cat(4, 'B1', 'M', 6, 7),
      cat(5, 'A1', 'M', 6, 7),
    ];
    expect(sortByCode(cats).map((c) => c.code)).toEqual(['A1', 'B1', 'A2', 'B2', 'A10']);
  });

  it('reparte como el coordinador: 13+ al 2, mujeres al 1, hombres al 2', () => {
    const cats = [
      cat(1, 'A1', 'M', 6, 7),
      cat(2, 'B1', 'M', 6, 7),
      cat(3, 'A2', 'F', 6, 7),
      cat(4, 'B2', 'F', 6, 7),
      cat(5, 'A9', 'F', 14, 15),
    ];
    const plan = applyRules(
      cats,
      [
        rule({ ageFrom: 13, tatamiId: 2 }),
        rule({ sex: 'F', tatamiId: 1 }),
        rule({ sex: 'M', tatamiId: 2 }),
      ],
      [1, 2],
    );
    expect(plan[1]).toEqual([3, 4]);
    expect(plan[2]).toEqual([1, 2, 5]);
    expect(plan[NO_TATAMI]).toEqual([]);
  });

  it('sin regla que calce, la categoría se queda donde estaba', () => {
    const cats = [cat(1, 'A1', 'M', 6, 7, { tatami_id: null })];
    expect(applyRules(cats, [rule({ sex: 'F', tatamiId: 1 })], [1])[NO_TATAMI]).toEqual([1]);
  });

  it('mover arriba/abajo y a otro tatami (entra por código)', () => {
    const cats = [
      cat(1, 'A1', 'M', 6, 7),
      cat(2, 'B1', 'M', 6, 7),
      cat(3, 'A2', 'M', 6, 7, { tatami_id: 2 }),
    ];
    const byId = new Map(cats.map((c) => [c.id, c]));
    const plan = currentPlan(cats, [1, 2]);
    expect(moveWithin(plan[1], 2, -1)).toEqual([2, 1]);
    const moved = moveTo(plan, 3, 1, byId);
    expect(moved[1]).toEqual([1, 2, 3]);
    expect(moved[2]).toEqual([]);
  });

  it('sugiere categorías por sexo, edad y grado', () => {
    const cats = [
      cat(1, 'A6', 'M', 6, 7, { grade_min: 1, grade_max: 1 }),
      cat(2, 'A7', 'M', 6, 7, { grade_min: 2, grade_max: 4 }),
      cat(3, 'A8', 'F', 6, 7),
      cat(4, 'B7', 'M', 6, 7, { grade_min: 2, grade_max: 4, status: 'merged' }),
    ];
    expect(gradeOrdinal('9 kyu')).toBe(2);
    expect(suggestFor(cats, 'M', 7, '9 kyu').map((c) => c.code)).toEqual(['A7']);
    expect(suggestFor(cats, 'M', 7, null).map((c) => c.code)).toEqual(['A6', 'A7']);
  });
});
