import { HttpErrorResponse } from '@angular/common/http';
import { clearTranslations } from '@angular/localize';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api-error';
import { CODIGOS_TRADUCIDOS, mensajeDeError } from './errores';
import { cargarIdioma } from './idioma';

function respuesta(translations: Record<string, string>): typeof fetch {
  return vi.fn(
    async () => new Response(JSON.stringify({ translations }), { status: 200 }),
  ) as unknown as typeof fetch;
}

function errorApi(code: string, message: string, details: Record<string, unknown> = {}): ApiError {
  return ApiError.from(
    new HttpErrorResponse({ status: 409, error: { error: { code, message, details } } }),
  );
}

describe('errores de la API por idioma', () => {
  afterEach(async () => {
    clearTranslations();
    await cargarIdioma({ guardado: 'es', navegador: [] });
  });

  it('en español muestra el mensaje del servidor tal cual (es el más preciso)', async () => {
    await cargarIdioma({ guardado: 'es', navegador: [] });
    const e = errorApi('CATEGORY_FINISHED', 'La categoría Kumite -45 ya terminó');
    expect(e.message).toBe('La categoría Kumite -45 ya terminó');
  });

  it('en otro idioma traduce por código y usa los detalles', async () => {
    await cargarIdioma({
      guardado: 'en',
      navegador: [],
      fetch: respuesta({
        'error.category-finished': 'The category has already finished',
        'error.plan-required-nombre': 'This feature needs the {$plan} plan.',
      }),
    });
    expect(errorApi('CATEGORY_FINISHED', 'La categoría ya terminó').message).toBe(
      'The category has already finished',
    );
    expect(mensajeDeError('PLAN_REQUIRED', 'Necesitas un plan', { plan_name: 'Dojo' })).toBe(
      'This feature needs the Dojo plan.',
    );
  });

  it('traduce los mensajes genéricos frecuentes por su texto y deja el resto como respaldo', async () => {
    await cargarIdioma({
      guardado: 'pt-BR',
      navegador: [],
      fetch: respuesta({ 'error.usuario-contrasena-incorrectos': 'Usuário ou senha incorretos' }),
    });
    expect(errorApi('UNAUTHORIZED', 'Usuario o contraseña incorrectos').message).toBe(
      'Usuário ou senha incorretos',
    );
    expect(errorApi('NOT_FOUND', 'Tatami no encontrado').message).toBe('Tatami no encontrado');
    expect(errorApi('CODIGO_NUEVO', 'Mensaje nuevo del servidor').message).toBe(
      'Mensaje nuevo del servidor',
    );
  });

  it('cubre los códigos con significado propio del backend', () => {
    for (const code of [
      'VERSION_CONFLICT',
      'WARNINGS',
      'CONFLICT_DEVICE',
      'MATCH_STARTED',
      'COUPON_INVALID',
      'PUSH_TOO_MANY',
    ]) {
      expect(CODIGOS_TRADUCIDOS).toContain(code);
    }
  });
});
