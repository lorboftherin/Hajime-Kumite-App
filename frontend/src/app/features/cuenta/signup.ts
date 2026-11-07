import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiError } from '../../core/api-error';
import { ApiService } from '../../core/api.service';
import { MIN_PASSWORD } from '../../core/passwords';
import { AuthCard } from './auth-card';

/**
 * Registro abierto de cuentas de competidor (adultos y padres, madres o apoderados).
 * Tras confirmar el correo se puede reclamar el perfil propio o el de un hijo o hija.
 */
@Component({
  selector: 'app-signup',
  imports: [FormsModule, AuthCard, RouterLink],
  template: `
    <app-auth-card
      i18n-lead="@@cuenta.crear.para-competidores-adultos-para"
      i18n-heading="@@cuenta.crear.crear-cuenta"
      id="su"
      heading="Crear cuenta"
      lead="Para competidores adultos y para padres, madres o apoderados de competidores menores."
    >
      @if (done()) {
        <div class="alert ok" role="status">
          <strong i18n="@@cuenta.crear.revisa-correo">Revisa tu correo.</strong>
          <div class="small">{{ done() }}</div>
        </div>
        <a i18n="@@cuenta.crear.ir-ingresar" class="btn primary lg block" routerLink="/login"
          >Ir a ingresar</a
        >
      } @else {
        <form class="stack" (ngSubmit)="submit()">
          <label class="field">
            <span i18n="@@cuenta.crear.nombre">Tu nombre</span>
            <input name="name" [(ngModel)]="name" autocomplete="name" required autofocus />
          </label>
          <label class="field">
            <span i18n="@@cuenta.crear.correo">Correo</span>
            <input name="email" type="email" [(ngModel)]="email" autocomplete="email" required />
          </label>
          <label class="field">
            <span i18n="@@cuenta.crear.contrasena-min">Contraseña (mín. {{ min }})</span>
            <input
              name="password"
              type="password"
              [(ngModel)]="password"
              autocomplete="new-password"
              required
            />
          </label>
          <label class="check">
            <input type="checkbox" name="terms" [(ngModel)]="accepted" />
            <span i18n="@@cuenta.crear.lei-como-usan-mis-datos-pagina">
              Leí cómo se usan mis datos en la página de <a routerLink="/privacidad">Privacidad</a>.
              Soy mayor de edad.
            </span>
          </label>
          @if (error()) {
            <div class="alert danger" role="alert">{{ error() }}</div>
          }
          <button
            class="btn primary lg block"
            type="submit"
            [disabled]="
              busy() ||
              !accepted() ||
              name().trim().length < 2 ||
              !email().includes('@') ||
              password().length < min
            "
          >
            @if (busy()) {
              <span class="spinner"></span>
            }
            <ng-container i18n="@@cuenta.crear.crear-cuenta-2"> Crear cuenta </ng-container></button
          >
        </form>
      }
    </app-auth-card>
  `,
  styles: `
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
  `,
})
export class SignupPage {
  private api = inject(ApiService);
  readonly min = MIN_PASSWORD;
  readonly name = signal('');
  readonly email = signal('');
  readonly password = signal('');
  readonly accepted = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly done = signal('');

  async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      const r = await firstValueFrom(
        this.api.post<{ message: string }>('/auth/signup', {
          email: this.email().trim(),
          password: this.password(),
          display_name: this.name().trim(),
        }),
      );
      this.done.set(r.message);
    } catch (e) {
      const err = ApiError.from(e);
      this.error.set(
        err.code === 'SIGNUP_CLOSED'
          ? $localize`:@@cuenta.crear.registro-cuentas-aun-no-esta:El registro de cuentas aún no está abierto.`
          : err.fullMessage,
      );
    } finally {
      this.busy.set(false);
    }
  }
}
