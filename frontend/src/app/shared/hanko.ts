import { Component, computed, input } from '@angular/core';
import { etiquetas } from '../core/i18n/etiquetas';

const NAME: Record<number, string> = etiquetas(() => ({
  1: $localize`:@@hanko.oro:Oro`,
  2: $localize`:@@hanko.plata:Plata`,
  3: $localize`:@@hanko.bronce:Bronce`,
}));
const METAL: Record<number, string> = { 1: 'kin', 2: 'gin', 3: 'dou' };

/**
 * Hanko (判子): sello cuadrado de tinta shu con el número del puesto.
 * Con `withLabel` agrega el nombre de la medalla junto a un pequeño aro de su metal.
 * Fuera del podio muestra «5.º» en texto tenue, sin sello.
 */
@Component({
  selector: 'app-hanko',
  template: `
    @if (isPodium()) {
      <span class="seal" [class.lg]="size() === 'lg'" aria-hidden="true">{{ place() }}</span>
      @if (withLabel()) {
        <span class="label"><span class="ring {{ metal() }}"></span>{{ name() }}</span>
      } @else {
        <span class="sr-only">{{ name() }}</span>
      }
    } @else if (place()) {
      <span i18n="@@hanko.texto" class="off">{{ place() }}.º</span>
    } @else {
      <span class="off">—</span>
    }
  `,
  styles: `
    :host {
      display: inline-flex;
      align-items: center;
      gap: 0.6rem;
      white-space: nowrap;
      vertical-align: middle;
    }
    .seal {
      --s: 1.6rem;
      display: inline-grid;
      place-items: center;
      width: var(--s);
      height: var(--s);
      border-radius: 3px;
      background: var(--hanko);
      color: #fff;
      font-family: var(--font-display);
      font-weight: 700;
      font-size: calc(var(--s) * 0.58);
      line-height: 1;
      box-shadow:
        inset 0 0 0 2px var(--hanko),
        inset 0 0 0 3px rgba(255, 255, 255, 0.55);
      transform: rotate(-3deg);
      font-variant-numeric: tabular-nums;
    }
    .seal.lg {
      --s: 2.4rem;
    }
    .label {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      font-size: var(--fs-14);
      color: var(--sumi-2);
    }
    .ring {
      width: 0.6rem;
      height: 0.6rem;
      border-radius: 50%;
      border: 2px solid var(--nezumi);
    }
    .ring.kin {
      border-color: var(--kin);
    }
    .ring.gin {
      border-color: var(--gin);
    }
    .ring.dou {
      border-color: var(--dou);
    }
    .off {
      display: inline-grid;
      place-items: center;
      min-width: 1.6rem;
      color: var(--nezumi-ink);
      font-variant-numeric: tabular-nums;
      font-size: var(--fs-14);
    }
  `,
})
export class Hanko {
  readonly place = input<number | null | undefined>(null);
  readonly withLabel = input(false);
  readonly size = input<'md' | 'lg'>('md');
  readonly isPodium = computed(() => !!this.place() && this.place()! <= 3);
  readonly name = computed(() => NAME[this.place() ?? 0] ?? '');
  readonly metal = computed(() => METAL[this.place() ?? 0] ?? '');
}
