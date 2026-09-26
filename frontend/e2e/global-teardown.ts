// Borra la carpeta temporal de la corrida (base SQLite, log del servidor y
// estado) si la eligió playwright.config.ts. Con HAJIME_E2E_DIR fijado a mano
// se conserva para revisarla después.
import { rmSync } from 'node:fs';

export default function globalTeardown(): void {
  const dir = process.env['HAJIME_E2E_DIR'];
  if (dir && process.env['HAJIME_E2E_DIR_TEMPORAL'] === '1') {
    rmSync(dir, { recursive: true, force: true });
  }
}
