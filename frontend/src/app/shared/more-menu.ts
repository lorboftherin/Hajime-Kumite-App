import { Component, DestroyRef, ElementRef, inject, input, signal, viewChild } from '@angular/core';
import { Icon } from './icon';

/**
 * Menú «Más» para acciones poco frecuentes (revelar de a poco).
 * Los ítems se proyectan como <button class="menu-item">. Se posiciona fijo respecto del botón
 * para no quedar recortado dentro de tablas con desplazamiento; se cierra al elegir, con Esc,
 * al hacer clic fuera o al desplazar la página.
 */
@Component({
  selector: 'app-more',
  imports: [Icon],
  host: {
    '(document:click)': 'onDocClick($event)',
    '(document:keydown.escape)': 'close(true)',
    '(window:resize)': 'close()',
  },
  template: `
    <button
      #trigger
      type="button"
      class="btn more-trigger"
      [class.sm]="small()"
      [class.ghost]="!text()"
      [class.icon-only]="!text()"
      aria-haspopup="menu"
      [attr.aria-expanded]="open()"
      [attr.aria-label]="text() ? null : label()"
      [attr.title]="text() ? null : label()"
      (click)="toggle()"
    >
      <app-icon name="more" />
      @if (text()) {
        <span>{{ text() }}</span>
      }
    </button>
    @if (open()) {
      <div
        #panel
        class="menu-panel floating"
        role="menu"
        [attr.aria-label]="label()"
        [style.top.px]="pos().top"
        [style.bottom.px]="pos().bottom"
        [style.right.px]="pos().right"
        (click)="onPanelClick($event)"
        (keydown)="onKey($event)"
      >
        <ng-content />
      </div>
    }
  `,
  styles: `
    :host {
      display: inline-flex;
      position: relative;
    }
  `,
})
export class MoreMenu {
  /** Texto visible del botón; vacío = solo el icono ⋯ (con nombre accesible `label`). */
  readonly text = input('');
  readonly label = input($localize`:@@menu-mas.mas-acciones:Más acciones`);
  readonly small = input(true);

  readonly open = signal(false);
  readonly pos = signal<{ top: number | null; bottom: number | null; right: number }>({ top: 0, bottom: null, right: 0 });

  private host = inject(ElementRef<HTMLElement>);
  private trigger = viewChild.required<ElementRef<HTMLButtonElement>>('trigger');
  private panel = viewChild<ElementRef<HTMLElement>>('panel');
  private onScroll = () => this.close();

  constructor() {
    inject(DestroyRef).onDestroy(() => window.removeEventListener('scroll', this.onScroll, true));
  }

  toggle(): void {
    if (this.open()) {
      this.close();
      return;
    }
    const r = this.trigger().nativeElement.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const right = Math.max(8, window.innerWidth - r.right);
    this.pos.set(below < 280 && r.top > below ? { top: null, bottom: window.innerHeight - r.top + 6, right } : { top: r.bottom + 6, bottom: null, right });
    this.open.set(true);
    window.addEventListener('scroll', this.onScroll, true);
    setTimeout(() => {
      const items = this.items();
      items.forEach((e) => e.setAttribute('role', 'menuitem'));
      items[0]?.focus();
    });
  }

  close(returnFocus = false): void {
    if (!this.open()) return;
    this.open.set(false);
    window.removeEventListener('scroll', this.onScroll, true);
    if (returnFocus) this.trigger().nativeElement.focus();
  }

  onDocClick(ev: MouseEvent): void {
    if (this.open() && !this.host.nativeElement.contains(ev.target as Node)) this.close();
  }

  onPanelClick(ev: MouseEvent): void {
    const item = (ev.target as HTMLElement).closest('button, a');
    if (item && !(item as HTMLButtonElement).disabled) this.close();
  }

  onKey(ev: KeyboardEvent): void {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    ev.preventDefault();
    const items = this.items();
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = ev.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  private items(): HTMLElement[] {
    const p = this.panel()?.nativeElement;
    return p ? Array.from(p.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]')) : [];
  }
}
