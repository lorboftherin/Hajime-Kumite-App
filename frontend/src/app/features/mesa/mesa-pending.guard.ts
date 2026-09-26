import { inject } from '@angular/core';
import { CanDeactivateFn } from '@angular/router';
import { DialogService } from '../../core/dialog.service';
import { SessionExpiredService } from '../../core/session-expired.service';
import { plural } from '../../shared/plural';
import type { MesaPage } from './mesa';

/**
 * Al salir de la mesa con eventos sin enviar se pide confirmación. La cola queda guardada
 * en localStorage y se reanuda al volver.
 *
 * Si la sesión vence (se intenta ir a /login), la mesa NO se abandona a mitad de combate:
 * se bloquea la navegación y la mesa muestra su propio panel «Inicia sesión para seguir enviando».
 */
export const mesaPendingGuard: CanDeactivateFn<MesaPage> = (cmp, _route, _state, next) => {
  if (next?.url.startsWith('/login')) {
    if (inject(SessionExpiredService).notifyExpired()) return false;
    return true;
  }
  const n = cmp?.pending?.().length ?? 0;
  if (!n) return true;
  return inject(DialogService).confirm({
    title: 'Eventos sin enviar',
    message:
      n === 1
        ? 'Hay 1 evento sin enviar. Queda guardado en este dispositivo y se enviará al volver a abrir este combate. ¿Salir de todos modos?'
        : `Hay ${plural(n, 'evento', 'eventos')} sin enviar. Quedan guardados en este dispositivo y se enviarán al volver a abrir este combate. ¿Salir de todos modos?`,
    confirmText: 'Salir',
    danger: true,
  });
};
