import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiError } from '../../core/api-error';
import { AuthService } from '../../core/auth.service';
import { isMobileApp, serverUrl, setServerUrl } from '../../core/server';
import { AuthFrame } from '../../shared/auth-frame';
import { Enso, HajimeTagline, HajimeWord } from '../../shared/enso';

@Component({
  selector: 'app-login',
  imports: [FormsModule, AuthFrame, Enso, HajimeWord, HajimeTagline],
  template: `
    <app-auth-frame>
      <div class="login">
        <section class="intro">
          <div class="wordmark" role="img" aria-label="Hajime, torneos de karate">
            <app-enso class="mark" />
            <div class="words">
              <app-hajime-word class="word" />
              <app-hajime-tagline class="tag" />
            </div>
          </div>
          <p class="tagline">Organiza torneos con calma.<br />Registra cada combate con respeto.</p>
          <p class="sub">
            <span class="kanji" aria-hidden="true">始め</span> Gestión de torneos de karate · Perú
          </p>
        </section>

        <form class="card box" (ngSubmit)="submit()" aria-labelledby="login-title">
          <div>
            <h1 id="login-title">Ingresar</h1>
            <p class="muted small lead">Usa la cuenta que te entregó la organización.</p>
          </div>
          <label class="field">
            <span>Usuario</span>
            <input
              name="username"
              [(ngModel)]="username"
              autocomplete="username"
              required
              autofocus
            />
          </label>
          <label class="field">
            <span>Contraseña</span>
            <input
              name="password"
              type="password"
              [(ngModel)]="password"
              autocomplete="current-password"
              required
            />
          </label>
          @if (error()) {
            <div class="alert" [class.danger]="!locked()" [class.warn]="locked()" role="alert">
              @if (locked()) {
                <strong>Una pausa breve.</strong>
                <div>{{ error() }}</div>
                <div class="small muted-ink">
                  Por seguridad, los intentos se detienen unos minutos. Respira; tus datos están a
                  salvo.
                </div>
              } @else {
                {{ error() }}
              }
            </div>
          }
          <button
            class="btn primary lg block"
            type="submit"
            [disabled]="busy() || !username() || !password()"
          >
            @if (busy()) {
              <span class="spinner"></span>
            }
            Ingresar
          </button>
          @if (mobile) {
            <details class="server">
              <summary class="small muted">Servidor: {{ server() }}</summary>
              <label class="field">
                <span>Dirección del servidor</span>
                <input
                  name="server"
                  [ngModel]="server()"
                  (ngModelChange)="changeServer($event)"
                  inputmode="url"
                  autocapitalize="off"
                  spellcheck="false"
                  placeholder="https://hajime.lorboftherin.com"
                />
              </label>
              <p class="small muted">Solo cámbiala si la organización te dio otra dirección.</p>
            </details>
          }
        </form>
      </div>
    </app-auth-frame>
  `,
  styles: `
    .server {
      margin-top: 0.25rem;
      summary {
        cursor: pointer;
      }
      .field {
        margin-top: 0.75rem;
      }
    }
    .login {
      width: 100%;
      max-width: 1040px;
      display: grid;
      grid-template-columns: minmax(0, 1.1fr) minmax(0, 400px);
      align-items: center;
      gap: 4rem;
    }
    .intro {
      padding-left: 1rem;
    }
    .wordmark {
      display: flex;
      align-items: center;
      gap: 1.1rem;
      color: var(--sumi);
      .mark {
        width: 6.5rem;
        height: 6.5rem;
      }
      .words {
        display: flex;
        flex-direction: column;
        gap: 0.9rem;
      }
      .word {
        height: 4.3rem;
      }
      .tag {
        font-size: 1.05rem;
      }
    }
    .tagline {
      margin: 2rem 0 1.5rem;
      font-family: var(--font-display);
      font-weight: 500;
      font-size: 1.5rem;
      line-height: 1.6;
      color: var(--sumi-2);
    }
    .sub {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      font-size: var(--fs-14);
      color: var(--nezumi-ink);
      .kanji {
        font-family: var(--font-display);
        color: var(--shu-ink);
        letter-spacing: 0.1em;
        padding-right: 0.75rem;
        border-right: 1px solid var(--kasumi-2);
      }
    }
    .box {
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 1.15rem;
      padding: 2.5rem 2.25rem;
      margin: 0;
      border-radius: var(--radius-lg);
      background: color-mix(in srgb, var(--kinu) 92%, transparent);
      backdrop-filter: blur(3px);
      h1 {
        font-size: var(--fs-28);
        margin: 0 0 0.25rem;
      }
      .lead {
        margin: 0;
      }
      .alert {
        margin: 0;
      }
      .btn {
        margin-top: 0.5rem;
      }
    }
    .muted-ink {
      color: var(--sumi-2);
      margin-top: 0.25rem;
    }
    @media (max-width: 899px) {
      .login {
        grid-template-columns: 1fr;
        gap: 2.25rem;
        max-width: 420px;
      }
      .intro {
        padding: 0;
        text-align: center;
      }
      .wordmark {
        justify-content: center;
        .mark {
          width: 4rem;
          height: 4rem;
        }
        .words {
          align-items: flex-start;
        }
        .word {
          height: 2.9rem;
        }
        .tag {
          font-size: 0.8rem;
        }
      }
      .tagline {
        font-size: 1.15rem;
        margin: 1.25rem 0 0;
      }
      .sub {
        display: none;
      }
      .box {
        padding: 2rem 1.5rem;
      }
    }
  `,
})
export class LoginPage {
  private auth = inject(AuthService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  readonly username = signal('');
  readonly password = signal('');
  readonly busy = signal(false);
  readonly error = signal('');
  /** 429 TOO_MANY_ATTEMPTS: el servidor bloqueó temporalmente los intentos. */
  readonly locked = signal(false);
  /** App del celular: se puede apuntar a otro servidor (p. ej. pruebas vs. producción). */
  readonly mobile = isMobileApp;
  readonly server = signal(serverUrl());

  changeServer(url: string): void {
    setServerUrl(url);
    this.server.set(serverUrl());
  }

  async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    this.locked.set(false);
    try {
      await this.auth.login(this.username(), this.password());
      // Si la cuenta debe cambiar su contraseña, el authGuard lleva a /cambiar-clave (conservando returnUrl).
      const ret = this.route.snapshot.queryParamMap.get('returnUrl');
      this.router.navigateByUrl(ret && ret.startsWith('/') ? ret : '/'); // '/' decide: Torneos o Mi tatami
    } catch (e) {
      const err = ApiError.from(e);
      this.locked.set(err.status === 429 || err.code === 'TOO_MANY_ATTEMPTS');
      this.error.set(
        this.locked()
          ? err.message || 'Demasiados intentos fallidos. Espera unos minutos e intenta de nuevo.'
          : err.fullMessage,
      );
    } finally {
      this.busy.set(false);
    }
  }
}
