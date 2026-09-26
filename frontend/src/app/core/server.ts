import { environment } from '../../environments/environment';

const SERVER_KEY = 'hajime.server';

/** Dirección base de la API (sin barra final), p. ej. `/api/v1` o `https://hajime…/api/v1`. */
export function apiBase(): string {
  if (environment.mobile) {
    try {
      const saved = localStorage.getItem(SERVER_KEY);
      if (saved) return `${saved.replace(/\/+$/, '')}/api/v1`;
    } catch {
      /* sin almacenamiento */
    }
  }
  return environment.apiBase;
}

/** Servidor al que apunta la app del celular (solo informativo en la web). */
export function serverUrl(): string {
  return apiBase().replace(/\/api\/v1$/, '') || location.origin;
}

/** Guarda otro servidor (app del celular). Vacío vuelve al predeterminado. */
export function setServerUrl(url: string): void {
  try {
    const clean = url.trim().replace(/\/+$/, '');
    if (clean) localStorage.setItem(SERVER_KEY, clean);
    else localStorage.removeItem(SERVER_KEY);
  } catch {
    /* sin almacenamiento */
  }
}

export const isMobileApp = environment.mobile;
