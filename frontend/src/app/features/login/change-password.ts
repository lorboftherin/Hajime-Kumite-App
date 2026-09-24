import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiError } from '../../core/api-error';
import { AuthService } from '../../core/auth.service';
import { MIN_PASSWORD, passwordFormError } from '../../core/passwords';
import { ToastService } from '../../core/toast.service';

@Component({
  selector: 'app-change-password',
  imports: [FormsModule, RouterLink],
  template: `
    <div class="wrap">
      <form class="card box" (ngSubmit)="submit()">
        <div>
          <h1>Cambiar contraseña</h1>
          <div class="muted small">Sesión: {{ auth.user()?.username }}</div>
        </div>
        @if (forced()) {
          <div class="alert info">
            <strong>Tu contraseña fue asignada por el administrador; elige una nueva.</strong>
            <div class="small">Así solo tú la conocerás. Usa la contraseña que te entregaron como "contraseña actual".</div>
          </div>
        }
        <label class="field">
          <span>Contraseña actual</span>
          <input name="current" type="password" [(ngModel)]="current" autocomplete="current-password" required autofocus />
        </label>
        <label class="field">
          <span>Nueva contraseña (mín. {{ min }} caracteres)</span>
          <input name="next" type="password" [(ngModel)]="next" autocomplete="new-password" required [minlength]="min" />
        </label>
        <label class="field">
          <span>Repite la nueva contraseña</span>
          <input name="confirm" type="password" [(ngModel)]="confirm" autocomplete="new-password" required />
        </label>
        @if (touched() && problem()) {
          <div class="error-text small">{{ problem() }}</div>
        }
        @if (error()) {
          <div class="alert danger">{{ error() }}</div>
        }
        <button class="btn primary lg" type="submit" [disabled]="busy()">
          @if (busy()) {
            <span class="spinner"></span>
          }
          Guardar nueva contraseña
        </button>
        <div class="row small">
          @if (!forced()) {
            <a routerLink="/torneos">← Volver</a>
          }
          <span class="grow"></span>
          <button type="button" class="btn ghost sm" (click)="auth.logout(false); router.navigate(['/login'])">Cerrar sesión</button>
        </div>
        <p class="hint">Al cambiarla se cierran tus sesiones abiertas en otros equipos.</p>
      </form>
    </div>
  `,
  styles: `
    .wrap {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 1rem;
      background: var(--bg);
    }
    .box {
      width: 100%;
      max-width: 420px;
      display: flex;
      flex-direction: column;
      gap: 1rem;
      padding: 2rem;
      box-shadow: var(--shadow-lg);
      border-top: 4px solid var(--aka);
      h1 {
        margin: 0;
      }
    }
    .alert {
      margin: 0;
    }
  `,
})
export class ChangePasswordPage {
  readonly auth = inject(AuthService);
  readonly router = inject(Router);
  private route = inject(ActivatedRoute);
  private toast = inject(ToastService);

  readonly min = MIN_PASSWORD;
  readonly current = signal('');
  readonly next = signal('');
  readonly confirm = signal('');
  readonly busy = signal(false);
  readonly error = signal('');
  readonly touched = signal(false);
  /** Se fija al entrar: tras guardar, must_change_password pasa a false. */
  readonly forced = signal(this.auth.mustChangePassword());
  readonly problem = computed(() => passwordFormError(this.current(), this.next(), this.confirm()));

  async submit(): Promise<void> {
    this.touched.set(true);
    this.error.set('');
    if (this.problem()) return;
    this.busy.set(true);
    try {
      await this.auth.changePassword(this.current(), this.next());
      this.toast.ok('Contraseña actualizada');
      const ret = this.route.snapshot.queryParamMap.get('returnUrl');
      this.router.navigateByUrl(ret && ret.startsWith('/') && !ret.startsWith('/cambiar-clave') ? ret : '/torneos');
    } catch (e) {
      this.error.set(ApiError.from(e).fullMessage);
    } finally {
      this.busy.set(false);
    }
  }
}
