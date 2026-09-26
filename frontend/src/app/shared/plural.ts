import { Pipe, PipeTransform } from '@angular/core';
import { localeActual } from '../core/i18n/idioma';

/** Número con la palabra en singular o plural: «1 inscripción», «3 inscripciones», «0 inscripciones». */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Solo la palabra (sin el número), para frases como «2 categorías seleccionadas». */
export function pluralWord(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** Une una lista en el idioma de la interfaz: «a», «a y b», «a, b y c» («a, b, and c» en inglés). */
export function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return new Intl.ListFormat(localeActual(), { type: 'conjunction' }).format(items);
}

/** {{ n | plural: 'inscripción' : 'inscripciones' }} → «3 inscripciones». */
@Pipe({ name: 'plural' })
export class PluralPipe implements PipeTransform {
  transform(n: number | null | undefined, one: string, many: string): string {
    return plural(n ?? 0, one, many);
  }
}
