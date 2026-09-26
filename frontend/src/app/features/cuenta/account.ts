import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiError } from '../../core/api-error';
import { AuthService } from '../../core/auth.service';
import { User } from '../../core/models';
import { MutationService } from '../../core/mutation.service';
import { Icon } from '../../shared/icon';
import { PageHead } from '../../shared/page-head';

/** Mi cuenta: nombre visible y correo (con su verificación). */
@Component({
  selector: 'app-account',
  imports: [FormsModule, RouterLink, PageHead, Icon],
  template: `
    <div class="container narrow">
      <app-page-head kanji="私" title="Mi cuenta">
        <div meta class="meta-line">
          <span>Sesión: {{ auth.user()?.username }}</span>
        </div>
      </app-page-head>

      <section class="card stack">
        <h2 class="h3">Correo</h2>
        @if (auth.user()?.email; as email) {
          <p class="row">
            <span class="mono grow">{{ email }}</span>
            @if (auth.user()?.email_verified_at) {
              <span class="badge matcha">Verificado</span>
            } @else {
              <span class="badge yamabuki">Sin verificar</span>
            }
          </p>
          @if (!auth.user()?.email_verified_at) {
            <div class="alert warn">
              Confirma tu correo con el enlace que te enviamos. Sin eso no puedes recuperar la
              contraseña ni reclamar perfiles.
              <div>
                <button class="btn sm" type="button" (click)="resend()" [disabled]="busy()">
                  Enviar otro enlace
                </button>
              </div>
            </div>
          }
        } @else {
          <p class="muted small">
            Tu cuenta no tiene correo. Agrégalo para poder recuperar tu contraseña.
          </p>
        }
        <form class="stack" (ngSubmit)="saveEmail()">
          <label class="field">
            <span>{{ auth.user()?.email ? 'Cambiar correo' : 'Correo' }}</span>
            <input name="email" type="email" [(ngModel)]="email" autocomplete="email" />
          </label>
          <label class="field">
            <span>Tu contraseña actual (para confirmar)</span>
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
            <button
              class="btn primary"
              [disabled]="busy() || !email().includes('@') || !password()"
            >
              Guardar correo
            </button>
          </div>
        </form>
      </section>

      <section class="card stack">
        <h2 class="h3">Nombre visible</h2>
        <form class="row" (ngSubmit)="saveName()">
          <input
            class="grow"
            name="name"
            [(ngModel)]="name"
            autocomplete="name"
            aria-label="Nombre visible"
          />
          <button class="btn" [disabled]="busy() || !name().trim()">Guardar</button>
        </form>
      </section>

      <section class="card links">
        <a routerLink="/mis-perfiles"><app-icon name="open" /> Mis perfiles deportivos</a>
        <a routerLink="/cambiar-clave"><app-icon name="key" /> Cambiar contraseña</a>
        <a routerLink="/privacidad"
          ><app-icon name="open" /> Privacidad: qué datos se muestran y a quién</a
        >
        <a routerLink="/mi-cuenta" class="danger"><app-icon name="close" /> Borrar mi cuenta</a>
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
      'Correo guardado. Te enviamos un enlace para confirmarlo.',
    );
    if (r) {
      this.email.set('');
      this.password.set('');
    }
  }

  async saveName(): Promise<void> {
    await this.patch({ display_name: this.name().trim() }, 'Nombre guardado');
  }

  async resend(): Promise<void> {
    this.busy.set(true);
    await this.mut.post(
      '/auth/verify-email/resend',
      {},
      { success: 'Te enviamos un enlace nuevo' },
    );
    this.busy.set(false);
  }
}
