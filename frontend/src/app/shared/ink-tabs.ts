import { AfterViewInit, DestroyRef, Directive, ElementRef, inject } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';

/**
 * Subrayado de tinta que se desliza hasta la pestaña activa (.active) de un <nav class="tabs">.
 * Sin la directiva, la pestaña activa usa un subrayado fijo (CSS).
 */
@Directive({ selector: 'nav.tabs[inkTabs]', host: { class: 'inked' } })
export class InkTabs implements AfterViewInit {
  private el = inject(ElementRef<HTMLElement>).nativeElement as HTMLElement;
  private destroy = inject(DestroyRef);
  private router = inject(Router);

  ngAfterViewInit(): void {
    const update = () => requestAnimationFrame(() => this.place());
    update();
    const sub = this.router.events.pipe(filter((e) => e instanceof NavigationEnd)).subscribe(update);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    ro?.observe(this.el);
    // routerLinkActive y [class.active] cambian después de la navegación: se observa la clase.
    const mo = new MutationObserver(update);
    mo.observe(this.el, { subtree: true, attributes: true, attributeFilter: ['class'] });
    this.destroy.onDestroy(() => {
      sub.unsubscribe();
      ro?.disconnect();
      mo.disconnect();
    });
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
