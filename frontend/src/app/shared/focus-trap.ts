import { AfterViewInit, DestroyRef, Directive, ElementRef, inject } from '@angular/core';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Elementos que reciben foco con Tab dentro de `root`, en orden del documento. */
export function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (e) => !e.hidden && e.getClientRects().length > 0,
  );
}

/**
 * Trampa de foco para diálogos (role="dialog"): al abrir enfoca el control con `autofocus`
 * (o el primero), Tab y Mayús+Tab no salen del diálogo, y al cerrar el foco vuelve al
 * elemento que lo abrió.
 */
@Directive({ selector: '[appFocusTrap]', host: { '(keydown)': 'onKey($event)' } })
export class FocusTrap implements AfterViewInit {
  private el = inject(ElementRef<HTMLElement>).nativeElement as HTMLElement;
  private opener: HTMLElement | null =
    typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      const back = this.opener;
      // Se devuelve el foco después de que el diálogo sale del DOM.
      setTimeout(() => {
        if (back && back.isConnected && typeof back.focus === 'function') back.focus();
      });
    });
  }

  ngAfterViewInit(): void {
    setTimeout(() => {
      if (this.el.contains(document.activeElement)) return;
      const first =
        this.el.querySelector<HTMLElement>('[autofocus]') ?? focusables(this.el)[0] ?? this.el;
      if (first === this.el && !this.el.hasAttribute('tabindex'))
        this.el.setAttribute('tabindex', '-1');
      first.focus();
    });
  }

  onKey(ev: KeyboardEvent): void {
    if (ev.key !== 'Tab') return;
    const items = focusables(this.el);
    if (!items.length) {
      ev.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (ev.shiftKey && (active === first || !this.el.contains(active))) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && (active === last || !this.el.contains(active))) {
      ev.preventDefault();
      first.focus();
    }
  }
}
