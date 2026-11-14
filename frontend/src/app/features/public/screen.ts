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
import { Color, OverlayData, PublicLive } from '../../core/models';
import { sanctionAbbr } from '../mesa/mesa-logic';
import { PublicFeed } from './feed';
import { localeActual } from '../../core/i18n/idioma';

/** Escalera por defecto si el marcador no la trae (clientes antiguos del servidor). */
const DEFAULT_SANCTIONS = ['Chui 1', 'Chui 2', 'Chui 3', 'Hansoku-chui', 'Hansoku'];

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

/** Casillero de la escalera de faltas (C1 · C2 · C3 · HC · H). */
interface LadderMark {
  abbr: string;
  full: string;
  on: boolean;
}

/**
 * Marcador de pantalla grande para un TV del coliseo (`/pantalla/:token/:tatami`),
 * con la disposición clásica de los tableros oficiales de kumite: AKA a la
 * izquierda, AO a la derecha, el reloj en un panel claro al centro, los puntos
 * enormes y las faltas como casilleros (C1 · C2 · C3 · HC · H). En kata por
 * banderas, cada lado muestra su bandera y el voto de cada juez. Alto
 * contraste, sin interacción, se adapta a 16:9 y 4:3. Se actualiza por SSE (o
 * cada segundo si no hay SSE) con el mismo marcador que el overlay.
 */
@Component({
  selector: 'app-screen',
  template: `
    <div class="screen" role="presentation" [class.kata]="isKata()">
      @if (data(); as d) {
        <header class="head">
          <span class="tat">{{ d.tatami.name }}</span>
          @if (d.match; as m) {
            <span class="cat"
              >{{ m.category }} · <span class="num">{{ m.number }}</span></span
            >
          }
          <span class="tour">{{ d.tournament }}</span>
        </header>
        @if (d.match; as m) {
          <main class="board">
            <section class="side aka" [class.won]="m.winner === 'aka'">
              <div class="top">
                <span class="clabel">AKA</span>
                @if (!isKata()) {
                  <span class="ladder" role="img" [attr.aria-label]="ladderLabel(0)">
                    @for (k of ladder(0); track k.abbr) {
                      <span class="mark" [class.on]="k.on" [title]="k.full"
                        ><i></i><b>{{ k.abbr }}</b></span
                      >
                    }
                  </span>
                  <span
                    class="senshu"
                    [class.on]="m.senshu === 'aka'"
                    i18n="@@publico.pantalla.senshu"
                    >先 Senshu</span
                  >
                }
              </div>
              <div class="who">
                <span class="nm">{{ m.aka?.name ?? '—' }}</span>
                <span class="dj">{{ m.aka?.dojo }}</span>
              </div>
              @if (isKata()) {
                <div class="flagbox">
                  <svg class="flag" viewBox="0 0 100 100" aria-hidden="true">
                    <path d="M22 96V8" />
                    <path
                      class="cloth"
                      d="M24 12c18-8 30 6 48 0 6-2 10 2 12 6v34c-18 8-30-6-48 0-6 2-10 1-12-4Z"
                    />
                  </svg>
                  <span class="judges">
                    @for (v of votes(); track $index) {
                      <span class="vote" [class.aka]="v === 'aka'" [class.ao]="v === 'ao'"
                        ><i></i><b>{{ $index + 1 }}</b></span
                      >
                    }
                  </span>
                </div>
              } @else {
                <div class="pts" data-testid="pantalla-puntos-aka">{{ m.score[0] }}</div>
              }
            </section>

            <div class="center">
              <div
                class="clockbox"
                [class.run]="m.running"
                [class.over]="remaining() <= 0 && m.status !== 'finished'"
              >
                @if (m.status === 'finished') {
                  <span class="digits fin" i18n="@@publico.fin">FIN</span>
                } @else if (isKata()) {
                  <span class="digits kata">KATA</span>
                } @else {
                  <span class="digits">{{ clockText() }}</span>
                }
                <span class="state">
                  @if (m.status === 'finished') {
                    @if (m.winner === 'aka') {
                      <ng-container i18n="@@publico.pantalla.gana-aka">Gana AKA</ng-container>
                    } @else if (m.winner === 'ao') {
                      <ng-container i18n="@@publico.pantalla.gana-ao">Gana AO</ng-container>
                    }
                  } @else if (isKata()) {
                    <ng-container i18n="@@publico.pantalla.banderas">Banderas</ng-container>
                  } @else if (m.running) {
                    HAJIME
                  } @else {
                    YAME
                  }
                </span>
              </div>
              @if (m.team; as t) {
                <div class="team">
                  <span class="tn">{{ t.aka }}</span>
                  <strong>{{ t.wins[0] }}–{{ t.wins[1] }}</strong>
                  <span class="tn">{{ t.ao }}</span>
                  <small>
                    @if (t.extra) {
                      <ng-container i18n="@@publico.pantalla.combate-extra"
                        >combate extra</ng-container
                      >
                    } @else {
                      <ng-container i18n="@@publico.pantalla.combate-n"
                        >combate {{ t.bout }}</ng-container
                      >
                    }
                  </small>
                </div>
              }
            </div>

            <section class="side ao" [class.won]="m.winner === 'ao'">
              <div class="top">
                <span class="clabel">AO</span>
                @if (!isKata()) {
                  <span class="ladder" role="img" [attr.aria-label]="ladderLabel(1)">
                    @for (k of ladder(1); track k.abbr) {
                      <span class="mark" [class.on]="k.on" [title]="k.full"
                        ><i></i><b>{{ k.abbr }}</b></span
                      >
                    }
                  </span>
                  <span
                    class="senshu"
                    [class.on]="m.senshu === 'ao'"
                    i18n="@@publico.pantalla.senshu"
                    >先 Senshu</span
                  >
                }
              </div>
              <div class="who">
                <span class="nm">{{ m.ao?.name ?? '—' }}</span>
                <span class="dj">{{ m.ao?.dojo }}</span>
              </div>
              @if (isKata()) {
                <div class="flagbox">
                  <svg class="flag" viewBox="0 0 100 100" aria-hidden="true">
                    <path d="M22 96V8" />
                    <path
                      class="cloth"
                      d="M24 12c18-8 30 6 48 0 6-2 10 2 12 6v34c-18 8-30-6-48 0-6 2-10 1-12-4Z"
                    />
                  </svg>
                  <span class="judges">
                    @for (v of votes(); track $index) {
                      <span class="vote" [class.aka]="v === 'aka'" [class.ao]="v === 'ao'"
                        ><i></i><b>{{ $index + 1 }}</b></span
                      >
                    }
                  </span>
                </div>
              } @else {
                <div class="pts" data-testid="pantalla-puntos-ao">{{ m.score[1] }}</div>
              }
            </section>
          </main>
        } @else {
          <main class="idle"
            ><span i18n="@@publico.pantalla.sin-combate-curso">Sin combate en curso</span></main
          >
        }
        <footer class="foot">
          @if (d.next; as n) {
            <span i18n="@@publico.pantalla.siguiente" class="lbl">Siguiente</span>
            <span i18n="@@publico.pantalla.vs" class="nx"
              ><span class="aka">{{ n.aka?.name ?? txtPorDefinir }}</span> vs
              <span class="ao">{{ n.ao?.name ?? txtPorDefinir }}</span></span
            >
            <span class="cat">{{ n.category }} · {{ n.number }}</span>
          } @else {
            <span class="cat">{{ d.tournament }}</span>
          }
        </footer>
      } @else {
        <main class="idle">
          <span>{{ error() || txtConectando }}</span>
        </main>
      }
    </div>
  `,
  styleUrl: './screen.scss',
})
export class ScreenPage {
  readonly txtPorDefinir = $localize`:@@comun.por-definir:Por definir`;
  readonly txtConectando = $localize`:@@publico.pantalla.conectando:Conectando…`;
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
  readonly isKata = computed(() => this.data()?.match?.modality === 'kata');
  /** Voto de cada juez (null hasta que se decide): tantos como jueces tenga la categoría. */
  readonly votes = computed<Array<Color | null>>(() => {
    const f = this.data()?.match?.flags;
    if (!f) return [];
    return Array.from({ length: f.judges }, (_, i) => f.votes[i] ?? null);
  });

  /** Texto accesible de la escalera: «Faltas AKA: ninguna» o «Faltas AO: Chui 2». */
  ladderLabel(side: 0 | 1): string {
    const who = side === 0 ? 'AKA' : 'AO';
    const nivel =
      this.data()?.match?.sanction[side] ?? $localize`:@@publico.pantalla.sin-faltas:ninguna`;
    return $localize`:@@publico.pantalla.faltas:Faltas ${who}:color:: ${nivel}:nivel:`;
  }

  /** Escalera de faltas del lado (0 = AKA, 1 = AO): un casillero por nivel, encendidos hasta el alcanzado. */
  ladder(side: 0 | 1): LadderMark[] {
    const m = this.data()?.match;
    if (!m) return [];
    const levels = m.sanction_levels?.length ? m.sanction_levels : DEFAULT_SANCTIONS;
    const reached =
      m.sanction_index?.[side] ?? (m.sanction[side] ? levels.indexOf(m.sanction[side]) + 1 : 0);
    return levels.map((full, i) => ({ abbr: sanctionAbbr(full), full, on: i < reached }));
  }

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
                <div i18n="@@publico.pantalla.sin-combate-curso" class="empty"
                  >Sin combate en curso</div
                >
              }
              @if (t.upcoming[0]; as u) {
                <div i18n="@@publico.pantalla.sigue-vs" class="tnext">
                  Sigue: {{ u.aka?.name ?? txtPorDefinir }} vs {{ u.ao?.name ?? txtPorDefinir }} ·
                  {{ u.number }}
                </div>
              }
            </section>
          }
        </div>
      } @else {
        <main class="idle">
          <span>{{ error() || txtConectando }}</span>
        </main>
      }
    </div>
  `,
  styleUrl: './screen.scss',
})
export class ScreenMosaicPage {
  readonly txtPorDefinir = $localize`:@@comun.por-definir:Por definir`;
  readonly txtConectando = $localize`:@@publico.pantalla.conectando:Conectando…`;
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
    new Intl.DateTimeFormat(localeActual(), {
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
