import { Component, input, output } from '@angular/core';
import { Icon } from './icon';

/** Modal con contenido proyectado. Se muestra con @if desde el padre. */
@Component({
  selector: 'app-modal',
  imports: [Icon],
  template: `
    <div class="modal-backdrop" (click)="onBackdrop($event)" (keydown.escape)="closed.emit()">
      <div class="modal" [class.wide]="wide()" role="dialog" aria-modal="true" [attr.aria-label]="title()">
        <div class="head">
          <h2>{{ title() }}</h2>
          <button type="button" class="btn ghost sm icon-only close" (click)="closed.emit()" aria-label="Cerrar"><app-icon name="close" /></button>
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
  readonly closed = output<void>();

  onBackdrop(ev: MouseEvent): void {
    if (ev.target === ev.currentTarget) this.closed.emit();
  }
}
