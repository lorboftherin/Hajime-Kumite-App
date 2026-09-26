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
import { ApiService } from '../../core/api.service';
import { mmss } from '../../core/format';
import { OverlayData, PublicLive } from '../../core/models';
import { PublicFeed } from './feed';

/** Pantalla encendida mientras la página está abierta (si el navegador lo permite). */
function keepAwake(destroy: DestroyRef): void {
  let lock: { release: () => Promise<void> } | null = null;
  const request = async () => {
    try {
      const nav = navigator as Navigator & {
        wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> };
      };
      lock = (await nav.wakeLock?.request('screen')) ?? null;
    } catch {
      /* sin permiso o sin soporte: la TV decide */
    }
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible') request();
  };
  request();
  document.addEventListener('visibilitychange', onVisible);
  destroy.onDestroy(() => {
    document.removeEventListener('visibilitychange', onVisible);
    lock?.release().catch(() => {});
  });
}

/**
 * Marcador de pantalla grande para un TV del coliseo (`/pantalla/:token/:tatami`):
 * nombres grandes, dojo, puntos, faltas, senshu y reloj que avanza localmente,
 * categoría y siguiente combate. Alto contraste, sin interacción, se adapta a
 * 16:9 y 4:3. Se actualiza por SSE (o cada segundo si no hay SSE) con el mismo
 * marcador que el overlay de transmisión.
 */
@Component({
  selector: 'app-screen',
  template: `
    <div class="screen" role="presentation">
      @if (data(); as d) {
        <header class="head">
          <span class="tat">{{ d.tatami.name }}</span>
          @if (d.match; as m) {
            <span class="cat"
              >{{ m.category }} · <span class="num">{{ m.number }}</span></span
            >
            <span
              class="clock"
              [class.run]="m.running"
              [class.over]="remaining() <= 0 && m.status !== 'finished'"
            >
              {{ m.status === 'finished' ? 'FIN' : clockText() }}
            </span>
          } @else {
            <span class="cat">{{ d.tournament }}</span>
          }
        </header>
        @if (d.match; as m) {
          @if (m.team; as t) {
            <div class="team">
              {{ t.aka }} <strong>{{ t.wins[0] }}–{{ t.wins[1] }}</strong> {{ t.ao }} ·
              {{ t.extra ? 'combate extra' : 'combate ' + t.bout }}
            </div>
          }
          <main class="sides">
            <section class="side aka" [class.won]="m.winner === 'aka'">
              <div class="who">
                <span class="nm">{{ m.aka?.name ?? '—' }}</span>
                <span class="dj">{{ m.aka?.dojo }}</span>
              </div>
              <div class="pts">{{ m.score[0] }}</div>
              <div class="marks">
                @if (m.senshu === 'aka') {
                  <span class="senshu">先 Senshu</span>
                }
                @if (m.sanction[0]) {
                  <span class="pen">{{ m.sanction[0] }}</span>
                }
              </div>
            </section>
            <section class="side ao" [class.won]="m.winner === 'ao'">
              <div class="who">
                <span class="nm">{{ m.ao?.name ?? '—' }}</span>
                <span class="dj">{{ m.ao?.dojo }}</span>
              </div>
              <div class="pts">{{ m.score[1] }}</div>
              <div class="marks">
                @if (m.senshu === 'ao') {
                  <span class="senshu">先 Senshu</span>
                }
                @if (m.sanction[1]) {
                  <span class="pen">{{ m.sanction[1] }}</span>
                }
              </div>
            </section>
          </main>
        } @else {
          <main class="idle"><span>Sin combate en curso</span></main>
        }
        <footer class="foot">
          @if (d.next; as n) {
            <span class="lbl">Siguiente</span>
            <span class="nx"
              ><span class="aka">{{ n.aka?.name ?? 'Por definir' }}</span> vs
              <span class="ao">{{ n.ao?.name ?? 'Por definir' }}</span></span
            >
            <span class="cat">{{ n.category }} · {{ n.number }}</span>
          } @else {
            <span class="cat">{{ d.tournament }}</span>
          }
        </footer>
      } @else {
        <main class="idle">
          <span>{{ error() || 'Conectando…' }}</span>
        </main>
      }
    </div>
  `,
  styleUrl: './screen.scss',
})
export class ScreenPage {
  private api = inject(ApiService);
  readonly token = input.required<string>();
  readonly tatami = input.required<string>();
  readonly data = signal<OverlayData | null>(null);
  readonly error = signal('');
  private readonly fetchedAt = signal(Date.now());
  private readonly now = signal(Date.now());
  private feed: PublicFeed<unknown, unknown, OverlayData> | null = null;

  readonly remaining = computed(() => {
    const m = this.data()?.match;
    if (!m) return 0;
    const extra = m.running ? (this.now() - this.fetchedAt()) / 1000 : 0;
    return Math.max(0, m.duration - m.elapsed - extra);
  });
  readonly clockText = computed(() => mmss(Math.ceil(this.remaining())));

  constructor() {
    const destroy = inject(DestroyRef);
    const tick = setInterval(() => this.now.set(Date.now()), 250);
    keepAwake(destroy);
    destroy.onDestroy(() => {
      clearInterval(tick);
      this.feed?.stop();
    });
    effect(() => {
      const token = this.token();
      const tatami = Number(this.tatami());
      untracked(() => {
        this.feed?.stop();
        this.feed = new PublicFeed<unknown, unknown, OverlayData>(this.api, {
          base: `/public/${encodeURIComponent(token)}`,
          live: false,
          tatami,
          pollMs: 1000,
          onOverlay: (d) => {
            this.data.set(d);
            this.fetchedAt.set(Date.now());
          },
          onGone: (msg) => this.error.set(msg),
        });
        this.feed.start();
      });
    });
  }
}

/**
 * Todos los tatamis en mosaico (`/pantalla/:token`) para la entrada del
 * coliseo: por tatami, el combate en curso con su marcador y el siguiente.
 */
@Component({
  selector: 'app-screen-mosaic',
  template: `
    <div class="mosaic" [style.--cols]="cols()" role="presentation">
      @if (data(); as d) {
        <header class="mhead">
          <span>{{ d.tournament.name }}</span
          ><span class="muted">{{ clock() }}</span>
        </header>
        <div class="tiles">
          @for (t of d.tatamis; track t.id) {
            <section class="tile">
              <h2>
                {{ t.name }} <span class="prog">{{ t.done }}/{{ t.total }}</span>
              </h2>
              @if (t.current; as c) {
                @let m = c.bout ?? c;
                <div class="tcat">{{ c.category }} · {{ c.number }}</div>
                <div class="row aka" [class.won]="m.winner === 'aka'">
                  <span class="nm">{{ m.aka?.name ?? '—' }}</span
                  ><span class="dj">{{ m.aka?.dojo }}</span
                  ><span class="pts">{{ m.score[0] }}</span>
                </div>
                <div class="row ao" [class.won]="m.winner === 'ao'">
                  <span class="nm">{{ m.ao?.name ?? '—' }}</span
                  ><span class="dj">{{ m.ao?.dojo }}</span
                  ><span class="pts">{{ m.score[1] }}</span>
                </div>
              } @else {
                <div class="empty">Sin combate en curso</div>
              }
              @if (t.upcoming[0]; as u) {
                <div class="tnext">
                  Sigue: {{ u.aka?.name ?? 'Por definir' }} vs {{ u.ao?.name ?? 'Por definir' }} ·
                  {{ u.number }}
                </div>
              }
            </section>
          }
        </div>
      } @else {
        <main class="idle">
          <span>{{ error() || 'Conectando…' }}</span>
        </main>
      }
    </div>
  `,
  styleUrl: './screen.scss',
})
export class ScreenMosaicPage {
  private api = inject(ApiService);
  readonly token = input.required<string>();
  readonly data = signal<PublicLive | null>(null);
  readonly error = signal('');
  private readonly now = signal(new Date());
  private feed: PublicFeed<PublicLive> | null = null;

  /** Columnas según cuántos tatamis hay: 1, 2, 2×2, 3×2, 3×3, 4×3. */
  readonly cols = computed(() => {
    const n = this.data()?.tatamis.length ?? 1;
    return n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
  });
  readonly clock = computed(() =>
    new Intl.DateTimeFormat('es-PE', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: this.data()?.tournament.timezone ?? 'America/Lima',
    }).format(this.now()),
  );

  constructor() {
    const destroy = inject(DestroyRef);
    const tick = setInterval(() => this.now.set(new Date()), 10000);
    keepAwake(destroy);
    destroy.onDestroy(() => {
      clearInterval(tick);
      this.feed?.stop();
    });
    effect(() => {
      const token = this.token();
      untracked(() => {
        this.feed?.stop();
        this.feed = new PublicFeed<PublicLive>(this.api, {
          base: `/public/${encodeURIComponent(token)}`,
          live: true,
          pollMs: 3000,
          onLive: (d) => this.data.set(d),
          onGone: (msg) => this.error.set(msg),
        });
        this.feed.start();
      });
    });
  }
}
