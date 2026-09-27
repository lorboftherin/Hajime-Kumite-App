// Escenario 10: accesibilidad con axe-core (todas sus reglas: WCAG 2.x A/AA y
// buenas prácticas) en las pantallas principales. Falla solo con violaciones
// «serious» o «critical»; las menores quedan como anotación y adjuntas al
// reporte (las conocidas, en CONTRIBUTING.md).
import AxeBuilder from '@axe-core/playwright';
import type { Page, TestInfo } from '@playwright/test';
import { combates, torneoListo } from './apoyo/escenarios';
import { entrar, expect, test } from './apoyo/fixtures';

async function revisar(page: Page, pantalla: string, testInfo: TestInfo): Promise<void> {
  const resultado = await new AxeBuilder({ page }).analyze();
  const graves = resultado.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  const menores = resultado.violations
    .filter((v) => !graves.includes(v))
    .map((v) => `${v.impact} ${v.id}`);
  if (menores.length)
    testInfo.annotations.push({ type: `axe ${pantalla}`, description: menores.join(', ') });
  await testInfo.attach(`axe-${pantalla}.json`, {
    body: JSON.stringify(resultado.violations, null, 2),
    contentType: 'application/json',
  });
  const resumen = graves.map((v) => {
    const nodos = v.nodes
      .slice(0, 5)
      .map((n) => `${n.target.join(' ')} · ${n.html.slice(0, 120)} · ${n.any[0]?.message ?? ''}`);
    return `${v.impact} · ${v.id}: ${v.help}\n    ${nodos.join('\n    ')}`;
  });
  expect(resumen, `Violaciones graves de accesibilidad en ${pantalla}`).toEqual([]);
}

test.describe('accesibilidad (axe)', () => {
  test('ingreso', async ({ page }, testInfo) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Ingresar' })).toBeVisible();
    await revisar(page, 'login', testInfo);
  });

  test('lista de torneos, detalle y mesa', async ({ page, admin, estado }, testInfo) => {
    const t = await torneoListo(admin, { competidores: 2 });
    await entrar(page, estado.baseURL, estado.organizador.usuario, estado.organizador.clave);

    await page.goto('/torneos');
    await expect(page.getByRole('heading', { name: 'Torneos' })).toBeVisible();
    await page.getByRole('checkbox', { name: 'Incluir torneos de prueba' }).check();
    await expect(page.getByRole('link', { name: new RegExp(t.torneo.name) })).toBeVisible();
    await revisar(page, 'torneos', testInfo);

    await page.goto(`/torneos/${t.torneo.id}/resumen`);
    await expect(page.getByRole('heading', { name: t.torneo.name })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Finalizar torneo' })).toBeVisible();
    await revisar(page, 'detalle', testInfo);

    const combate = (await combates(admin, t.categoria.id))['R1-1'];
    await page.goto(`/mesa/${combate.id}?tatami=${t.tatami.id}`);
    await expect(page.getByRole('button', { name: /HAJIME/ })).toBeVisible();
    await revisar(page, 'mesa', testInfo);
  });

  test('vivo público y pantalla grande', async ({ page, admin }, testInfo) => {
    const t = await torneoListo(admin, { competidores: 2 });
    const pub = await admin.put(`/tournaments/${t.torneo.id}/public`, { enabled: true });
    const combate = (await combates(admin, t.categoria.id))['R1-1'];
    await admin.evento(combate.id, 'start');
    await admin.evento(combate.id, 'point', 'aka', 2);

    await page.goto(`/t/${pub.public_slug}`);
    await expect(page.getByRole('heading', { level: 1, name: t.torneo.name })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Tatamis' })).toContainText('En curso');
    await revisar(page, 'vivo', testInfo);

    await page.goto(`/pantalla/${pub.public_token}/${t.tatami.id}`);
    await expect(page.getByTestId('pantalla-puntos-aka')).toHaveText('2');
    await revisar(page, 'pantalla', testInfo);
  });
});
