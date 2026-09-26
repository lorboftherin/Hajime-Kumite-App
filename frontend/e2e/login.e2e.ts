// Escenario 1: ingreso con cambio de clave obligatorio y «¿Olvidaste tu contraseña?».
import { unico } from './apoyo/api';
import { esperarEnCorreo, expect, test } from './apoyo/fixtures';

test('la clave asignada por el Admin se cambia al entrar y se recupera por correo', async ({
  page,
  admin,
}) => {
  const id = unico();
  const usuario = `juez-${id}`;
  const correo = `juez-${id}@ejemplo.test`;
  // La cuenta la crea el Admin: su contraseña es temporal (must_change_password).
  await admin.usuario({ usuario, clave: 'temporal-123', email: correo, cambiarClave: false });

  await page.goto('/login');
  await page.getByLabel('Usuario o correo').fill(usuario);
  await page.getByLabel('Contraseña').fill('temporal-123');
  await page.getByRole('button', { name: 'Ingresar' }).click();

  // Cambio obligatorio: no se puede seguir sin elegir una contraseña nueva.
  await expect(page).toHaveURL(/\/cambiar-clave/);
  await expect(page.getByText('Tu contraseña fue asignada por el administrador')).toBeVisible();
  await page.getByLabel('Contraseña actual').fill('temporal-123');
  await page.getByLabel(/^Nueva contraseña/).fill('propia-segura-1');
  await page.getByLabel('Repite la nueva contraseña').fill('propia-segura-1');
  await page.getByRole('button', { name: 'Guardar nueva contraseña' }).click();
  await expect(page).not.toHaveURL(/\/cambiar-clave/);
  // Ya no la pide al volver a cargar.
  await page.reload();
  await expect(page).not.toHaveURL(/\/cambiar-clave|\/login/);

  // «¿Olvidaste tu contraseña?», ya sin sesión.
  await page.evaluate(() => localStorage.clear());
  const anon = page;
  await anon.goto('/login');
  await anon.getByRole('link', { name: '¿Olvidaste tu contraseña?' }).click();
  await expect(anon).toHaveURL(/\/recuperar-clave/);
  await anon.getByLabel('Correo').fill(correo);
  await anon.getByRole('button', { name: 'Enviar enlace' }).click();
  await expect(anon.getByText('Revisa tu correo.')).toBeVisible();

  // El proveedor console escribe el correo en el log del servidor.
  const escapado = correo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const token = await esperarEnCorreo(
    new RegExp(`para ${escapado}:[\\s\\S]*?restablecer-clave#([\\w-]+)`),
  );
  await anon.goto(`/restablecer-clave#${token}`);
  await anon.getByRole('textbox', { name: /^Contraseña nueva/ }).fill('recuperada-456');
  await anon.getByLabel('Repite la contraseña').fill('recuperada-456');
  await anon.getByRole('button', { name: 'Guardar contraseña' }).click();
  await expect(anon).toHaveURL(/\/login/);

  // Entra con la contraseña nueva; la anterior ya no sirve.
  await anon.getByLabel('Usuario o correo').fill(correo);
  await anon.getByLabel('Contraseña').fill('propia-segura-1');
  await anon.getByRole('button', { name: 'Ingresar' }).click();
  await expect(anon.getByRole('alert')).toContainText('incorrectos');
  await anon.getByLabel('Contraseña').fill('recuperada-456');
  await anon.getByRole('button', { name: 'Ingresar' }).click();
  await expect(anon).not.toHaveURL(/\/login/);
});
