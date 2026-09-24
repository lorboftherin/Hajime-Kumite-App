import { Component } from '@angular/core';
import { Enso } from './enso';

/**
 * Fondo de las pantallas de acceso: papel washi a sangre, un ensō grande y tenue,
 * y olas seigaiha (青海波) muy suaves en una esquina. Solo se usa aquí (docs/diseno.md §4).
 */
@Component({
  selector: 'app-auth-frame',
  imports: [Enso],
  template: `
    <div class="frame">
      <svg class="seigaiha" aria-hidden="true" focusable="false">
        <defs>
          <pattern id="seigaiha" width="48" height="24" patternUnits="userSpaceOnUse">
            @for (c of waves; track $index) {
              @for (r of rings; track r) {
                <circle [attr.cx]="c[0]" [attr.cy]="c[1]" [attr.r]="r" />
              }
            }
          </pattern>
          <radialGradient id="seigaiha-fade" cx="100%" cy="100%" r="100%">
            <stop offset="0" stop-color="#fff" stop-opacity="1" />
            <stop offset="0.75" stop-color="#fff" stop-opacity="0" />
          </radialGradient>
          <mask id="seigaiha-mask"><rect width="100%" height="100%" fill="url(#seigaiha-fade)" /></mask>
        </defs>
        <rect width="100%" height="100%" fill="url(#seigaiha)" mask="url(#seigaiha-mask)" />
      </svg>
      <app-enso class="enso-bg" tone="mono" />
      <div class="content">
        <ng-content />
      </div>
    </div>
  `,
  styles: `
    :host {
      display: block;
    }
    .frame {
      position: relative;
      min-height: 100vh;
      min-height: 100dvh;
      display: grid;
      place-items: center;
      padding: 2rem 1rem;
      overflow: hidden;
      isolation: isolate;
    }
    .seigaiha {
      position: absolute;
      right: 0;
      bottom: 0;
      width: min(760px, 90vw);
      height: min(560px, 70vh);
      z-index: -1;
      opacity: 0.1;
    }
    .seigaiha circle {
      fill: var(--washi);
      stroke: var(--ai);
      stroke-width: 0.9;
    }
    .enso-bg {
      position: absolute;
      z-index: -1;
      width: min(78vmin, 720px);
      height: min(78vmin, 720px);
      left: max(-8vmin, calc(50% - 640px));
      top: 50%;
      transform: translateY(-52%) rotate(-12deg);
      color: var(--sumi);
      opacity: 0.045;
    }
    .content {
      width: 100%;
      display: grid;
      place-items: center;
    }
    @media (max-width: 767px) {
      .enso-bg {
        width: 120vw;
        height: 120vw;
        left: -30vw;
        top: 22%;
      }
      .seigaiha {
        width: 100vw;
        height: 40vh;
      }
    }
  `,
})
export class AuthFrame {
  /** Centros de las olas en la baldosa de 48×24, de arriba hacia abajo (las de abajo tapan). */
  readonly waves: Array<[number, number]> = [
    [24, 0],
    [0, 12],
    [48, 12],
    [24, 24],
    [0, 36],
    [48, 36],
  ];
  readonly rings = [24, 19, 14, 9, 4];
}
