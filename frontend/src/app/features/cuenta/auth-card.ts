import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthFrame } from '../../shared/auth-frame';
import { Wordmark } from '../../shared/enso';
import { Icon } from '../../shared/icon';

/**
 * Tarjeta de las pantallas de acceso sin sesión (recuperar clave, crear cuenta, verificar
 * correo): fondo washi con ensō, marca arriba y el contenido en una tarjeta.
 */
@Component({
  selector: 'app-auth-card',
  imports: [AuthFrame, Wordmark, Icon, RouterLink],
  template: `
    <app-auth-frame>
      <div class="wrap">
        <a i18n-aria-label="@@cuenta.acceso.hajime-ingresar" routerLink="/login" class="brand-link" aria-label="Hajime, ingresar"
          ><app-wordmark class="brand"
        /></a>
        <section class="card box" [attr.aria-labelledby]="'t-' + id()">
          <div>
            <h1 [id]="'t-' + id()">{{ heading() }}</h1>
            @if (lead()) {
              <p class="muted small lead">{{ lead() }}</p>
            }
          </div>
          <ng-content />
          <div class="foot">
            <a class="back-link" [routerLink]="backLink()"
              ><app-icon name="back" /> {{ backText() }}</a
            >
            <a i18n="@@cuenta.acceso.privacidad" class="small muted" routerLink="/privacidad">Privacidad</a>
          </div>
        </section>
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
    .brand-link {
      color: inherit;
      text-decoration: none;
    }
    .brand {
      font-size: 1.6rem;
    }
    .box {
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 1rem;
      margin: 0;
    }
    h1 {
      margin: 0 0 0.25rem;
    }
    .lead {
      margin: 0;
    }
    .foot {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
    }
  `,
})
export class AuthCard {
  readonly id = input('auth');
  readonly heading = input.required<string>();
  readonly lead = input('');
  readonly backLink = input('/login');
  readonly backText = input($localize`:@@cuenta.acceso.volver-ingresar:Volver a ingresar`);
}
