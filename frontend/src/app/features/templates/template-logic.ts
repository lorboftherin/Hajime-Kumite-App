// Lógica pura de la edición de plantillas en tabla (sin Angular).
import { CategoryFields, TemplateItem } from '../../core/models';

/** Fila editable: los números se editan como texto y se convierten al guardar. */
export interface EditRow {
  id: number | null;
  code: string;
  name: string;
  modality: 'kumite' | 'kata';
  is_team: boolean;
  sex: 'M' | 'F' | 'X';
  age_min: string;
  age_max: string;
  grade_min: number | null;
  grade_max: number | null;
  weight_class: string;
  format: CategoryFields['format'];
  duration_seconds: string;
  /** Campos que la tabla no muestra y se conservan tal cual. */
  rest: Pick<
    CategoryFields,
    'third_place_rule' | 'kumite_rules' | 'kata_method' | 'kata_structure' | 'kata_judges'
  >;
}

const txt = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n));

export function toEditRow(i: TemplateItem): EditRow {
  return {
    id: i.id,
    code: i.code,
    name: i.name,
    modality: i.modality,
    is_team: i.is_team,
    sex: i.sex,
    age_min: txt(i.age_min),
    age_max: txt(i.age_max),
    grade_min: i.grade_min,
    grade_max: i.grade_max,
    weight_class: i.weight_class ?? '',
    format: i.format,
    duration_seconds: txt(i.duration_seconds),
    rest: {
      third_place_rule: i.third_place_rule,
      kumite_rules: i.kumite_rules,
      kata_method: i.kata_method,
      kata_structure: i.kata_structure,
      kata_judges: i.kata_judges,
    },
  };
}

/** Fila nueva: copia modalidad, sexo y edades de la anterior (se cargan en serie). */
export function blankRow(prev?: EditRow): EditRow {
  return {
    id: null,
    code: '',
    name: '',
    modality: prev?.modality ?? 'kumite',
    is_team: prev?.is_team ?? false,
    sex: prev?.sex ?? 'M',
    age_min: prev?.age_min ?? '',
    age_max: prev?.age_max ?? '',
    grade_min: prev?.grade_min ?? null,
    grade_max: prev?.grade_max ?? null,
    weight_class: '',
    format: prev?.format ?? null,
    duration_seconds: prev?.duration_seconds ?? '',
    rest: {
      third_place_rule: null,
      kumite_rules: null,
      kata_method: null,
      kata_structure: null,
      kata_judges: null,
    },
  };
}

function num(v: string): number | null | 'bad' {
  const t = (v ?? '').toString().trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 ? n : 'bad';
}

/** Errores por fila (1 = primera fila) antes de guardar; el servidor valida igual. */
export function validateRows(rows: EditRow[]): string[] {
  const errors: string[] = [];
  const seen = new Map<string, number>();
  rows.forEach((r, i) => {
    const n = i + 1;
    const code = r.code.trim();
    if (!code)
      errors.push($localize`:@@plantillas.fila-falta-codigo:Fila ${n}:n:: falta el código`);
    else if (seen.has(code.toUpperCase()))
      errors.push(
        $localize`:@@plantillas.fila-codigo-ya-esta-fila:Fila ${n}:n:: el código ${code}:code: ya está en la fila ${seen.get(code.toUpperCase())}:get:`,
      );
    else seen.set(code.toUpperCase(), n);
    if (!r.name.trim())
      errors.push($localize`:@@plantillas.fila-falta-nombre:Fila ${n}:n:: falta el nombre`);
    const a = num(r.age_min);
    const b = num(r.age_max);
    const d = num(r.duration_seconds);
    if (a === 'bad' || b === 'bad')
      errors.push(
        $localize`:@@plantillas.fila-edad-debe-ser-numero-entero:Fila ${n}:n:: la edad debe ser un número entero`,
      );
    else if (a !== null && b !== null && a > b)
      errors.push(
        $localize`:@@plantillas.fila-edad-minima-mayor-maxima:Fila ${n}:n:: la edad mínima es mayor que la máxima`,
      );
    if (d === 'bad')
      errors.push(
        $localize`:@@plantillas.fila-duracion-debe-ser-numero:Fila ${n}:n:: la duración debe ser un número de segundos`,
      );
    if (r.grade_min !== null && r.grade_max !== null && r.grade_min > r.grade_max) {
      errors.push(
        $localize`:@@plantillas.fila-grado-desde-mayor-hasta:Fila ${n}:n:: el grado «desde» es mayor que el «hasta»`,
      );
    }
  });
  return errors;
}

/** Cuerpo de PUT /templates/{id}/items. Supone filas ya validadas. */
export function toPayload(rows: EditRow[]): Array<CategoryFields & { id: number | null }> {
  const n = (v: string) => {
    const x = num(v);
    return x === 'bad' ? null : x;
  };
  return rows.map((r, i) => ({
    id: r.id,
    code: r.code.trim(),
    name: r.name.trim(),
    modality: r.modality,
    is_team: r.is_team,
    sex: r.sex,
    age_min: n(r.age_min),
    age_max: n(r.age_max),
    grade_min: r.grade_min,
    grade_max: r.grade_max,
    weight_class: r.weight_class.trim() || null,
    format: r.format,
    duration_seconds: n(r.duration_seconds),
    sort_order: i,
    ...r.rest,
  }));
}

export function moveRow<T>(rows: T[], index: number, delta: number): T[] {
  const j = index + delta;
  if (j < 0 || j >= rows.length) return rows;
  const out = rows.slice();
  [out[index], out[j]] = [out[j], out[index]];
  return out;
}
