import { Injectable, computed, signal } from '@angular/core';

/**
 * Sesión vencida en pantallas que no deben abandonarse (la mesa a mitad de combate).
 *
 * Una pantalla «retiene» la sesión con `hold()` mientras está abierta. Si la sesión vence
 * (falla el refresco del token o el servidor responde 401), en lugar de ir a /login se marca
 * `expired` y la propia pantalla muestra un panel para volver a ingresar; su estado (p. ej.
 * la cola de eventos sin enviar) se conserva.
 *
 * Integración: ante un 401 sin renovación posible, interceptors.ts y la renovación de
 * auth.service.ts llaman a `notifyExpired()`; si devuelve true cierran la sesión sin
 * redirigir, porque la pantalla se encarga. La guarda de la mesa (mesa-pending.guard.ts)
 * además bloquea la navegación a /login como respaldo.
 */
@Injectable({ providedIn: 'root' })
export class SessionExpiredService {
  private readonly holders = signal(0);
  /** Hay una pantalla que se encarga del reingreso. */
  readonly held = computed(() => this.holders() > 0);
  /** La sesión venció con una pantalla retenida: debe mostrarse el panel de ingreso. */
  readonly expired = signal(false);

  /** Retiene la sesión mientras la pantalla está abierta; devuelve la función para soltarla. */
  hold(): () => void {
    this.holders.update((n) => n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holders.update((n) => Math.max(0, n - 1));
      if (!this.held()) this.expired.set(false);
    };
  }

  /** La sesión venció. true = una pantalla lo maneja (no navegar a /login). */
  notifyExpired(): boolean {
    if (!this.held()) return false;
    this.expired.set(true);
    return true;
  }

  /** Se volvió a ingresar: la pantalla retoma su trabajo. */
  resolved(): void {
    this.expired.set(false);
  }
}
