import { Pipe, PipeTransform } from '@angular/core';
import { fmtDate, fmtDateTime, fmtTime } from '../core/format';

/** Fecha y hora en America/Lima. */
@Pipe({ name: 'lima' })
export class LimaPipe implements PipeTransform {
  transform(v: string | null | undefined, mode: 'datetime' | 'time' = 'datetime'): string {
    return mode === 'time' ? fmtTime(v) : fmtDateTime(v);
  }
}

/** Fecha de calendario (YYYY-MM-DD). */
@Pipe({ name: 'fdate' })
export class DatePipe implements PipeTransform {
  transform(v: string | null | undefined): string {
    return fmtDate(v);
  }
}

/** Traduce un código con un diccionario de etiquetas. */
@Pipe({ name: 'label' })
export class LabelPipe implements PipeTransform {
  transform(v: string | null | undefined, map: Record<string, string>): string {
    if (v === null || v === undefined) return '';
    return map[v] ?? v;
  }
}
