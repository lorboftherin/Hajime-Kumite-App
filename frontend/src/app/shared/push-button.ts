import { Component, computed, inject, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PushService } from '../core/push.service';
import { Icon } from './icon';

/**
 * Botón «Avisarme» (campana). Se oculta en la app de Android, donde el WebView no tiene
 * Web Push (ver `app-push-hint`). Si el navegador no puede, al tocarlo explica por qué.
 * Quien lo usa hace el cambio con `PushService` al recibir `toggled`.
 */
@Component({
  selector: 'app-push-button',
  imports: [Icon],
  template: `
    @if (!push.hidden()) {
      <button
        type="button"
        class="btn sm push-btn"
        [class.on]="on()"
        [class.icon-only]="compact()"
        [disabled]="busy()"
        [attr.aria-pressed]="on()"
        [attr.aria-label]="aria()"
        [attr.title]="aria()"
        (click)="toggled.emit(!on())"
      >
        <app-icon name="bell" />
        @if (!compact()) {
          <span i18n="@@avisos.boton.avisando-avisarme">@if (on()) {Avisando} @else {Avisarme}</span>
        }
      </button>
    }
  `,
  styles: `
    .push-btn {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      &.on {
        border-color: var(--shu, #b8322a);
        color: var(--shu-ink, #8f241e);
        background: color-mix(in srgb, var(--shu, #b8322a) 8%, transparent);
      }
      &.icon-only {
        padding: 0.3rem 0.45rem;
      }
    }
  `,
})
export class PushButton {
  readonly push = inject(PushService);
  readonly on = input(false);
  readonly busy = input(false);
  readonly compact = input(false);
  /** Nombre de quien se sigue, para el lector de pantalla. */
  readonly label = input('');
  readonly toggled = output<boolean>();
  readonly aria = computed(() => {
    const who = this.label();
    if (this.on())
      return who
        ? $localize`:@@avisos.boton.dejar-recibir-avisos-de:Dejar de recibir avisos de ${who}:quien:`
        : $localize`:@@avisos.boton.dejar-recibir-avisos:Dejar de recibir avisos`;
    return who ? $localize`:@@avisos.boton.avisarme-de:Avisarme de ${who}:quien:` : $localize`:@@avisos.boton.avisarme:Avisarme`;
  });
}

/**
 * Aviso de una línea cuando este dispositivo no puede recibir avisos (app de Android,
 * iPhone sin instalar, navegador sin soporte), con enlace a las preferencias.
 */
@Component({
  selector: 'app-push-hint',
  imports: [RouterLink],
  template: `
    @if (visible()) {
      <p class="push-hint small" role="note">
        {{ push.message() }}
        @if (push.support() !== 'app') {
          <a i18n="@@avisos.boton.ajustes-avisos" routerLink="/avisos">Ajustes de avisos</a>
        }
      </p>
    }
  `,
  styles: `
    .push-hint {
      margin: 0.5rem 0;
      padding: 0.5rem 0.75rem;
      border-left: 3px solid var(--yamabuki, #c9a227);
      background: color-mix(in srgb, var(--yamabuki, #c9a227) 10%, transparent);
      border-radius: var(--radius-sm, 4px);
    }
  `,
})
export class PushHint {
  readonly push = inject(PushService);
  /** Mostrar también en navegadores que sí podrían (p. ej. iPhone sin instalar). */
  readonly always = input(true);
  readonly visible = computed(() => {
    const s = this.push.support();
    if (s === 'ok') return false;
    return this.always() || s === 'app';
  });
}
