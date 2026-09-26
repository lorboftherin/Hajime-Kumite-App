import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ApiError } from '../../core/api-error';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { AuthFrame } from '../../shared/auth-frame';
import { Wordmark } from '../../shared/enso';
import { Icon } from '../../shared/icon';

/**
 * Borrar la propia cuenta. Las tiendas de apps exigen que se pueda desde la
 * app. Se borra la cuenta de acceso; el historial deportivo de la persona
 * pertenece a los torneos y solo lo anonimiza el organizador (sección 11).
 */
@Component({
  selector: 'app-delete-account',
  imports: [FormsModule, RouterLink, AuthFrame, Wordmark, Icon],
  template: `
    <app-auth-frame>
      <div class="wrap">
        <app-wordmark class="brand" />
        <form class="card box" (ngSubmit)="submit()" aria-labelledby="da-title">
          <div>
            <h1 i18n="@@cuenta.borrar.borrar-mi-cuenta" id="da-title">Borrar mi cuenta</h1>
            <p i18n="@@cuenta.borrar.sesion" class="muted small lead">Sesión: {{ auth.user()?.username }}</p>
          </div>
          <div class="alert warn">
            <strong i18n="@@cuenta.borrar.esto-no-puede-deshacer">Esto no se puede deshacer.</strong>
            <div i18n="@@cuenta.borrar.borra-cuenta-acceso-cierran-tus" class="small">
              Se borra tu cuenta de acceso y se cierran tus sesiones. Los resultados de los torneos
              no cambian: pertenecen a cada torneo y a tu dojo. Si además quieres que tu nombre deje
              de aparecer en ellos, pídeselo a la organización.
            </div>
          </div>
          <label class="field">
            <span i18n="@@cuenta.borrar.confirma-contrasena">Confirma con tu contraseña</span>
            <input
              name="password"
              type="password"
              [(ngModel)]="password"
              autocomplete="current-password"
              required
              autofocus
            />
          </label>
          <label class="check">
            <input type="checkbox" name="sure" [(ngModel)]="sure" />
            <span i18n="@@cuenta.borrar.entiendo-mi-cuenta-borrara-forma">Entiendo que mi cuenta se borrará de forma definitiva.</span>
          </label>
          @if (error()) {
            <div class="alert danger">{{ error() }}</div>
          }
          <button
            class="btn danger lg block"
            type="submit"
            [disabled]="busy() || !sure() || !password()"
          >
            @if (busy()) {
              <span class="spinner"></span>
            }<ng-container i18n="@@cuenta.borrar.borrar-mi-cuenta-2">
            Borrar mi cuenta
          </ng-container></button>
          <div class="foot">
            <a i18n="@@cuenta.borrar.volver" class="back-link" routerLink="/torneos"><app-icon name="back" /> Volver</a>
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
      gap: 1rem;
    }
    h1 {
      margin: 0 0 0.25rem;
    }
    .lead {
      margin: 0;
    }
    .check {
      display: flex;
      gap: 0.6rem;
      align-items: flex-start;
      font-size: var(--fs-14);
      input {
        width: auto;
        margin-top: 0.2rem;
      }
    }
    .foot {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
  `,
})
export class DeleteAccountPage {
  readonly auth = inject(AuthService);
  private router = inject(Router);
  private toast = inject(ToastService);
  readonly password = signal('');
  readonly sure = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');

  async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.auth.deleteAccount(this.password());
      this.toast.ok($localize`:@@cuenta.borrar.cuenta-fue-borrada:Tu cuenta fue borrada`);
      this.router.navigate(['/login']);
    } catch (e) {
      this.error.set(ApiError.from(e).fullMessage);
    } finally {
      this.busy.set(false);
    }
  }
}
