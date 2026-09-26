// Escenario 5: importación de inscripciones desde Excel con una fila corregida en pantalla.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { unico } from './apoyo/api';
import { entrar, expect, test } from './apoyo/fixtures';

/** Python con el backend instalado (el mismo criterio que e2e/servidor.sh). */
function python(): string {
  if (process.env['HAJIME_E2E_PYTHON']) return process.env['HAJIME_E2E_PYTHON'];
  const venv = resolve(__dirname, '../../backend/.venv/bin/python');
  return existsSync(venv) ? venv : 'python';
}

test('descargar la plantilla, subirla llena, corregir una fila y confirmar', async ({
  page,
  admin,
  estado,
}, testInfo) => {
  const id = unico();
  const torneo = await admin.torneo(`Importación E2E ${id}`);
  await admin.post(`/tournaments/${torneo.id}/generate-categories`, {
    template_id: estado.plantilla.id,
  });
  await admin.estado(torneo.id, 'registration_open');

  await entrar(page, estado.baseURL, estado.organizador.usuario, estado.organizador.clave);
  await page.goto(`/torneos/${torneo.id}/importar`);

  // 1) Descargar la plantilla desde la pantalla.
  const descarga = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Descargar plantilla .xlsx' }).click();
  const plantilla = testInfo.outputPath('plantilla.xlsx');
  await (await descarga).saveAs(plantilla);

  // 2) Llenarla con openpyxl: tres filas buenas y una con errores (sexo y fecha).
  const dojo = `Dojo Excel ${id}`;
  const apellido = `Excel${id}`;
  const filas = [
    {
      dojo,
      nombres: 'Andrés',
      apellidos: apellido,
      nacimiento: '10/05/1995',
      sexo: 'M',
      grado: '1 dan',
      modalidades: 'kumite',
    },
    {
      dojo,
      nombres: 'Bruno',
      apellidos: apellido,
      nacimiento: '11/06/1996',
      sexo: 'M',
      grado: '2 kyu',
      modalidades: 'kumite',
    },
    {
      dojo,
      nombres: 'Carla',
      apellidos: apellido,
      nacimiento: '12/07/1997',
      sexo: 'F',
      grado: '1 kyu',
      modalidades: 'kata',
    },
    {
      dojo,
      nombres: 'Diego',
      apellidos: apellido,
      nacimiento: '31/02/xx',
      sexo: 'Z',
      grado: '3 kyu',
      modalidades: 'kumite',
    },
  ];
  const llena = testInfo.outputPath('inscripciones.xlsx');
  execFileSync(python(), [
    join(__dirname, 'apoyo', 'llenar_plantilla.py'),
    plantilla,
    llena,
    JSON.stringify(filas),
  ]);

  // 3) Subir: vista previa fila por fila, sin guardar nada todavía.
  await page.locator('input[type="file"]').setInputFiles(llena);
  await expect(page.getByRole('heading', { name: /Vista previa/ })).toBeVisible();
  await expect(page.getByText('3 nuevas')).toBeVisible();
  await expect(page.getByText('1 con error')).toBeVisible();
  expect(await admin.get(`/tournaments/${torneo.id}/registrations`)).toHaveLength(0);

  // 4) Corregir la fila con error en pantalla y revalidar.
  const filaError = page.getByRole('row', { name: new RegExp(`${apellido}, Diego`) });
  await filaError.getByRole('button', { name: 'Corregir' }).click();
  await page.getByLabel('Fecha de nacimiento').fill('13/08/1998');
  await page.getByLabel('Sexo (M/F)').fill('M');
  await page.getByRole('button', { name: 'Guardar y revalidar' }).click();
  await expect(page.getByText('4 nuevas')).toBeVisible();
  await expect(page.getByText('0 con error')).toBeVisible();
  await expect(filaError.getByRole('checkbox', { name: /Kumite Senior Masculino/ })).toBeChecked();

  // 5) Confirmar: se crean las personas, el dojo y las inscripciones.
  await page.getByRole('button', { name: 'Confirmar e inscribir' }).click();
  const resultado = page.locator('.import-result');
  await expect(resultado).toContainText('Importación confirmada.');
  const inscripciones = await admin.get(`/tournaments/${torneo.id}/registrations`);
  expect(inscripciones).toHaveLength(4);
  expect(inscripciones.map((r: { person_name: string }) => r.person_name).join(' ')).toContain(
    'Diego',
  );
  expect((await admin.get('/dojos')).some((d: { name: string }) => d.name === dojo)).toBe(true);
});
