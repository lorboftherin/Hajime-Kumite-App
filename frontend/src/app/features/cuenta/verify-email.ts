import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiError } from '../../core/api-error';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { tokenFromUrl } from '../../core/cuentas';
import { AuthCard } from './auth-card';

/** Confirma el correo con el enlace recibido (`/verificar-correo#<token>`). No necesita sesión. */
@Component({
  selector: 'app-verify-email',
  imports: [AuthCard, RouterLink],
  template: `
    <app-auth-card
      i18n-heading="@@cuenta.verificar.confirmar-correo"
      id="ve"
      heading="Confirmar correo"
      [backLink]="next()"
      [backText]="nextText()"
    >
      @switch (state()) {
        @case ('busy') {
          <p i18n="@@cuenta.verificar.confirmando" class="row"
            ><span class="spinner"></span> Confirmando…</p
          >
        }
        @case ('ok') {
          <div class="alert ok" role="status">
            <strong i18n="@@cuenta.verificar.listo-correo-quedo-confirmado"
              >¡Listo! Tu correo quedó confirmado.</strong
            >
            <div i18n="@@cuenta.verificar.ya-puedes-recuperar-contrasena" class="small">
              Ya puedes recuperar tu contraseña con él y reclamar tu perfil deportivo.
            </div>
          </div>
          <a class="btn primary lg block" [routerLink]="next()">{{ nextText() }}</a>
        }
        @default {
          <div class="alert danger" role="alert">
            @if (error()) {
              {{ error() }}
            } @else {
              <ng-container i18n="@@cuenta.verificar.enlace-incompleto"
                >El enlace está incompleto. Ábrelo tal como llegó en el correo.</ng-container
              >
            }
          </div>
          <p i18n="@@cuenta.verificar.puedes-pedir-enlace-nuevo-desde" class="small muted">
            Puedes pedir un enlace nuevo desde «Mi cuenta» después de ingresar.
          </p>
        }
      }
    </app-auth-card>
  `,
})
export class VerifyEmailPage {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private router = inject(Router);
  readonly state = signal<'busy' | 'ok' | 'error'>('busy');
  readonly error = signal('');
  readonly next = signal('/login');
  readonly nextText = signal($localize`:@@cuenta.verificar.ingresar:Ingresar`);

  constructor() {
    const snap = inject(ActivatedRoute).snapshot;
    const token = tokenFromUrl(snap.fragment, snap.queryParamMap.get('token'));
    if (this.auth.isLoggedIn()) {
      this.next.set('/mis-perfiles');
      this.nextText.set($localize`:@@cuenta.verificar.ir-mis-perfiles:Ir a mis perfiles`);
    }
    if (!token) {
      this.state.set('error');
      return;
    }
    void this.router.navigate([], { replaceUrl: true, fragment: undefined, queryParams: {} });
    void this.confirm(token);
  }

  private async confirm(token: string): Promise<void> {
    try {
      await firstValueFrom(this.api.post('/auth/verify-email', { token }));
      this.state.set('ok');
      await this.auth.refreshMe();
    } catch (e) {
      this.error.set(ApiError.from(e).fullMessage);
      this.state.set('error');
    }
  }
}
