import { NEVER, firstValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { retryDecision } from '../features/mesa/mesa-logic';
import { ApiError } from './api-error';
import { withTimeout } from './api.service';

describe('withTimeout', () => {
  it('convierte una espera sin respuesta en el error TIMEOUT (se reintenta como sin conexión)', async () => {
    const err = await firstValueFrom(withTimeout(NEVER, 20)).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('TIMEOUT');
    expect(err.status).toBe(0);
    expect(retryDecision(err, 1)).toBe('retry');
  });

  it('no toca las respuestas a tiempo ni otros errores', async () => {
    expect(await firstValueFrom(withTimeout(of(7), 20))).toBe(7);
    const other = new ApiError(400, 'X', 'malo');
    const err = await firstValueFrom(withTimeout(throwError(() => other), 20)).catch((e) => e);
    expect(err).toBe(other);
  });

  it('sin límite (0) deja pasar la petición tal cual', async () => {
    expect(await firstValueFrom(withTimeout(of('ok'), 0))).toBe('ok');
  });
});
