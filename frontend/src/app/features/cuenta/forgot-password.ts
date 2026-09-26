import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiError } from '../../core/api-error';
import { ApiService } from '../../core/api.service';
import { AuthCard } from './auth-card';

/** «¿Olvidaste tu contraseña?»: pide el enlace. El servidor responde igual exista o no el correo. */
@Component({
  selector: 'app-forgot-password',
  imports: [FormsModule, AuthCard],
  template: `
    <app-auth-card
      id="fp"
      heading="Recupera tu cuenta"
      lead="Escribe el correo de tu cuenta y te enviaremos un enlace para crear una contraseña nueva."
    >
      @if (sent()) {
        <div class="alert ok" role="status">
          <strong>Revisa tu correo.</strong>
          <div class="small">{{ sent() }}</div>
          <div class="small">Si no llega en unos minutos, mira la carpeta de spam.</div>
        </div>
      } @else {
        <form class="stack" (ngSubmit)="submit()">
          <label class="field">
            <span>Correo</span>
            <input
              name="email"
              type="email"
              [(ngModel)]="email"
              autocomplete="email"
              required
              autofocus
            />
          </label>
          @if (error()) {
            <div class="alert danger" role="alert">{{ error() }}</div>
          }
          <button
            class="btn primary lg block"
            type="submit"
            [disabled]="busy() || !email().includes('@')"
          >
            @if (busy()) {
              <span class="spinner"></span>
            }
            Enviar enlace
          </button>
          <p class="small muted">
            ¿Tu cuenta no tiene correo? Pide a la organización que te asigne una contraseña
            temporal.
          </p>
        </form>
      }
    </app-auth-card>
  `,
})
export class ForgotPasswordPage {
  private api = inject(ApiService);
  readonly email = signal('');
  readonly busy = signal(false);
  readonly error = signal('');
  readonly sent = signal('');

  async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      const r = await firstValueFrom(
        this.api.post<{ message: string }>('/auth/forgot-password', { email: this.email().trim() }),
      );
      this.sent.set(r.message);
    } catch (e) {
      this.error.set(ApiError.from(e).fullMessage);
    } finally {
      this.busy.set(false);
    }
  }
}
