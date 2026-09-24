import { Component, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiError } from '../core/api-error';
import { AuthService } from '../core/auth.service';
import { Modal } from './modal';

/**
 * Aviso no bloqueante antes de que venza la sesión + diálogo de reingreso en el mismo lugar.
 * Va una sola vez en App: no se pierde la página ni su estado (p. ej. la cola de la mesa).
 */
@Component({
  selector: 'app-session-guard',
  imports: [FormsModule, Modal],
  template: `
    @if (auth.isLoggedIn() && auth.expiringSoon() && !auth.reloginOpen() && !dismissed()) {
      <div class="session-warn alert warn" role="status">
        <span>Tu sesión vence en {{ auth.minutesLeft() }} min.</span>
        <button type="button" class="btn sm primary" (click)="auth.requestRelogin()">Volver a iniciar sesión</button>
        <button type="button" class="btn sm ghost" (click)="dismissed.set(true)" aria-label="Ocultar">✕</button>
      </div>
    }
    @if (auth.reloginOpen()) {
      <app-modal title="Volver a iniciar sesión" (closed)="close()">
        <p class="small muted">Tu sesión está por vencer. Ingresa tu contraseña para seguir en esta misma pantalla.</p>
        <form (ngSubmit)="submit()" class="stack">
          <label class="field">
            <span>Usuario</span>
            <input name="username" [(ngModel)]="username" autocomplete="username" required />
          </label>
          <label class="field">
            <span>Contraseña</span>
            <input name="password" type="password" [(ngModel)]="password" autocomplete="current-password" required autofocus />
          </label>
          @if (error()) {
            <div class="alert danger">{{ error() }}</div>
          }
          <div class="form-actions">
            <button type="button" class="btn" (click)="close()">Ahora no</button>
            <button class="btn primary" type="submit" [disabled]="busy() || !username() || !password()">
              @if (busy()) {
                <span class="spinner"></span>
              }
              Ingresar
            </button>
          </div>
        </form>
      </app-modal>
    }
  `,
  styles: `
    .session-warn {
      position: fixed;
      left: 50%;
      bottom: 1rem;
      transform: translateX(-50%);
      z-index: 1900;
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin: 0;
      box-shadow: var(--shadow-lg);
      max-width: calc(100vw - 2rem);
    }
  `,
})
export class SessionGuard {
  readonly auth = inject(AuthService);
  readonly username = signal('');
  readonly password = signal('');
  readonly busy = signal(false);
  readonly error = signal('');
  readonly dismissed = signal(false);

  constructor() {
    // Usuario actual prellenado; el aviso se rearma con cada token nuevo.
    effect(() => {
      this.auth.token();
      const u = this.auth.user();
      if (u) this.username.set(u.username);
      this.dismissed.set(false);
    });
  }

  close(): void {
    this.auth.reloginOpen.set(false);
    this.password.set('');
    this.error.set('');
  }

  async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.auth.login(this.username(), this.password());
      this.dismissed.set(false);
      this.close();
    } catch (e) {
      this.error.set(ApiError.from(e).fullMessage);
    } finally {
      this.busy.set(false);
    }
  }

}
