// Fixtures comunes: API como Admin y como organizador, y sesión en el navegador
// sin pasar por la pantalla de ingreso (la prueba de ingreso es login.e2e.ts).
import { test as base, expect, type Page } from '@playwright/test';
import { Api, type Sesion } from './api';
import { leerEstado, logServidor, type Estado } from './estado';

interface Fixtures {
  estado: Estado;
  /** API como Admin Global. */
  admin: Api;
  /** API como el organizador sembrado en globalSetup. */
  organizador: Api;
}

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  estado: async ({}, use) => {
    await use(leerEstado());
  },
  admin: async ({ estado }, use) => {
    const { api } = await Api.ingresar(estado.baseURL, estado.admin.usuario, estado.admin.clave);
    await use(api);
  },
  organizador: async ({ estado }, use) => {
    const { api } = await Api.ingresar(
      estado.baseURL,
      estado.organizador.usuario,
      estado.organizador.clave,
    );
    await use(api);
  },
});

export { expect };

/**
 * Abre la sesión de `usuario` en la página: ingresa por la API y deja los
 * tokens donde los guarda la app (AuthService, localStorage) antes de cargarla.
 */
export async function entrar(
  page: Page,
  baseURL: string,
  usuario: string,
  clave: string,
): Promise<Sesion> {
  const { sesion } = await Api.ingresar(baseURL, usuario, clave);
  await page.addInitScript((s) => {
    // Solo la primera vez: si la app renueva o cierra la sesión, no se pisa.
    if (sessionStorage.getItem('e2e.sesion')) return;
    sessionStorage.setItem('e2e.sesion', '1');
    localStorage.setItem('hajime.token', JSON.stringify(s.access_token));
    localStorage.setItem('hajime.refresh', JSON.stringify(s.refresh_token));
    localStorage.setItem('hajime.user', JSON.stringify(s.user));
  }, sesion);
  return sesion;
}

/**
 * Espera un correo en el log del servidor (proveedor console) y devuelve lo
 * que captura `patron` (grupo 1) en el último que coincida.
 */
export async function esperarEnCorreo(patron: RegExp, timeout = 15_000): Promise<string> {
  const global = new RegExp(
    patron.source,
    patron.flags.includes('g') ? patron.flags : patron.flags + 'g',
  );
  let hallado = '';
  await expect
    .poll(
      () => {
        const todos = [...logServidor().matchAll(global)];
        hallado = todos.length ? todos[todos.length - 1][1] : '';
        return hallado;
      },
      { timeout, message: `correo con ${patron}` },
    )
    .not.toBe('');
  return hallado;
}
