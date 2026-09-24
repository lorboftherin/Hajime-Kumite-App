import { inject } from '@angular/core';
import { CanDeactivateFn } from '@angular/router';
import { DialogService } from '../../core/dialog.service';
import type { MesaPage } from './mesa';

/**
 * Al salir de la mesa con eventos sin enviar se pide confirmación. La cola queda guardada
 * en localStorage y se reanuda al volver; ir a /login (sesión vencida) no se bloquea.
 */
export const mesaPendingGuard: CanDeactivateFn<MesaPage> = (cmp, _route, _state, next) => {
  const n = cmp?.pending?.().length ?? 0;
  if (!n) return true;
  if (next?.url.startsWith('/login')) return true;
  return inject(DialogService).confirm({
    title: 'Eventos sin enviar',
    message: `Hay ${n} evento(s) sin enviar. Quedan guardados en este dispositivo y se enviarán al volver a abrir este combate. ¿Salir de todos modos?`,
    confirmText: 'Salir',
    danger: true,
  });
};
