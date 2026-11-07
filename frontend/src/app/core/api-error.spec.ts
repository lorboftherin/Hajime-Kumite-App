import { HttpErrorResponse } from '@angular/common/http';
import { describe, expect, it } from 'vitest';
import { ApiError } from './api-error';

describe('ApiError', () => {
  it('entiende el formato uniforme y las advertencias', () => {
    const e = ApiError.from(
      new HttpErrorResponse({
        status: 409,
        error: {
          error: {
            code: 'WARNINGS',
            message: 'Hay advertencias',
            details: { warnings: [{ code: 'X', message: 'm' }] },
          },
        },
      }),
    );
    expect(e.code).toBe('WARNINGS');
    expect(e.warnings).toEqual([{ code: 'X', message: 'm' }]);
  });

  it('marca los errores de red', () => {
    const e = ApiError.from(new HttpErrorResponse({ status: 0 }));
    expect(e.isNetwork).toBe(true);
  });

  it('resume errores de validación', () => {
    const e = ApiError.from(
      new HttpErrorResponse({
        status: 422,
        error: {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Datos inválidos',
            details: { errors: [{ loc: ['body', 'name'], msg: 'too short' }] },
          },
        },
      }),
    );
    expect(e.fullMessage).toBe('Datos inválidos: name: too short');
  });
});
