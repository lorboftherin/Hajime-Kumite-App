import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  ApplicationConfig,
  LOCALE_ID,
  provideBrowserGlobalErrorListeners,
  isDevMode,
} from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';

import { routes } from './app.routes';
import { authInterceptor, errorInterceptor } from './core/interceptors';
import { provideServiceWorker } from '@angular/service-worker';
import { environment } from '../environments/environment';
import { localeActual } from './core/i18n/idioma';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(withInterceptors([authInterceptor, errorInterceptor])),
    // es-PE, en-US o pt-BR según el idioma elegido antes del arranque (main.ts).
    { provide: LOCALE_ID, useFactory: localeActual },
    provideServiceWorker('ngsw-worker.js', {
      // En la app del celular la interfaz ya viene dentro de la app: no hace falta.
      enabled: !isDevMode() && !environment.mobile,
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
};
