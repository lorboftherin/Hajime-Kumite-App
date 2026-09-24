import { Component, input, output } from '@angular/core';

/** Modal con contenido proyectado. Se muestra con @if desde el padre. */
@Component({
  selector: 'app-modal',
  template: `
    <div class="modal-backdrop" (click)="onBackdrop($event)" (keydown.escape)="closed.emit()">
      <div class="modal" [class.wide]="wide()" role="dialog" aria-modal="true" [attr.aria-label]="title()">
        <div class="head">
          <h2>{{ title() }}</h2>
          <button type="button" class="btn ghost sm" (click)="closed.emit()" aria-label="Cerrar">✕</button>
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
