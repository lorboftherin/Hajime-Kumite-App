// Escenario 8: autoinscripción por dojo con invitación y aprobación en «Solicitudes».
import { unico } from './apoyo/api';
import { entrar, expect, test } from './apoyo/fixtures';

test('el sensei acepta la invitación, inscribe a dos alumnos y el organizador aprueba', async ({
  page,
  browser,
  admin,
  estado,
}) => {
  const id = unico();
  const torneo = await admin.torneo(`Autoinscripción E2E ${id}`);
  await admin.post(`/tournaments/${torneo.id}/generate-categories`, {
    template_id: estado.plantilla.id,
  });
  await admin.estado(torneo.id, 'registration_open');
  const dojo = await admin.dojo(`Dojo Invitado ${id}`);
  const sensei = { usuario: `sensei-${id}`, clave: 'sensei-e2e-123' };
  await admin.usuario(sensei);

  // Organizador: abre la inscripción en línea e invita al dojo.
  await entrar(page, estado.baseURL, estado.organizador.usuario, estado.organizador.clave);
  await page.goto(`/torneos/${torneo.id}/solicitudes`);
  await page.getByRole('checkbox', { name: 'Inscripción en línea abierta' }).check();
  await page.getByRole('button', { name: 'Guardar' }).click();
  await expect
    .poll(async () => (await admin.get(`/tournaments/${torneo.id}`)).self_registration_open)
    .toBe(true);
  await page.getByLabel('Dojo del enlace').selectOption({ label: dojo.name });
  await page.getByRole('button', { name: 'Generar enlace' }).click();
  const enlace = page.getByRole('textbox', { name: `Enlace de ${dojo.name}` });
  await expect(enlace).toHaveValue(/\/invitacion\//);
  const ruta = new URL(await enlace.inputValue()).pathname;

  // Sensei (otro navegador): acepta la invitación y queda como admin del dojo.
  const contexto = await browser.newContext({ baseURL: estado.baseURL, serviceWorkers: 'block' });
  const s = await contexto.newPage();
  await entrar(s, estado.baseURL, sensei.usuario, sensei.clave);
  await s.goto(ruta);
  await expect(s.getByText(torneo.name)).toBeVisible();
  await s.getByRole('button', { name: 'Aceptar invitación' }).click();
  // Queda como admin del dojo y la app lo lleva a «Mis competidores».
  await expect(s).toHaveURL(/\/mis-competidores/);
  await expect(s.getByRole('heading', { name: dojo.name })).toBeVisible();

  // Dos alumnos nuevos del dojo.
  const apellido = `Alumno${id}`;
  for (const [nombre, nacimiento] of [
    ['Ernesto', '1994-04-04'],
    ['Fabián', '1993-03-03'],
  ]) {
    await s.getByRole('button', { name: 'Nuevo competidor' }).click();
    const modal = s.getByRole('dialog', { name: 'Nuevo competidor' });
    await modal.getByLabel('Nombres *').fill(nombre);
    await modal.getByLabel('Apellidos *').fill(apellido);
    await modal.getByLabel('Fecha de nacimiento').fill(nacimiento);
    await modal.getByLabel('Sexo *').selectOption('M');
    await modal.getByRole('button', { name: 'Crear persona' }).click();
    await expect(modal).toBeHidden();
    await expect(s.getByRole('cell', { name: `${apellido}, ${nombre}` })).toBeVisible();
  }

  // Inscribirlos en el torneo (quedan pendientes).
  await s.getByRole('tab', { name: 'Inscribir en torneo' }).click();
  const selector = s.getByLabel('Torneo');
  const opcion = (await selector.locator('option', { hasText: torneo.name }).textContent()) ?? '';
  await selector.selectOption({ label: opcion.replace(/\s+/g, ' ').trim() });
  for (const nombre of ['Ernesto', 'Fabián']) {
    await s.getByRole('checkbox', { name: `Inscribir a ${nombre} ${apellido}` }).check();
    await s.getByLabel(`Categoría de ${nombre}`).selectOption({ label: 'Kumite Senior Masculino' });
  }
  await s.getByRole('button', { name: 'Enviar 2 inscripciones' }).click();
  await s.getByRole('tab', { name: 'Mis inscripciones' }).click();
  for (const nombre of ['Ernesto', 'Fabián']) {
    await expect(
      s.getByRole('row', { name: new RegExp(nombreCompleto(nombre, apellido)) }),
    ).toContainText('Pendiente');
  }

  // Organizador: aprueba en lote en «Solicitudes».
  await page.reload();
  await expect(page.getByRole('link', { name: /Solicitudes/ })).toContainText('2');
  await page.getByRole('button', { name: 'Seleccionar todas' }).click();
  await page.getByRole('button', { name: 'Aprobar (2)' }).click();
  await expect(page.getByText('2 inscripciones aprobadas')).toBeVisible();
  const inscripciones = await admin.get(`/tournaments/${torneo.id}/registrations`);
  expect(inscripciones.filter((r: { status: string }) => r.status === 'active')).toHaveLength(2);

  // El sensei ve sus inscripciones aprobadas.
  await s.reload();
  await s.getByRole('tab', { name: 'Mis inscripciones' }).click();
  for (const nombre of ['Ernesto', 'Fabián']) {
    await expect(
      s.getByRole('row', { name: new RegExp(nombreCompleto(nombre, apellido)) }),
    ).toContainText('Activa');
  }
  await contexto.close();
});

function nombreCompleto(nombre: string, apellido: string): string {
  return `${nombre} ${apellido}`;
}
