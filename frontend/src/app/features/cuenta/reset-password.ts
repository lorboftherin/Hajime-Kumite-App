import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiError } from '../../core/api-error';
import { ApiService } from '../../core/api.service';
import { tokenFromUrl } from '../../core/cuentas';
import { MIN_PASSWORD } from '../../core/passwords';
import { ToastService } from '../../core/toast.service';
import { AuthCard } from './auth-card';

/**
 * Crear una contraseña nueva con el enlace del correo (`/restablecer-clave#<token>`).
 * El token va en el fragmento para que no llegue a los logs; se quita de la barra de direcciones.
 */
@Component({
  selector: 'app-reset-password',
  imports: [FormsModule, AuthCard, RouterLink],
  template: `
    <app-auth-card
      id="rp"
      heading="Contraseña nueva"
      lead="Al guardarla se cierran todas tus sesiones abiertas."
    >
      @if (!token) {
        <div class="alert danger" role="alert">
          El enlace está incompleto. Ábrelo tal como llegó en el correo o
          <a routerLink="/recuperar-clave">pide uno nuevo</a>.
        </div>
      } @else {
        <form class="stack" (ngSubmit)="submit()">
          <label class="field">
            <span>Contraseña nueva (mín. {{ min }})</span>
            <input
              name="p1"
              type="password"
              [(ngModel)]="password"
              autocomplete="new-password"
              required
              autofocus
            />
          </label>
          <label class="field">
            <span>Repite la contraseña</span>
            <input
              name="p2"
              type="password"
              [(ngModel)]="confirm"
              autocomplete="new-password"
              required
            />
          </label>
          @if (confirm() && confirm() !== password()) {
            <p class="small danger-text" role="status">Las contraseñas no coinciden.</p>
          }
          @if (error()) {
            <div class="alert danger" role="alert">
              {{ error() }}
              @if (expired()) {
                <div><a routerLink="/recuperar-clave">Pedir un enlace nuevo</a></div>
              }
            </div>
          }
          <button
            class="btn primary lg block"
            type="submit"
            [disabled]="busy() || password().length < min || password() !== confirm()"
          >
            @if (busy()) {
              <span class="spinner"></span>
            }
            Guardar contraseña
          </button>
        </form>
      }
    </app-auth-card>
  `,
  styles: `
    .danger-text {
      color: var(--shu-ink);
      margin: 0;
    }
  `,
})
export class ResetPasswordPage {
  private api = inject(ApiService);
  private router = inject(Router);
  private toast = inject(ToastService);
  readonly min = MIN_PASSWORD;
  readonly token: string;
  readonly password = signal('');
  readonly confirm = signal('');
  readonly busy = signal(false);
  readonly error = signal('');
  readonly expired = signal(false);

  constructor() {
    const snap = inject(ActivatedRoute).snapshot;
    this.token = tokenFromUrl(snap.fragment, snap.queryParamMap.get('token'));
    if (this.token)
      void this.router.navigate([], { replaceUrl: true, fragment: undefined, queryParams: {} });
  }

  async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    this.expired.set(false);
    try {
      await firstValueFrom(
        this.api.post<void>('/auth/reset-password', {
          token: this.token,
          new_password: this.password(),
        }),
      );
      this.toast.ok('Contraseña guardada. Ingresa con la nueva.');
      await this.router.navigate(['/login']);
    } catch (e) {
      const err = ApiError.from(e);
      this.expired.set(err.code === 'INVALID_TOKEN');
      this.error.set(err.fullMessage);
    } finally {
      this.busy.set(false);
    }
  }
}
