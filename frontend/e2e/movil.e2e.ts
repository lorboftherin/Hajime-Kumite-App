// Escenario 11: el vivo público y la mesa en un teléfono (Pixel 7) sin scroll horizontal.
import { devices, type Page } from '@playwright/test';
import { combates, torneoListo } from './apoyo/escenarios';
import { entrar, expect, test } from './apoyo/fixtures';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { defaultBrowserType, ...pixel7 } = devices['Pixel 7'];
test.use(pixel7);

/** Lo que el documento se puede desplazar de lado (0 = nada). */
async function sinScrollHorizontal(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) -
          document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(0);
}

test('vivo público en el teléfono', async ({ page, admin }) => {
  const t = await torneoListo(admin, { competidores: 4 });
  const pub = await admin.put(`/tournaments/${t.torneo.id}/public`, { enabled: true });
  const combate = (await combates(admin, t.categoria.id))['R1-1'];
  await admin.evento(combate.id, 'start');
  await admin.evento(combate.id, 'point', 'ao', 1);

  await page.goto(`/t/${pub.public_slug}`);
  await expect(page.getByRole('heading', { level: 1, name: t.torneo.name })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Tatamis' })).toContainText('En curso');
  await sinScrollHorizontal(page);

  // Con resultados de búsqueda y en la llave de la categoría.
  const nombre = t.nombres[0].split(' ')[0];
  await page.getByPlaceholder(/Nombre o dojo/).fill(nombre);
  await expect(
    page.getByRole('button', { name: new RegExp(`^Marcar como favorito a ${nombre}`) }),
  ).toBeVisible();
  await sinScrollHorizontal(page);
  await page.goto(`/t/${pub.public_slug}/categoria/${t.categoria.id}`);
  await expect(page.locator('body')).toContainText(nombre);
  await sinScrollHorizontal(page);
});

test('mesa de kumite en el teléfono', async ({ page, admin, estado }) => {
  const t = await torneoListo(admin, { competidores: 2 });
  const combate = (await combates(admin, t.categoria.id))['R1-1'];
  await entrar(page, estado.baseURL, t.operador.usuario, t.operador.clave);
  await page.goto(`/mesa/${combate.id}?tatami=${t.tatami.id}`);
  await expect(page.getByRole('button', { name: /HAJIME/ })).toBeVisible();
  await sinScrollHorizontal(page);

  // Se opera con toques: HAJIME y un punto.
  await page.getByRole('button', { name: /HAJIME/ }).tap();
  await page
    .getByRole('region', { name: 'AKA', exact: true })
    .getByRole('button', { name: /Waza-ari/ })
    .tap();
  await expect(page.getByLabel(/^Puntaje aka:/)).toHaveText('2');
  await sinScrollHorizontal(page);

  // «Mi tatami» también cabe.
  await page.goto('/mi-tatami');
  await expect(page.getByRole('link', { name: /Abrir combate en curso/ })).toBeVisible();
  await sinScrollHorizontal(page);
});
