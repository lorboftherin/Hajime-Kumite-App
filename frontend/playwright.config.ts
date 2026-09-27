// Pruebas de extremo a extremo con Playwright (ver «Pruebas de extremo a
// extremo» en CONTRIBUTING.md). El servidor es el real: la API (uvicorn, un
// proceso, SQLite en un archivo temporal) sirviendo el frontend compilado en
// la misma URL, como la imagen «todo en uno».
import { chromium, defineConfig, devices } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CI = !!process.env['CI'];

// Puerto libre y carpeta temporal: se eligen una vez en el proceso principal;
// los procesos de las pruebas heredan las variables y leen los mismos valores.
if (!process.env['HAJIME_E2E_PORT']) {
  process.env['HAJIME_E2E_PORT'] = execFileSync(process.execPath, [
    '-e',
    "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})",
  ])
    .toString()
    .trim();
}
if (!process.env['HAJIME_E2E_DIR']) {
  // Carpeta propia de esta corrida: e2e/global-teardown.ts la borra al terminar.
  process.env['HAJIME_E2E_DIR'] = mkdtempSync(join(tmpdir(), 'hajime-e2e-'));
  process.env['HAJIME_E2E_DIR_TEMPORAL'] = '1';
}
process.env['HAJIME_E2E_ADMIN_PASSWORD'] ??= 'admin-e2e-12345';
const baseURL = `http://127.0.0.1:${process.env['HAJIME_E2E_PORT']}`;

/**
 * Chromium de Playwright. Si el de esta versión no está instalado (p. ej. un
 * entorno con otro Chromium ya descargado en PLAYWRIGHT_BROWSERS_PATH), se usa
 * HAJIME_E2E_CHROMIUM o el primero que se encuentre allí. En CI se instala el
 * que corresponde con `npx playwright install --with-deps chromium`.
 */
function chromiumAlternativo(): string | undefined {
  const explicito = process.env['HAJIME_E2E_CHROMIUM'];
  if (explicito) return explicito;
  const carpeta = process.env['PLAYWRIGHT_BROWSERS_PATH'];
  if (!carpeta || !existsSync(carpeta) || existsSync(chromium.executablePath())) return undefined;
  for (const dir of readdirSync(carpeta)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort()
    .reverse()) {
    for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const exe = join(carpeta, dir, sub);
      if (existsSync(exe)) return exe;
    }
  }
  return undefined;
}
const executablePath = chromiumAlternativo();

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  // Cada escenario crea sus propios datos con nombres únicos: pueden correr a la vez.
  fullyParallel: true,
  workers: CI ? 2 : 3,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    locale: 'es-PE',
    timezoneId: 'America/Lima',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // El service worker de la PWA no interviene: cada prueba ve el servidor real.
    serviceWorkers: 'block',
    actionTimeout: 15_000,
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'bash e2e/servidor.sh',
    url: `${baseURL}/health/ready`,
    timeout: 240_000,
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
