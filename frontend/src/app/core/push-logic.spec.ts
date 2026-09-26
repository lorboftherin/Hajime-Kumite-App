import { describe, expect, it } from 'vitest';
import {
  PUSH_MESSAGES,
  PushEnv,
  isIos,
  pushRef,
  pushSupport,
  safeUrl,
  toggled,
} from './push-logic';

const env = (over: Partial<PushEnv> = {}): PushEnv => ({
  mobileApp: false,
  swEnabled: true,
  pushManager: true,
  notification: true,
  ios: false,
  standalone: false,
  permission: 'default',
  ...over,
});

describe('pushSupport', () => {
  it('navegador con Web Push y service worker: se puede', () => {
    expect(pushSupport(env(), true)).toBe('ok');
    expect(pushSupport(env(), null)).toBe('ok'); // aún sin la configuración del servidor
  });

  it('app de Android: se oculta el botón y se explica cómo instalar desde el navegador', () => {
    expect(pushSupport(env({ mobileApp: true, swEnabled: false }), true)).toBe('app');
    expect(PUSH_MESSAGES.app).toContain('Instala Hajime desde el navegador');
  });

  it('iPhone sin instalar: pide agregar a la pantalla de inicio; instalado sí puede', () => {
    expect(pushSupport(env({ ios: true, pushManager: false }), true)).toBe('ios-install');
    expect(PUSH_MESSAGES['ios-install']).toContain('Agregar a pantalla de inicio');
    expect(pushSupport(env({ ios: true, standalone: true }), true)).toBe('ok');
  });

  it('sin Push API, sin service worker, servidor sin claves o permiso bloqueado', () => {
    expect(pushSupport(env({ pushManager: false }), true)).toBe('unsupported');
    expect(pushSupport(env({ notification: false }), true)).toBe('unsupported');
    expect(pushSupport(env({ swEnabled: false }), true)).toBe('no-sw');
    expect(pushSupport(env(), false)).toBe('server-off');
    expect(pushSupport(env({ permission: 'denied' }), true)).toBe('denied');
    for (const k of Object.keys(PUSH_MESSAGES)) {
      if (k !== 'ok')
        expect(PUSH_MESSAGES[k as keyof typeof PUSH_MESSAGES].length).toBeGreaterThan(20);
    }
  });
});

describe('isIos', () => {
  it('reconoce iPhone y el iPad que se presenta como Mac táctil', () => {
    expect(isIos('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)')).toBe(true);
    expect(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe(true);
    expect(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)).toBe(false);
    expect(isIos('Mozilla/5.0 (Linux; Android 14; Pixel 8)')).toBe(false);
  });
});

describe('pushRef, toggled y safeUrl', () => {
  it('toma endpoint y auth de la suscripción', () => {
    expect(
      pushRef({ endpoint: 'https://fcm.googleapis.com/x', keys: { auth: 'abc', p256dh: 'def' } }),
    ).toEqual({ endpoint: 'https://fcm.googleapis.com/x', auth: 'abc' });
    expect(pushRef({ endpoint: 'https://x' })).toBeNull();
    expect(pushRef(null)).toBeNull();
  });

  it('agrega y quita sin tocar el conjunto original', () => {
    const base = new Set(['a']);
    expect([...toggled(base, 'b')]).toEqual(['a', 'b']);
    expect([...toggled(base, 'a')]).toEqual([]);
    expect([...toggled(base, 'a', true)]).toEqual(['a']);
    expect([...base]).toEqual(['a']);
  });

  it('solo abre rutas internas', () => {
    expect(safeUrl('/t/copa-2026?seguir=abc')).toBe('/t/copa-2026?seguir=abc');
    expect(safeUrl('https://otro.sitio')).toBeNull();
    expect(safeUrl('//otro.sitio/x')).toBeNull();
    expect(safeUrl(undefined)).toBeNull();
  });
});
