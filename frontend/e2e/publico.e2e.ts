// Escenario 7: el vivo público sin sesión y la pantalla grande de un tatami.
import { combates, torneoListo } from './apoyo/escenarios';
import { entrar, expect, test } from './apoyo/fixtures';

test('activar el vivo, buscar, marcar favorito, ver la llave y la pantalla grande', async ({
  page,
  browser,
  admin,
  estado,
}) => {
  const t = await torneoListo(admin, { competidores: 4, duracion: 120 });
  const r1 = (await combates(admin, t.categoria.id))['R1-1'];

  // El organizador activa el seguimiento en vivo desde el Resumen.
  await entrar(page, estado.baseURL, estado.organizador.usuario, estado.organizador.clave);
  await page.goto(`/torneos/${t.torneo.id}/resumen`);
  const vivo = page.getByRole('region', { name: 'Seguimiento en vivo y transmisión' });
  await vivo.getByRole('button', { name: 'Activar' }).click();
  const direccion = vivo.getByRole('textbox', { name: 'Dirección fija de la página pública' });
  await expect(direccion).toHaveValue(/\/t\/[a-z0-9-]+$/);
  const slug = (await direccion.inputValue()).split('/t/')[1];
  const token = (await admin.get(`/tournaments/${t.torneo.id}`)).public_token as string;
  expect(token).toBeTruthy();

  // Público: otro navegador, sin sesión.
  const publico = await browser.newContext({ baseURL: estado.baseURL, serviceWorkers: 'block' });
  const vista = await publico.newPage();
  await vista.goto(`/t/${slug}`);
  await expect(vista.getByRole('heading', { level: 1, name: t.torneo.name })).toBeVisible();

  // «¿Cuándo pelea?»: buscar a un competidor (nombres abreviados) y marcarlo favorito.
  const nombre = t.nombres[0].split(' ')[0];
  const cuando = vista.getByRole('region', { name: '¿Cuándo pelea?' });
  await cuando.getByPlaceholder(/Nombre o dojo/).fill(nombre);
  const estrella = cuando.getByRole('button', {
    name: new RegExp(`^Marcar como favorito a ${nombre}`),
  });
  await estrella.click();
  await expect(
    cuando.getByRole('button', { name: new RegExp(`^Quitar de favoritos a ${nombre}`) }).first(),
  ).toHaveAttribute('aria-pressed', 'true');
  await cuando.getByPlaceholder(/Nombre o dojo/).fill('');
  await expect(cuando.getByRole('heading', { name: 'Mis favoritos' })).toBeVisible();
  // El favorito se recuerda en este dispositivo.
  await vista.reload();
  await expect(vista.getByRole('heading', { name: 'Mis favoritos' })).toBeVisible();
  await expect(vista.getByRole('region', { name: '¿Cuándo pelea?' })).toContainText(nombre);

  // Llave pública de la categoría.
  await vista
    .getByRole('region', { name: 'Llaves por categoría' })
    .getByRole('link', { name: t.categoria.name })
    .click();
  await expect(vista).toHaveURL(new RegExp(`/t/${slug}/categoria/${t.categoria.id}`));
  await expect(vista.locator('body')).toContainText(nombre);

  // Pantalla grande del tatami: el marcador cambia tras un punto en la mesa.
  await admin.evento(r1.id, 'start');
  await vista.goto(`/pantalla/${token}/${t.tatami.id}`);
  const puntosAka = vista.getByTestId('pantalla-puntos-aka');
  await expect(puntosAka).toHaveText('0');
  await admin.evento(r1.id, 'point', 'aka', 2);
  await expect(puntosAka).toHaveText('2');
  await admin.evento(r1.id, 'point', 'ao', 1);
  await expect(vista.getByTestId('pantalla-puntos-ao')).toHaveText('1');
  await publico.close();
});
