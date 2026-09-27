// Cobros apagados (HAJIME_PAYMENTS_ENABLED=false, el valor por defecto; ver docs/cobros.md):
// sin menú «Pagos», sin «Suscribirse», rutas de pago al inicio y la API de cobro en 404.
import { ApiError } from './apoyo/api';
import { entrar, expect, test } from './apoyo/fixtures';

test('con los cobros apagados no se ve nada de pagos y la API de cobro responde 404', async ({
  page,
  admin,
  estado,
}) => {
  const cfg = await admin.get('/billing/config');
  expect(cfg.payments_enabled).toBe(false);
  expect(cfg.mode).toBe('marcha_blanca');
  const err = await admin.get('/coupons').catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).status).toBe(404);
  expect(JSON.stringify((err as ApiError).body)).toContain('PAYMENTS_DISABLED');

  await entrar(page, estado.baseURL, estado.admin.usuario, estado.admin.clave);
  await page.goto('/torneos');
  const menu = page.getByRole('complementary', { name: 'Navegación principal' });
  await expect(menu.getByRole('link', { name: /Usuarios/ })).toBeVisible();
  await expect(menu.getByRole('link', { name: /Pagos/ })).toHaveCount(0);

  // «Planes» queda informativa: aviso de marcha blanca y sin «Suscribirse».
  await page.goto('/planes');
  await expect(
    page.getByText('Durante la marcha blanca todo está incluido sin costo.'),
  ).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Dojo', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Suscribirse' })).toHaveCount(0);

  // Las rutas de pago llevan al inicio.
  for (const ruta of ['/pago/exito', '/pago/culqi/1', '/pagos']) {
    await page.goto(ruta);
    await expect(page).not.toHaveURL(/\/pagos?(\/|$)/);
  }

  // «Organización»: sin datos fiscales ni «Pagos y comprobantes».
  await page.goto('/organizacion');
  await expect(page.getByRole('heading', { name: 'Plan actual' })).toBeVisible();
  await expect(page.getByText('Datos para el comprobante')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Pagos y comprobantes' })).toHaveCount(0);
});
