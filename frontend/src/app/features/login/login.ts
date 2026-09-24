import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiError } from '../../core/api-error';
import { AuthService } from '../../core/auth.service';

@Component({
  selector: 'app-login',
  imports: [FormsModule],
  template: `
    <div class="wrap">
      <form class="card box" (ngSubmit)="submit()">
        <div class="brand">
          <span class="logo"><span class="aka"></span><span class="ao"></span></span>
          <div>
            <h1>Hajime</h1>
            <div class="muted small">Gestión de torneos de karate</div>
          </div>
        </div>
        <label class="field">
          <span>Usuario</span>
          <input name="username" [(ngModel)]="username" autocomplete="username" required autofocus />
        </label>
        <label class="field">
          <span>Contraseña</span>
          <input name="password" type="password" [(ngModel)]="password" autocomplete="current-password" required />
        </label>
        @if (error()) {
          <div class="alert danger">{{ error() }}</div>
        }
        <button class="btn primary lg" type="submit" [disabled]="busy() || !username() || !password()">
          @if (busy()) {
            <span class="spinner"></span>
          }
          Ingresar
        </button>
      </form>
    </div>
  `,
  styles: `
    .wrap {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 1rem;
      background: linear-gradient(135deg, var(--aka) 0 50%, var(--ao) 50% 100%);
    }
    .box {
      width: 100%;
      max-width: 380px;
      display: flex;
      flex-direction: column;
      gap: 1rem;
      padding: 2rem;
      box-shadow: var(--shadow-lg);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      h1 {
        margin: 0;
        font-size: 1.8rem;
      }
    }
    .logo {
      display: inline-flex;
      width: 42px;
      height: 42px;
      border-radius: 50%;
      overflow: hidden;
      border: 3px solid var(--gray-900);
      span {
        flex: 1;
      }
      .aka {
        background: var(--aka);
      }
      .ao {
        background: var(--ao);
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

  async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.auth.login(this.username(), this.password());
      const ret = this.route.snapshot.queryParamMap.get('returnUrl');
      this.router.navigateByUrl(ret && ret.startsWith('/') ? ret : '/torneos');
    } catch (e) {
      this.error.set(ApiError.from(e).fullMessage);
    } finally {
      this.busy.set(false);
    }
  }
}
