import { Injectable, signal } from '@angular/core';

export type ThemeMode = 'light' | 'dark' | 'system';
const KEY = 'hajime.theme';
/** Color de la barra del navegador en cada tema (washi / yoru). */
const BAR: Record<'light' | 'dark', string> = { light: '#F5F0E6', dark: '#141311' };

function readMode(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

/**
 * Tema claro «Washi», oscuro «Yoru» o el del sistema. Se guarda en localStorage (si se puede)
 * y se aplica como data-theme en <html>; index.html lo aplica antes de arrancar para evitar destellos.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly mode = signal<ThemeMode>(readMode());
  private media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

  constructor() {
    this.apply();
    this.media?.addEventListener?.('change', () => this.apply());
  }

  set(mode: ThemeMode): void {
    this.mode.set(mode);
    try {
      if (mode === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, mode);
    } catch {
      /* sin almacenamiento: el tema dura hasta recargar */
    }
    this.apply();
  }

  /** Tema efectivo (resuelve «sistema»). */
  effective(): 'light' | 'dark' {
    const m = this.mode();
    if (m !== 'system') return m;
    return this.media?.matches ? 'dark' : 'light';
  }

  private apply(): void {
    const root = document.documentElement;
    const m = this.mode();
    if (m === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', m);
    // Hay una meta por esquema (media=…); con un tema elegido, ambas toman su color.
    document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
      const scheme = m !== 'system' ? m : (meta.getAttribute('media') ?? '').includes('dark') ? 'dark' : 'light';
      meta.setAttribute('content', BAR[scheme]);
    });
  }
}
