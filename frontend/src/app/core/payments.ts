import { Injectable, inject, signal } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { Observable, catchError, map, of, shareReplay, tap } from 'rxjs';
import { ApiService } from './api.service';
import { BillingConfig } from './models';

/**
 * ¿Están activos los cobros? (`HAJIME_PAYMENTS_ENABLED` en el servidor, apagado por decisión
 * del dueño; ver docs/cobros.md). Se lee una vez de `GET /billing/config` (sin sesión).
 *
 * Mientras no se sepa, o si la consulta falla, se considera apagado: lo que se oculta es
 * pagar, nunca una función del torneo. Con los cobros apagados la interfaz no muestra el menú
 * «Pagos», el aviso «tu plan vence», «Suscribirse», «Probar gratis», cupones, pagos,
 * comprobantes ni datos fiscales, y las rutas /pago/* y /pagos llevan al inicio.
 */
@Injectable({ providedIn: 'root' })
export class PaymentsService {
  private api = inject(ApiService);
  /** true solo si el servidor confirmó que los cobros están activos. */
  readonly enabled = signal(false);
  /** Configuración de cobros tal como la envía el servidor (null hasta cargarla). */
  readonly config = signal<BillingConfig | null>(null);
  private cached: Observable<boolean> | null = null;

  /** Carga la configuración (una sola vez por sesión de la app) y dice si hay cobros. */
  load(): Observable<boolean> {
    this.cached ??= this.api.get<BillingConfig>('/billing/config').pipe(
      tap((c) => this.config.set(c)),
      map((c) => paymentsEnabled(c)),
      catchError(() => {
        this.cached = null; // se vuelve a intentar en la próxima navegación
        return of(false);
      }),
      tap((on) => this.enabled.set(on)),
      shareReplay(1),
    );
    return this.cached;
  }
}

/** Los cobros solo cuentan como activos si el servidor lo dice explícitamente. */
export function paymentsEnabled(c: Pick<BillingConfig, 'payments_enabled'> | null | undefined) {
  return c?.payments_enabled === true;
}

/** Rutas de pago (/pago/*, /pagos): con los cobros apagados, al inicio. */
export const paymentsGuard: CanActivateFn = () => {
  const router = inject(Router);
  return inject(PaymentsService)
    .load()
    .pipe(map((on) => (on ? true : router.createUrlTree(['/']))));
};
