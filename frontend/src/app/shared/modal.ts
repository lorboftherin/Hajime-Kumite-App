import { Component, input, output } from '@angular/core';
import { FocusTrap } from './focus-trap';
import { Icon } from './icon';

/**
 * Modal con contenido proyectado. Se muestra con @if desde el padre.
 * Atrapa el foco mientras está abierto y lo devuelve al cerrar; Escape cierra
 * salvo con `[closeOnEscape]="false"` (acciones críticas).
 */
@Component({
  selector: 'app-modal',
  imports: [Icon, FocusTrap],
  template: `
    <div class="modal-backdrop" (click)="onBackdrop($event)" (keydown.escape)="onEscape($event)">
      <div
        class="modal"
        [class.wide]="wide()"
        role="dialog"
        aria-modal="true"
        [attr.aria-label]="title()"
        appFocusTrap
      >
        <div class="head">
          <h2>{{ title() }}</h2>
          <button
            i18n-aria-label="@@modal.cerrar"
            type="button"
            class="btn ghost sm icon-only close"
            (click)="closed.emit()"
            aria-label="Cerrar"
            ><app-icon name="close"
          /></button>
        </div>
        <ng-content />
      </div>
    </div>
  `,
  styles: `
    .head {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 1rem;
      margin-bottom: var(--space-4) !important;
    }
    .close {
      margin: -0.35rem -0.6rem 0 0;
      font-size: 1.1rem;
    }
  `,
})
export class Modal {
  readonly title = input('');
  readonly wide = input(false);
  readonly closeOnEscape = input(true);
  readonly closed = output<void>();

  onEscape(ev: Event): void {
    if (!this.closeOnEscape()) return;
    ev.stopPropagation();
    this.closed.emit();
  }

  onBackdrop(ev: MouseEvent): void {
    if (ev.target === ev.currentTarget) this.closed.emit();
  }
}
