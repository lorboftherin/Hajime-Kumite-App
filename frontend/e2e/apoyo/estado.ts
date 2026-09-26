// Estado que deja globalSetup (credenciales y datos comunes) en la carpeta
// temporal de la corrida (HAJIME_E2E_DIR, ver playwright.config.ts).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Credenciales {
  usuario: string;
  clave: string;
}

export interface Estado {
  baseURL: string;
  admin: Credenciales;
  organizador: Credenciales;
  /** Plantilla pequeña para «Generar desde plantilla». */
  plantilla: { id: number; nombre: string };
}

export function carpetaE2E(): string {
  const dir = process.env['HAJIME_E2E_DIR'];
  if (!dir) throw new Error('Falta HAJIME_E2E_DIR: corre las pruebas con `npm run e2e`');
  return dir;
}

const archivo = () => join(carpetaE2E(), 'estado.json');

export function guardarEstado(estado: Estado): void {
  writeFileSync(archivo(), JSON.stringify(estado, null, 2));
}

export function leerEstado(): Estado {
  if (!existsSync(archivo())) throw new Error(`No existe ${archivo()}: ¿corrió globalSetup?`);
  return JSON.parse(readFileSync(archivo(), 'utf8')) as Estado;
}

/** Log del servidor (salida de uvicorn): allí escribe el proveedor de correo console. */
export function logServidor(): string {
  const f = join(carpetaE2E(), 'servidor.log');
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
}
