import { Component, input } from '@angular/core';

export type IconName =
  | 'plus'
  | 'more'
  | 'download'
  | 'upload'
  | 'print'
  | 'refresh'
  | 'back'
  | 'swap'
  | 'history'
  | 'sun'
  | 'moon'
  | 'system'
  | 'key'
  | 'logout'
  | 'close'
  | 'search'
  | 'open'
  | 'check'
  | 'bell'
  | 'globe';

/** Iconos de línea fina (1.6 px) en currentColor. Decorativos: el texto del botón da el nombre. */
@Component({
  selector: 'app-icon',
  template: `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      @switch (name()) {
        @case ('plus') {
          <path d="M12 5v14M5 12h14" />
        }
        @case ('more') {
          <circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
          <circle cx="19" cy="12" r="1.3" fill="currentColor" stroke="none" />
        }
        @case ('download') {
          <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
        }
        @case ('upload') {
          <path d="M12 20V9M7 14l5-5 5 5M5 4h14" />
        }
        @case ('print') {
          <path d="M7 9V4h10v5M7 17H5a1 1 0 0 1-1-1v-5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v5a1 1 0 0 1-1 1h-2M7 14h10v6H7z" />
        }
        @case ('refresh') {
          <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4" />
        }
        @case ('back') {
          <path d="M19 12H5M11 6l-6 6 6 6" />
        }
        @case ('swap') {
          <path d="M5 8h14M15 4l4 4-4 4M19 16H5M9 12l-4 4 4 4" />
        }
        @case ('history') {
          <circle cx="12" cy="12" r="8" />
          <path d="M12 8v4l2.5 1.5" />
        }
        @case ('sun') {
          <circle cx="12" cy="12" r="3.5" />
          <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" />
        }
        @case ('moon') {
          <path d="M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10z" />
        }
        @case ('system') {
          <rect x="3.5" y="4.5" width="17" height="11" rx="1.5" />
          <path d="M8.5 19.5h7M12 15.5v4" />
        }
        @case ('key') {
          <circle cx="8" cy="15" r="3.5" />
          <path d="M10.5 12.5 19 4M16 7l2.5 2.5" />
        }
        @case ('logout') {
          <path d="M14 4.5h3.5a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5H14M10 16l-4-4 4-4M6 12h9" />
        }
        @case ('close') {
          <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
        }
        @case ('search') {
          <circle cx="11" cy="11" r="6" />
          <path d="M19.5 19.5 15.3 15.3" />
        }
        @case ('open') {
          <path d="M14 5h5v5M19 5l-8 8M18 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4" />
        }
        @case ('check') {
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        }
        @case ('bell') {
          <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16zM10 20.5a2 2 0 0 0 4 0" />
        }
        @case ('globe') {
          <circle cx="12" cy="12" r="8.5" />
          <path d="M3.5 12h17M12 3.5c2.4 2.4 3.5 5.3 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.3-3.5-8.5s1.1-6.1 3.5-8.5z" />
        }
      }
    </svg>
  `,
  styles: `
    :host {
      display: inline-flex;
      width: 1.1em;
      height: 1.1em;
      flex: none;
    }
    svg {
      width: 100%;
      height: 100%;
    }
  `,
})
export class Icon {
  readonly name = input.required<IconName>();
}
