// Escenario 9: acreditación en la entrada: presente, peso fuera de rango y su resolución.
import { unico } from './apoyo/api';
import { entrar, expect, test } from './apoyo/fixtures';

test.use({ viewport: { width: 1180, height: 820 }, hasTouch: true });

test('marcar presente, pesar fuera de rango y mover a la categoría que corresponde', async ({
  page,
  admin,
  estado,
}) => {
  const id = unico();
  const torneo = await admin.torneo(`Acreditación E2E ${id}`);
  await admin.estado(torneo.id, 'registration_open');
  const base = { modality: 'kumite', sex: 'M', age_min: 18, duration_seconds: 120 };
  const liviano = await admin.categoria(torneo.id, {
    ...base,
    code: `K60-${id}`.slice(0, 40),
    name: `Kumite -60 ${id}`,
    weight_class: '-60',
  });
  const medio = await admin.categoria(torneo.id, {
    ...base,
    code: `K67-${id}`.slice(0, 40),
    name: `Kumite -67 ${id}`,
    weight_class: '-67',
  });
  const dojo = await admin.dojo(`Dojo Balanza ${id}`);
  const apellido = `Pesaje${id}`;
  const persona = await admin.persona({ nombres: 'Gonzalo', apellidos: apellido, dojoId: dojo.id });
  await admin.inscribir(torneo.id, persona.id, liviano.id, { weight_class: '-60' });

  await entrar(page, estado.baseURL, estado.organizador.usuario, estado.organizador.clave);
  await page.goto(`/torneos/${torneo.id}/acreditacion`);
  await page.getByRole('textbox', { name: 'Buscar por nombre, dojo o código' }).fill('Gonzalo');
  const tarjeta = page
    .getByRole('region', { name: 'Competidores' })
    .getByRole('article')
    .filter({ hasText: apellido });
  await expect(tarjeta).toHaveCount(1);

  // Presente de un toque.
  await tarjeta.getByRole('button', { name: 'Presente' }).click();
  await expect(tarjeta.getByRole('button', { name: 'Presente' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByText(/1\s+presentes/)).toBeVisible();

  // Peso fuera de rango (64 kg en -60): la app advierte y ofrece la categoría del peso.
  await tarjeta.getByRole('textbox', { name: /^Peso de .* en kg$/ }).fill('64,2');
  await tarjeta.getByRole('button', { name: 'Pesar' }).click();
  const resolver = page.getByRole('dialog', { name: /^Peso fuera de rango/ });
  await expect(resolver).toBeVisible();
  await expect(tarjeta.getByText('Pasado de peso')).toBeVisible();
  await resolver.getByRole('button', { name: new RegExp(`Kumite -67 ${id}`) }).click();
  const motivo = page.getByRole('dialog', { name: `Mover a «Kumite -67 ${id}»` });
  await expect(motivo.getByRole('textbox')).toHaveValue('Peso en la balanza oficial');
  await motivo.getByRole('button', { name: 'Mover' }).click();
  await expect(resolver).toBeHidden();

  // Queda en la categoría nueva, presente y sin peso pendiente de resolver.
  await expect(tarjeta).toContainText(`Kumite -67 ${id}`);
  await expect(tarjeta.getByRole('button', { name: 'Resolver peso…' })).toHaveCount(0);
  const r = (await admin.get(`/tournaments/${torneo.id}/registrations`)).find(
    (x: { person_id: number; status: string }) =>
      x.person_id === persona.id && x.status === 'active',
  );
  expect(r.category_id).toBe(medio.id);
});
