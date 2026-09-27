import {
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { mmss } from '../../core/format';
import { OverlayData } from '../../core/models';

/**
 * Overlay del marcador para transmisiones en vivo (OBS, vMix, Streamlabs):
 * «Fuente de navegador» con esta URL, 1920×1080, fondo transparente. Igual a
 * los «score tickers» de CricHeroes. Sigue solo al combate en curso del tatami
 * (en equipos, al combate individual) y el reloj corre localmente entre
 * consultas. ?pos=top lo pone arriba.
 */
@Component({
  selector: 'app-overlay',
  template: `
    @if (data()?.match; as m) {
      <div class="ticker" [class.top]="pos() === 'top'">
        <div class="meta">
          <span>{{ data()!.tatami.name }}</span>
          <span class="sep">·</span>
          <span>{{ m.category }}</span>
          @if (m.team; as t) {
            <span class="sep">·</span>
            <span class="team">
              @if (t.extra) {
                <ng-container i18n="@@mesa.combate-extra">Combate extra</ng-container>
              } @else {
                <ng-container i18n="@@mesa.combate-n">Combate {{ t.bout }}</ng-container>
              }
              · {{ t.aka }} {{ t.wins[0] }}–{{ t.wins[1] }} {{ t.ao }}</span
            >
          }
        </div>
        <div class="bar">
          <div class="side aka" [class.won]="m.winner === 'aka'">
            <div class="who">
              <span class="nm">{{ m.aka?.name ?? '—' }}</span>
              <span class="dj">{{ m.aka?.dojo }}</span>
            </div>
            @if (m.senshu === 'aka') {
              <span i18n-title="@@publico.overlay.senshu" class="senshu" title="Senshu">先</span>
            }
            @if (m.sanction[0]) {
              <span class="pen">{{ m.sanction[0] }}</span>
            }
            <span class="pts">{{ m.score[0] }}</span>
          </div>
          <div class="clock" [class.run]="m.running" [class.over]="remaining() <= 0">
            @if (m.status === 'finished') {
              <ng-container i18n="@@publico.fin">FIN</ng-container>
            } @else {
              {{ clockText() }}
            }
          </div>
          <div class="side ao" [class.won]="m.winner === 'ao'">
            <span class="pts">{{ m.score[1] }}</span>
            @if (m.sanction[1]) {
              <span class="pen">{{ m.sanction[1] }}</span>
            }
            @if (m.senshu === 'ao') {
              <span i18n-title="@@publico.overlay.senshu" class="senshu" title="Senshu">先</span>
            }
            <div class="who">
              <span class="nm">{{ m.ao?.name ?? '—' }}</span>
              <span class="dj">{{ m.ao?.dojo }}</span>
            </div>
          </div>
        </div>
      </div>
    }
  `,
  styleUrl: './overlay.scss',
})
export class OverlayPage {
  private api = inject(ApiService);
  readonly token = input.required<string>();
  readonly tatami = input.required<string>();
  readonly pos = input<string | undefined>(undefined);
  readonly data = signal<OverlayData | null>(null);
  private readonly fetchedAt = signal(Date.now());
  private readonly now = signal(Date.now());

  readonly remaining = computed(() => {
    const m = this.data()?.match;
    if (!m) return 0;
    const extra = m.running ? (this.now() - this.fetchedAt()) / 1000 : 0;
    return Math.max(0, m.duration - m.elapsed - extra);
  });
  readonly clockText = computed(() => mmss(Math.ceil(this.remaining())));

  constructor() {
    // Fondo transparente solo mientras el overlay está abierto.
    const html = document.documentElement;
    const prev = [html.style.background, document.body.style.background];
    html.style.background = document.body.style.background = 'transparent';
    const tick = setInterval(() => this.now.set(Date.now()), 250);
    const poll = setInterval(() => this.load(), 1000);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(tick);
      clearInterval(poll);
      [html.style.background, document.body.style.background] = prev;
    });
    effect(() => {
      this.token();
      this.tatami();
      untracked(() => this.load());
    });
  }

  async load(): Promise<void> {
    try {
      const d = await firstValueFrom(
        this.api.get<OverlayData>(
          `/public/${encodeURIComponent(this.token())}/tatamis/${encodeURIComponent(this.tatami())}`,
        ),
      );
      this.data.set(d);
      this.fetchedAt.set(Date.now());
    } catch {
      /* se reintenta en la siguiente consulta; el último marcador queda en pantalla */
    }
  }
}
