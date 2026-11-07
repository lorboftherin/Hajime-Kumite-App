// Escenario 6: kata por banderas en la mesa y kata por puntaje en la llave (mesa de notas).
import { combates, nombreDe, torneoListo } from './apoyo/escenarios';
import { entrar, expect, test } from './apoyo/fixtures';

test.use({ viewport: { width: 1180, height: 820 }, hasTouch: true });

test('kata por banderas: dos de tres jueces dan la victoria a AO', async ({
  page,
  admin,
  estado,
}) => {
  const t = await torneoListo(admin, { competidores: 2, modalidad: 'kata', kata: 'flags' });
  const combate = (await combates(admin, t.categoria.id))['R1-1'];

  await entrar(page, estado.baseURL, t.operador.usuario, t.operador.clave);
  await page.goto('/mi-tatami');
  await page.getByRole('link', { name: /Abrir siguiente combate/ }).click();
  await expect(page).toHaveURL(new RegExp(`/mesa/${combate.id}`));

  const jueces = page.getByRole('region', { name: 'Banderas de 3 jueces' });
  await jueces.getByRole('button', { name: 'AO' }).nth(0).click();
  await jueces.getByRole('button', { name: 'AKA' }).nth(1).click();
  await jueces.getByRole('button', { name: 'AO' }).nth(2).click();
  await expect(page.getByLabel('Banderas ao: 2')).toBeVisible();
  await expect(page.getByLabel('Banderas aka: 1')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Decisión' })).toContainText(
    'Gana AO · 2 de 3 banderas',
  );

  await page.getByRole('button', { name: 'Registrar decisión' }).click();
  await expect(page.getByRole('button', { name: 'Desbloquear para corregir' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Combate cerrado' })).toContainText(
    nombreDe(t, combate.ao_registration_id),
  );
  const cerrado = (await combates(admin, t.categoria.id))['R1-1'];
  expect(cerrado.winner_registration_id).toBe(combate.ao_registration_id);
  expect(cerrado.method).toBe('flags');
});

test('kata por puntaje en llave: la mesa de notas decide por el total del panel', async ({
  page,
  admin,
  estado,
}) => {
  const t = await torneoListo(admin, { competidores: 2, modalidad: 'kata', kata: 'scores' });
  const combate = (await combates(admin, t.categoria.id))['R1-1'];

  await entrar(page, estado.baseURL, t.operador.usuario, t.operador.clave);
  await page.goto(`/mesa/${combate.id}?tatami=${t.tatami.id}`);

  const notas: Record<'AKA' | 'AO', string[]> = {
    AKA: ['8.0', '8.2', '8.1', '8.3', '7.9'],
    AO: ['7.5', '7.6', '7.8', '7.4', '7.7'],
  };
  for (const lado of ['AKA', 'AO'] as const) {
    const region = page.getByRole('region', { name: lado, exact: true });
    await region.getByPlaceholder('Nombre del kata').fill(lado === 'AKA' ? 'Unsu' : 'Kanku Dai');
    for (let j = 0; j < 5; j++)
      await region.getByLabel(`Nota del juez ${j + 1}`).fill(notas[lado][j]);
  }
  await page.getByRole('button', { name: 'Registrar notas' }).click();
  await expect(page.getByRole('button', { name: 'Desbloquear para corregir' })).toBeVisible();

  const cerrado = (await combates(admin, t.categoria.id))['R1-1'];
  expect(cerrado.winner_registration_id).toBe(combate.aka_registration_id);

  // La llave muestra el combate cerrado con el ganador.
  await page.goto(`/categorias/${t.categoria.id}/llave`);
  await expect(page.locator('body')).toContainText(
    new RegExp(`R1-1[\\s\\S]*${nombreDe(t, combate.aka_registration_id)}`),
  );
  const llave = await admin.get(`/categories/${t.categoria.id}/bracket`);
  expect(llave.podium.places[0].registration_id).toBe(combate.aka_registration_id);
});
