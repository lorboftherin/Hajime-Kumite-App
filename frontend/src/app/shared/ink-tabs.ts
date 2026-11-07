import { AfterViewInit, DestroyRef, Directive, ElementRef, inject } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';

/**
 * Subrayado de tinta que se desliza hasta la pestaña activa (.active) de un <nav class="tabs">.
 * Sin la directiva, la pestaña activa usa un subrayado fijo (CSS).
 *
 * En pantallas angostas las pestañas se desplazan de lado: la directiva marca `more-left` /
 * `more-right` (degradado y flecha en CSS) y lleva la pestaña activa a la vista.
 */
@Directive({ selector: 'nav.tabs[inkTabs]', host: { class: 'inked' } })
export class InkTabs implements AfterViewInit {
  private el = inject(ElementRef<HTMLElement>).nativeElement as HTMLElement;
  private destroy = inject(DestroyRef);
  private router = inject(Router);

  ngAfterViewInit(): void {
    let lastActive: HTMLElement | null = null;
    const update = () =>
      requestAnimationFrame(() => {
        this.place();
        const a = this.el.querySelector<HTMLElement>('a.active');
        if (a && a !== lastActive) {
          lastActive = a;
          this.reveal(a);
        }
        this.edges();
      });
    update();
    const onScroll = () => this.edges();
    this.el.addEventListener('scroll', onScroll, { passive: true });
    const sub = this.router.events
      .pipe(filter((e) => e instanceof NavigationEnd))
      .subscribe(update);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    ro?.observe(this.el);
    // routerLinkActive y [class.active] cambian después de la navegación: se observa la clase.
    const mo = new MutationObserver(update);
    mo.observe(this.el, { subtree: true, attributes: true, attributeFilter: ['class'] });
    this.destroy.onDestroy(() => {
      this.el.removeEventListener('scroll', onScroll);
      sub.unsubscribe();
      ro?.disconnect();
      mo.disconnect();
    });
  }

  /** Desplaza la barra para que la pestaña activa quede entera a la vista (sin mover la página). */
  private reveal(a: HTMLElement): void {
    const left = a.offsetLeft;
    const right = left + a.offsetWidth;
    const view = this.el.clientWidth;
    const pad = 32; // espacio para el degradado de «hay más»
    if (left < this.el.scrollLeft + pad) this.el.scrollLeft = Math.max(0, left - pad);
    else if (right > this.el.scrollLeft + view - pad) this.el.scrollLeft = right - view + pad;
  }

  /** Indica si hay pestañas ocultas a la izquierda o a la derecha. */
  private edges(): void {
    const max = this.el.scrollWidth - this.el.clientWidth;
    this.el.classList.toggle('more-left', this.el.scrollLeft > 2);
    this.el.classList.toggle('more-right', max - this.el.scrollLeft > 2);
  }

  private place(): void {
    const a = this.el.querySelector<HTMLElement>('a.active');
    if (!a) {
      this.el.style.setProperty('--ink-w', '0px');
      return;
    }
    this.el.style.setProperty('--ink-x', `${a.offsetLeft}px`);
    this.el.style.setProperty('--ink-w', `${a.offsetWidth}px`);
  }
}
