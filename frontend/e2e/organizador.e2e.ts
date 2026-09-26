// Escenario 2: el organizador prepara e inicia un torneo desde la interfaz.
import { unico } from './apoyo/api';
import { entrar, expect, test } from './apoyo/fixtures';
import type { Page } from '@playwright/test';

/** Botón de estado del Resumen y su confirmación (mismo texto en ambos). */
async function cambiarEstado(page: Page, accion: string): Promise<void> {
  await page.getByRole('button', { name: accion }).click();
  const confirmar = page.getByRole('dialog', { name: accion });
  await confirmar.getByRole('button', { name: accion }).click();
  await expect(confirmar).toBeHidden();
}

test('crear torneo, categorías desde plantilla, 8 inscritos, llave, cola e inicio', async ({
  page,
  admin,
  estado,
}) => {
  const id = unico();
  const nombreTorneo = `Copa E2E ${id}`;
  // Ocho competidores ficticios de cuatro dojos (la inscripción se hace en pantalla).
  const dojos = [];
  for (const n of ['Norte', 'Sur', 'Este', 'Oeste'])
    dojos.push(await admin.dojo(`Dojo ${n} ${id}`));
  const apellido = `Prueba${id}`;
  const personas = [];
  for (let i = 0; i < 8; i++) {
    personas.push(
      await admin.persona({
        nombres: `Competidor${i + 1}`,
        apellidos: apellido,
        dojoId: dojos[i % 4].id,
        nacimiento: `199${i}-0${(i % 9) + 1}-15`,
      }),
    );
  }

  await entrar(page, estado.baseURL, estado.organizador.usuario, estado.organizador.clave);
  await page.goto('/torneos');

  // Crear el torneo sin plantilla (las categorías se generan después). La
  // lista de plantillas se retiene hasta después de elegir «Sin plantilla»:
  // con red lenta, su llegada reemplazaba la elección por la plantilla base.
  let soltarPlantillas = () => {};
  const plantillasRetenidas = new Promise<void>((r) => (soltarPlantillas = r));
  await page.route('**/api/v1/templates', async (ruta) => {
    await plantillasRetenidas;
    await ruta.continue();
  });
  await page.getByRole('button', { name: 'Nuevo torneo' }).click();
  const dialogo = page.getByRole('dialog', { name: 'Nuevo torneo' });
  await dialogo.getByLabel('Nombre *').fill(nombreTorneo);
  const plantilla = dialogo.getByLabel('Plantilla de categorías');
  await plantilla.selectOption({ label: '— Sin plantilla —' });
  soltarPlantillas();
  await expect(plantilla.getByRole('option', { name: /^Plantilla E2E/ })).toBeAttached();
  await expect(plantilla.locator('option:checked')).toHaveText('— Sin plantilla —');
  await page.unroute('**/api/v1/templates');
  await dialogo.getByRole('button', { name: 'Crear torneo' }).click();
  await expect(page).toHaveURL(/\/torneos\/\d+\/resumen/);
  await expect(page.getByRole('heading', { name: nombreTorneo })).toBeVisible();
  const tid = Number(/\/torneos\/(\d+)/.exec(page.url())![1]);

  // Generar categorías desde la plantilla.
  await page.getByRole('button', { name: 'Más acciones de categorías' }).click();
  await page.getByRole('menuitem', { name: 'Generar desde plantilla' }).click();
  const gen = page.getByRole('dialog', { name: 'Generar categorías' });
  await gen
    .getByLabel('Plantilla')
    .selectOption({ label: `${estado.plantilla.nombre} (2 categorías)` });
  await gen.getByRole('button', { name: 'Generar' }).click();
  await expect(gen).toBeHidden();
  const aviso = page.getByRole('dialog', { name: 'Categorías generadas' });
  await expect(aviso).toContainText('Se crearon 2 categorías.');
  await aviso.getByRole('button', { name: 'Entendido' }).click();
  await page.getByRole('link', { name: 'Categorías', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Ocultar vacías' }).uncheck();
  await expect(page.getByRole('row', { name: /Kumite Senior Masculino KU-SEN-M/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /Kata Senior Femenino KA-SEN-F/ })).toBeVisible();

  // Abrir inscripciones.
  await page.getByRole('link', { name: 'Resumen' }).click();
  await cambiarEstado(page, 'Abrir inscripciones');
  await expect(page.getByRole('button', { name: 'Cerrar inscripciones' })).toBeVisible();

  // Inscribir a los ocho desde la pestaña Inscripciones.
  await page.getByRole('link', { name: 'Inscripciones' }).click();
  // El diálogo queda abierto para inscribir a la siguiente persona.
  await page.getByRole('button', { name: 'Inscribir', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Inscribir competidor' });
  const buscar = modal.getByPlaceholder('Buscar persona por nombre o documento…');
  for (let i = 0; i < 8; i++) {
    await buscar.fill(`Competidor${i + 1} ${apellido}`);
    await modal
      .getByRole('button', { name: new RegExp(`${apellido}, Competidor${i + 1}\\b`) })
      .click();
    await modal.getByRole('checkbox', { name: /Kumite Senior Masculino/ }).check();
    await modal.getByRole('button', { name: 'Inscribir en 1 categoría' }).click();
    await expect(buscar).toHaveValue('');
  }
  await modal.getByRole('button', { name: 'Cerrar' }).click();
  await expect(page.getByText('8 inscripciones')).toBeVisible();

  // Cerrar inscripciones.
  await page.getByRole('link', { name: 'Resumen' }).click();
  await cambiarEstado(page, 'Cerrar inscripciones');
  await expect(page.getByRole('button', { name: 'Iniciar torneo' })).toBeVisible();

  // Generar la llave (8 inscritos: 7 combates, sin cruces del mismo dojo en 1.ª ronda).
  await page.getByRole('link', { name: 'Categorías', exact: true }).click();
  const fila = page.getByRole('row', { name: /Kumite Senior Masculino/ });
  await expect(fila.getByRole('cell', { name: '8', exact: true })).toBeVisible();
  await fila.getByRole('button', { name: 'Generar llave' }).click();
  await expect(page).toHaveURL(/\/categorias\/\d+\/llave/);
  await expect(page.getByText(/Competidor\d/).first()).toBeVisible();
  await page.goBack();

  // Organizar la cola del tatami.
  await page.getByRole('link', { name: 'Tatamis' }).click();
  await page.getByRole('button', { name: 'Organizar colas' }).first().click();
  const colas = page.getByRole('region', { name: 'Colas de categorías por tatami' });
  await colas.getByRole('checkbox', { name: /Kumite Senior Masculino/ }).check();
  await colas.getByRole('button', { name: /Asignar \(1\) a Tatami 1/ }).click();
  await expect(colas.getByText('Todas las categorías con inscritos tienen tatami.')).toBeVisible();

  // Un operador para el tatami (lo asigna el Admin), para que la verificación quede limpia.
  const torneo = await admin.get(`/tournaments/${tid}`);
  await admin.usuario({
    usuario: `mesa-${id}`,
    clave: 'mesa-e2e-123',
    rol: { role: 'table_operator', scope_type: 'tatami', scope_id: torneo.tatamis[0].id },
  });

  // Verificación «listo para iniciar» e inicio.
  await page.getByRole('link', { name: 'Resumen' }).click();
  await page.getByRole('button', { name: 'Iniciar torneo' }).click();
  const check = page.getByRole('dialog', { name: 'Antes de iniciar el torneo' });
  await expect(check).toBeVisible();
  await expect(check.getByText('Importante')).toHaveCount(0);
  await check.getByRole('button', { name: /^Iniciar/ }).click();
  await expect(check).toBeHidden();
  await expect(page.getByRole('button', { name: 'Finalizar torneo' })).toBeVisible();
  expect((await admin.get(`/tournaments/${tid}`)).status).toBe('in_progress');
});
