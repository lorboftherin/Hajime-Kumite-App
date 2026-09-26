import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { isMobileApp } from './server';

/**
 * Ajustes propios de la app del celular (Capacitor). En la web no hace nada:
 * los módulos de Capacitor se cargan solo cuando la app corre en el celular.
 */
@Injectable({ providedIn: 'root' })
export class MobileService {
  private router = inject(Router);

  async start(): Promise<void> {
    if (!isMobileApp) return;
    const { App } = await import('@capacitor/app');
    // Botón «atrás» de Android: vuelve a la pantalla anterior; en la primera, sale de la app.
    App.addListener('backButton', ({ canGoBack }) => {
      if (canGoBack && this.router.url !== '/torneos' && this.router.url !== '/login')
        history.back();
      else App.exitApp();
    });
  }
}
