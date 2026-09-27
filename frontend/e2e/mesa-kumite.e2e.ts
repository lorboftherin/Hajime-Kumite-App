// Escenario 3: mesa de kumite en una tablet, desde «Mi tatami» hasta la llave.
import { combates, nombreDe, torneoListo } from './apoyo/escenarios';
import { entrar, expect, test } from './apoyo/fixtures';

test.use({ viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: false });

test('el operador registra un combate completo y el resultado llega a la llave', async ({
  page,
  admin,
  estado,
}) => {
  const t = await torneoListo(admin, { competidores: 4, duracion: 30 });
  const r1 = (await combates(admin, t.categoria.id))['R1-1'];
  const aka = nombreDe(t, r1.aka_registration_id);
  const ao = nombreDe(t, r1.ao_registration_id);

  await entrar(page, estado.baseURL, t.operador.usuario, t.operador.clave);
  await page.goto('/');
  // El operador de un tatami entra directo a «Mi tatami».
  await expect(page).toHaveURL(/\/mi-tatami/);
  await page.getByRole('link', { name: /Abrir siguiente combate/ }).click();
  await expect(page).toHaveURL(new RegExp(`/mesa/${r1.id}\\?tatami=${t.tatami.id}`));

  const ladoAka = page.getByRole('region', { name: 'AKA', exact: true });
  const ladoAo = page.getByRole('region', { name: 'AO', exact: true });
  await expect(ladoAka).toContainText(aka);
  await expect(ladoAo).toContainText(ao);
  await expect(page.getByText('En línea')).toBeVisible();

  const puntajeAka = page.getByLabel(/^Puntaje aka:/);
  const puntajeAo = page.getByLabel(/^Puntaje ao:/);

  await page.getByRole('button', { name: /HAJIME/ }).click();
  await expect(page.getByRole('button', { name: /YAME/ })).toBeVisible();
  await ladoAka.getByRole('button', { name: /Waza-ari/ }).click();
  await ladoAo.getByRole('button', { name: /Yuko/ }).click();
  await ladoAo.getByRole('button', { name: 'Chui 1' }).click();
  await expect(puntajeAka).toHaveText('2');
  await expect(puntajeAo).toHaveText('1');
  await expect(ladoAo.getByRole('button', { name: 'Chui 1' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // Un punto al color equivocado se deshace (queda anulado en el historial).
  await ladoAo.getByRole('button', { name: /Ippon/ }).click();
  await expect(puntajeAo).toHaveText('4');
  await page.getByRole('button', { name: /Deshacer último/ }).click();
  await expect(puntajeAo).toHaveText('1');
  await expect(page.getByRole('region', { name: 'Eventos' }).getByText('anulado')).toBeVisible();

  // Fin del tiempo: se adelanta el reloj con el ajuste de −10 s (time_adjust).
  const menosDiez = page.getByRole('button', { name: '−10' });
  for (let i = 0; i < 3; i++) await menosDiez.click();
  await expect(page.getByRole('timer')).toHaveText('0:00');

  // Cierre con la hoja: el servidor sugiere a AKA por puntos.
  await page.getByRole('button', { name: 'Finalizar combate' }).click();
  const hoja = page.getByRole('dialog', { name: 'Confirmar ganador' });
  await expect(hoja.getByLabel('Marcador')).toHaveText(/AKA 2\s*–\s*1 AO/);
  await hoja.getByRole('button', { name: 'Confirmar: gana AKA' }).click();
  await expect(hoja).toBeHidden();
  await expect(page.getByRole('button', { name: 'Desbloquear para corregir' })).toBeVisible();

  // En el servidor: ganador AKA con el marcador de la mesa.
  await expect
    .poll(async () => (await combates(admin, t.categoria.id))['R1-1'].winner_registration_id)
    .toBe(r1.aka_registration_id);

  // «Siguiente combate» abre el R1-2 del mismo tatami.
  const r2 = (await combates(admin, t.categoria.id))['R1-2'];
  await page.getByRole('button', { name: 'Siguiente combate →' }).click();
  await expect(page).toHaveURL(new RegExp(`/mesa/${r2.id}\\?tatami=${t.tatami.id}`));
  await expect(page.getByRole('region', { name: 'AKA', exact: true })).toContainText(
    nombreDe(t, r2.aka_registration_id),
  );

  // La llave muestra el marcador del R1-1 y al ganador ya en la final.
  await page.goto(`/categorias/${t.categoria.id}/llave`);
  await expect(page.getByLabel(/^Combate R1-1:/)).toContainText(/Puntos/);
  await expect(page.getByText('Ganador R1-2')).toBeVisible();
  await expect(page.locator('body')).toContainText(new RegExp(`R2-1\\s*Aka:\\s*${aka}`));
});
