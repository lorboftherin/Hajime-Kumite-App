import { Component, input } from '@angular/core';

/**
 * Encabezado de página: kanji ornamental tenue + título en Mincho, metadatos debajo
 * y una sola acción principal a la derecha (el resto, en un menú «Más»).
 *   <app-page-head kanji="大会" title="Torneos">
 *     <a back routerLink="..">…</a>  <div meta>…</div>  (acciones sin atributo)
 *   </app-page-head>
 */
@Component({
  selector: 'app-page-head',
  template: `
    <ng-content select="[back]" />
    <div class="page-header">
      <div class="page-title">
        @if (kanji()) {
          <span class="kanji" aria-hidden="true">{{ kanji() }}</span>
        }
        <div class="titles">
          <h1>{{ title() }}</h1>
          <ng-content select="[meta]" />
        </div>
      </div>
      <div class="page-actions">
        <ng-content />
      </div>
    </div>
  `,
})
export class PageHead {
  readonly kanji = input('');
  readonly title = input.required<string>();
}
