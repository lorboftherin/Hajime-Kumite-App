import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiError } from '../../core/api-error';
import { AuthService } from '../../core/auth.service';
import { AuthFrame } from '../../shared/auth-frame';
import { Wordmark } from '../../shared/enso';
import { Icon } from '../../shared/icon';
import { MIN_PASSWORD, passwordFormError } from '../../core/passwords';
import { ToastService } from '../../core/toast.service';

@Component({
  selector: 'app-change-password',
  imports: [FormsModule, RouterLink, AuthFrame, Wordmark, Icon],
  template: `
    <app-auth-frame>
      <div class="wrap">
        <app-wordmark class="brand" />
        <form class="card box" (ngSubmit)="submit()" aria-labelledby="cp-title">
          <div>
            <h1 i18n="@@clave.cambiar.cambiar-contrasena" id="cp-title">Cambiar contraseña</h1>
            <p i18n="@@clave.cambiar.sesion" class="muted small lead">Sesión: {{ auth.user()?.username }}</p>
          </div>
          @if (forced()) {
            <div class="alert info">
              <strong i18n="@@clave.cambiar.contrasena-fue-asignada">Tu contraseña fue asignada por el administrador; elige una nueva.</strong>
              <div i18n="@@clave.cambiar.asi-solo-conoceras-usa" class="small">Así solo tú la conocerás. Usa la contraseña que te entregaron como "contraseña actual".</div>
            </div>
          }
          <label class="field">
            <span i18n="@@clave.cambiar.contrasena-actual">Contraseña actual</span>
            <input name="current" type="password" [(ngModel)]="current" autocomplete="current-password" required autofocus />
          </label>
          <label class="field">
            <span i18n="@@clave.cambiar.nueva-contrasena-min-caracteres">Nueva contraseña (mín. {{ min }} caracteres)</span>
            <input name="next" type="password" [(ngModel)]="next" autocomplete="new-password" required [minlength]="min" />
          </label>
          <label class="field">
            <span i18n="@@clave.cambiar.repite-nueva-contrasena">Repite la nueva contraseña</span>
            <input name="confirm" type="password" [(ngModel)]="confirm" autocomplete="new-password" required />
          </label>
          @if (touched() && problem()) {
            <div class="error-text small">{{ problem() }}</div>
          }
          @if (error()) {
            <div class="alert danger">{{ error() }}</div>
          }
          <button class="btn primary lg block" type="submit" [disabled]="busy()">
            @if (busy()) {
              <span class="spinner"></span>
            }<ng-container i18n="@@clave.cambiar.guardar-nueva-contrasena">
            Guardar nueva contraseña
          </ng-container></button>
          <p i18n="@@clave.cambiar.cambiarla-cierran-tus-sesiones" class="hint">Al cambiarla se cierran tus sesiones abiertas en otros equipos.</p>
          <div class="foot">
            @if (!forced()) {
              <a i18n="@@clave.cambiar.volver" class="back-link" routerLink="/torneos"><app-icon name="back" /> Volver</a>
            }
            <span class="grow"></span>
            <button i18n="@@clave.cambiar.salir" type="button" class="btn ghost sm" (click)="auth.logout(false); router.navigate(['/login'])"><app-icon name="logout" /> Salir</button>
          </div>
        </form>
      </div>
    </app-auth-frame>
  `,
  styles: `
    .wrap {
      width: 100%;
      max-width: 440px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2rem;
    }
    .brand {
      font-size: 1.6rem;
    }
    .box {
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 1.1rem;
      padding: 2.25rem 2rem 1.5rem;
      margin: 0;
      border-radius: var(--radius-lg);
      background: color-mix(in srgb, var(--kinu) 92%, transparent);
      backdrop-filter: blur(3px);
      h1 {
        font-size: var(--fs-28);
        margin: 0 0 0.25rem;
      }
      .lead,
      .hint,
      .alert {
        margin: 0;
      }
    }
    .foot {
      display: flex;
      align-items: center;
      padding-top: 0.75rem;
      border-top: 1px solid var(--kasumi);
      .back-link {
        margin: 0;
      }
    }
    @media (max-width: 767px) {
      .box {
        padding: 1.75rem 1.25rem 1.25rem;
      }
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
      this.toast.ok($localize`:@@clave.cambiar.contrasena-actualizada:Contraseña actualizada`);
      const ret = this.route.snapshot.queryParamMap.get('returnUrl');
      this.router.navigateByUrl(ret && ret.startsWith('/') && !ret.startsWith('/cambiar-clave') ? ret : '/torneos');
    } catch (e) {
      this.error.set(ApiError.from(e).fullMessage);
    } finally {
      this.busy.set(false);
    }
  }
}
