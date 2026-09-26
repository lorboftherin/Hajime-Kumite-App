import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiError } from '../../core/api-error';
import { AuthService } from '../../core/auth.service';
import { User } from '../../core/models';
import { MutationService } from '../../core/mutation.service';
import { Icon } from '../../shared/icon';
import { LanguageSelect } from '../../shared/language-select';
import { PageHead } from '../../shared/page-head';

/** Mi cuenta: nombre visible y correo (con su verificación). */
@Component({
  selector: 'app-account',
  imports: [FormsModule, RouterLink, PageHead, Icon, LanguageSelect],
  template: `
    <div class="container narrow">
      <app-page-head i18n-title="@@cuenta.mi-cuenta" kanji="私" title="Mi cuenta">
        <div meta class="meta-line">
          <span i18n="@@cuenta.sesion">Sesión: {{ auth.user()?.username }}</span>
        </div>
      </app-page-head>

      <section class="card stack">
        <h2 i18n="@@cuenta.correo" class="h3">Correo</h2>
        @if (auth.user()?.email; as email) {
          <p class="row">
            <span class="mono grow">{{ email }}</span>
            @if (auth.user()?.email_verified_at) {
              <span i18n="@@cuenta.verificado" class="badge matcha">Verificado</span>
            } @else {
              <span i18n="@@cuenta.sin-verificar" class="badge yamabuki">Sin verificar</span>
            }
          </p>
          @if (!auth.user()?.email_verified_at) {
            <div class="alert warn"><ng-container i18n="@@cuenta.confirma-correo-enlace-te">
              Confirma tu correo con el enlace que te enviamos. Sin eso no puedes recuperar la
              contraseña ni reclamar perfiles.
              </ng-container><div>
                <button i18n="@@cuenta.enviar-otro-enlace" class="btn sm" type="button" (click)="resend()" [disabled]="busy()">
                  Enviar otro enlace
                </button>
              </div>
            </div>
          }
        } @else {
          <p i18n="@@cuenta.cuenta-no-tiene-correo-agregalo" class="muted small">
            Tu cuenta no tiene correo. Agrégalo para poder recuperar tu contraseña.
          </p>
        }
        <form class="stack" (ngSubmit)="saveEmail()">
          <label class="field">
            <span i18n="@@cuenta.cambiar-correo-correo">@if (auth.user()?.email) {Cambiar correo} @else {Correo}</span>
            <input name="email" type="email" [(ngModel)]="email" autocomplete="email" />
          </label>
          <label class="field">
            <span i18n="@@cuenta.contrasena-actual-para-confirmar">Tu contraseña actual (para confirmar)</span>
            <input
              name="pw"
              type="password"
              [(ngModel)]="password"
              autocomplete="current-password"
            />
          </label>
          @if (error()) {
            <div class="alert danger" role="alert">{{ error() }}</div>
          }
          <div class="form-actions">
            <button i18n="@@cuenta.guardar-correo"
              class="btn primary"
              [disabled]="busy() || !email().includes('@') || !password()"
            >
              Guardar correo
            </button>
          </div>
        </form>
      </section>

      <section class="card stack">
        <h2 i18n="@@cuenta.nombre-visible" class="h3">Nombre visible</h2>
        <form class="row" (ngSubmit)="saveName()">
          <input i18n-aria-label="@@cuenta.nombre-visible-2"
            class="grow"
            name="name"
            [(ngModel)]="name"
            autocomplete="name"
            aria-label="Nombre visible"
          />
          <button i18n="@@cuenta.guardar" class="btn" [disabled]="busy() || !name().trim()">Guardar</button>
        </form>
      </section>

      <section class="card stack">
        <h2 i18n="@@cuenta.idioma" class="h3">Idioma</h2>
        <p i18n="@@cuenta.idioma-hajime-este-dispositivo" class="muted small">
          El idioma de Hajime en este dispositivo. Al cambiarlo, la aplicación se vuelve a cargar.
        </p>
        <div><app-language-select /></div>
      </section>

      <section class="card links">
        <a i18n="@@cuenta.mis-perfiles-deportivos" routerLink="/mis-perfiles"><app-icon name="open" /> Mis perfiles deportivos</a>
        <a i18n="@@cuenta.avisos-este-dispositivo" routerLink="/avisos"><app-icon name="bell" /> Avisos en este dispositivo</a>
        <a i18n="@@cuenta.cambiar-contrasena" routerLink="/cambiar-clave"><app-icon name="key" /> Cambiar contraseña</a>
        <a i18n="@@cuenta.privacidad-datos-muestran-quien" routerLink="/privacidad"
          ><app-icon name="open" /> Privacidad: qué datos se muestran y a quién</a
        >
        <a i18n="@@cuenta.borrar-mi-cuenta" routerLink="/mi-cuenta" class="danger"><app-icon name="close" /> Borrar mi cuenta</a>
      </section>
    </div>
  `,
  styles: `
    .narrow {
      max-width: 720px;
    }
    .h3 {
      margin: 0;
      font-size: var(--fs-20, 1.25rem);
    }
    .links {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      a {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
      }
      .danger {
        color: var(--shu-ink);
      }
    }
  `,
})
export class AccountPage {
  readonly auth = inject(AuthService);
  private mut = inject(MutationService);
  readonly email = signal('');
  readonly password = signal('');
  readonly name = signal(this.auth.user()?.display_name ?? '');
  readonly busy = signal(false);
  readonly error = signal('');

  constructor() {
    void this.auth.refreshMe();
  }

  private async patch(body: Record<string, unknown>, success: string): Promise<User | undefined> {
    this.busy.set(true);
    this.error.set('');
    try {
      return await this.mut.patch<User>('/auth/me', body, {
        success,
        onError: (err: ApiError) => {
          this.error.set(err.fullMessage);
          return true;
        },
      });
    } finally {
      this.busy.set(false);
      await this.auth.refreshMe();
    }
  }

  async saveEmail(): Promise<void> {
    const r = await this.patch(
      { email: this.email().trim(), current_password: this.password() },
      $localize`:@@cuenta.correo-guardado-te-enviamos:Correo guardado. Te enviamos un enlace para confirmarlo.`,
    );
    if (r) {
      this.email.set('');
      this.password.set('');
    }
  }

  async saveName(): Promise<void> {
    await this.patch({ display_name: this.name().trim() }, $localize`:@@cuenta.nombre-guardado:Nombre guardado`);
  }

  async resend(): Promise<void> {
    this.busy.set(true);
    await this.mut.post(
      '/auth/verify-email/resend',
      {},
      { success: $localize`:@@cuenta.te-enviamos-enlace-nuevo:Te enviamos un enlace nuevo` },
    );
    this.busy.set(false);
  }
}
