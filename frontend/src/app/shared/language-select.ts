import { Component } from '@angular/core';
import { CodigoIdioma, IDIOMAS, cambiarIdioma, idiomaActual } from '../core/i18n/idioma';
import { Icon } from './icon';

/**
 * Selector de idioma (Mi cuenta, pie del login y de las páginas públicas). La
 * preferencia se guarda en el dispositivo y la app se recarga para cargar las
 * traducciones antes de arrancar (docs/idiomas.md).
 */
@Component({
  selector: 'app-language-select',
  imports: [Icon],
  template: `
    <label class="lang">
      <app-icon name="globe" />
      <select
        i18n-aria-label="@@idioma.selector"
        aria-label="Idioma"
        data-testid="selector-idioma"
        [value]="actual"
        (change)="cambiar($event)"
      >
        @for (i of idiomas; track i.codigo) {
          <option [value]="i.codigo" [attr.lang]="i.locale" [selected]="i.codigo === actual">{{ i.nombre }}</option>
        }
      </select>
    </label>
  `,
  styles: `
    .lang {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      color: inherit;
      font-size: var(--fs-14, 0.875rem);
    }
    select {
      font: inherit;
      color: inherit;
      background: transparent;
      border: 1px solid var(--kasumi-2, currentColor);
      border-radius: var(--radius, 6px);
      padding: 0.2rem 0.4rem;
    }
  `,
})
export class LanguageSelect {
  readonly idiomas = IDIOMAS;
  readonly actual = idiomaActual().codigo;

  cambiar(ev: Event): void {
    cambiarIdioma((ev.target as HTMLSelectElement).value as CodigoIdioma);
  }
}
