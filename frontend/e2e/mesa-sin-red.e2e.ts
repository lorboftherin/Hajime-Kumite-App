// Escenario 4: la mesa sigue funcionando sin red; los eventos quedan en cola y
// llegan al servidor una sola vez al volver la conexión.
import { combates, torneoListo } from './apoyo/escenarios';
import { entrar, expect, test } from './apoyo/fixtures';

test.use({ viewport: { width: 1180, height: 820 }, hasTouch: true });

test('sin conexión los puntos quedan en cola y se envían al volver', async ({
  page,
  context,
  admin,
  estado,
}) => {
  const t = await torneoListo(admin, { competidores: 2, duracion: 120 });
  const combate = (await combates(admin, t.categoria.id))['R1-1'];

  await entrar(page, estado.baseURL, t.operador.usuario, t.operador.clave);
  await page.goto(`/mesa/${combate.id}?tatami=${t.tatami.id}`);
  await expect(page.getByText('En línea')).toBeVisible();
  const ladoAka = page.getByRole('region', { name: 'AKA', exact: true });
  const ladoAo = page.getByRole('region', { name: 'AO', exact: true });
  const puntajeAka = page.getByLabel(/^Puntaje aka:/);
  const puntajeAo = page.getByLabel(/^Puntaje ao:/);

  // Con red: el combate empieza en el servidor.
  await page.getByRole('button', { name: /HAJIME/ }).click();
  await expect
    .poll(async () => (await admin.get(`/matches/${combate.id}`)).match.status)
    .toBe('in_progress');

  // Sin red: la mesa sigue marcando y avisa cuántos eventos esperan.
  await context.setOffline(true);
  await ladoAka.getByRole('button', { name: /Waza-ari/ }).click();
  await ladoAka.getByRole('button', { name: /Yuko/ }).click();
  await ladoAo.getByRole('button', { name: /Ippon/ }).click();
  await expect(puntajeAka).toHaveText('3');
  await expect(puntajeAo).toHaveText('3');
  await expect(page.getByRole('button', { name: /Sin conexión · 3 pendientes/ })).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Eventos' }).getByText('pendiente', { exact: true }),
  ).toHaveCount(3);
  // Nada llegó al servidor todavía.
  expect((await admin.get(`/matches/${combate.id}`)).score).toEqual({ aka: 0, ao: 0 });

  // Vuelve la red: la cola se vacía sola y el servidor tiene el mismo marcador.
  await context.setOffline(false);
  await expect(page.getByText('En línea')).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByRole('region', { name: 'Eventos' }).getByText('pendiente', { exact: true }),
  ).toHaveCount(0);
  const servidor = await admin.get(`/matches/${combate.id}`);
  expect(servidor.score).toEqual({ aka: 3, ao: 3 });
  // Cada evento se guardó una sola vez (reintentos idempotentes con el mismo id).
  const puntos = servidor.events.filter((e: { type: string }) => e.type === 'point');
  expect(puntos).toHaveLength(3);
  expect(new Set(puntos.map((e: { id: string }) => e.id)).size).toBe(3);
  // Y la mesa muestra lo mismo tras recargar desde el servidor.
  await page.reload();
  await expect(puntajeAka).toHaveText('3');
  await expect(puntajeAo).toHaveText('3');
});
