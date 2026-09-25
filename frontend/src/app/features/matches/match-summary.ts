import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiError } from '../../core/api-error';
import { ApiService } from '../../core/api.service';
import { METHOD_LABEL, POINT_LABEL, fmtDate, mmss } from '../../core/format';
import { Color, MatchSummary, TimelinePoint } from '../../core/models';
import { ToastService } from '../../core/toast.service';
import { PageHead } from '../../shared/page-head';
import { shareMatchCard } from './share-card';

const W = 760;
const H = 250;
const M = { top: 16, right: 56, bottom: 30, left: 34 };

/**
 * Hoja del combate (GET /matches/{id}/summary). La línea de tiempo del
 * marcador es el «worm» de las apps de cricket: el puntaje acumulado de cada
 * lado según el tiempo de reloj, con cursor que muestra el marcador en cada
 * momento. Debajo, el mismo contenido como lista (vista de tabla).
 */
@Component({
  selector: 'app-match-summary',
  imports: [RouterLink, PageHead],
  template: `
    <div class="container">
    @if (data(); as d) {
      <app-page-head kanji="試合" [title]="'Combate ' + d.match.code">
        <a back class="back-link" [routerLink]="['/categorias', d.category.id, 'llave']">← {{ d.category.name }}</a>
        <div meta class="small muted">
          @if (d.tournament) {
            {{ d.tournament.name }} · {{ fdate(d.tournament.date) }}
          }
        </div>
        <a class="btn" [routerLink]="['/mesa', d.match.id]">Abrir en la mesa</a>
        <button class="btn primary" (click)="share()" [disabled]="d.match.status !== 'finished'">Compartir resultado</button>
      </app-page-head>

      <section class="card board" aria-label="Marcador final">
        @for (c of colors; track c) {
          <div class="side {{ c }}" [class.won]="d.match.winner === c">
            <span class="clabel">{{ c === 'aka' ? 'AKA' : 'AO' }}</span>
            <span class="name">{{ d[c].name ?? '—' }}</span>
            <span class="dojo">{{ d[c].dojo }}</span>
            @if (d.match.winner === c) {
              <span class="hanko" aria-label="Ganador">勝</span>
            }
          </div>
          @if (c === 'aka') {
            <div class="score">
              <span class="n">{{ d.aka.score }}</span><span class="dash">–</span><span class="n">{{ d.ao.score }}</span>
              <span class="small muted">{{ resultText() }}</span>
            </div>
          }
        }
      </section>

      <section class="card" aria-labelledby="worm-title">
        <div class="chart-head">
          <h3 id="worm-title">Cómo se construyó el marcador</h3>
          <ul class="legend" aria-label="Leyenda">
            <li><span class="key aka"></span>AKA</li>
            <li><span class="key ao"></span>AO</li>
          </ul>
        </div>
        @if (points().length) {
          <div class="chart" (pointerleave)="hover.set(null)">
            <svg [attr.viewBox]="'0 0 ' + W + ' ' + H" role="img" [attr.aria-label]="chartLabel()" (pointermove)="onMove($event)">
              @for (t of yTicks(); track t) {
                <line class="grid" [attr.x1]="M.left" [attr.x2]="W - M.right" [attr.y1]="y(t)" [attr.y2]="y(t)" />
                <text class="tick" [attr.x]="M.left - 8" [attr.y]="y(t) + 4" text-anchor="end">{{ t }}</text>
              }
              @for (t of xTicks(); track t) {
                <text class="tick" [attr.x]="x(t)" [attr.y]="H - 8" text-anchor="middle">{{ mm(t) }}</text>
              }
              <line class="axis" [attr.x1]="M.left" [attr.x2]="W - M.right" [attr.y1]="y(0)" [attr.y2]="y(0)" />
              <path class="line ao" [attr.d]="path('ao')" />
              <path class="line aka" [attr.d]="path('aka')" />
              @for (p of points(); track p.event_id) {
                @if (p.type === 'point') {
                  <circle class="dot {{ p.color }}" [attr.cx]="x(p.elapsed)" [attr.cy]="y(p.color === 'aka' ? p.aka : p.ao)" r="4.5" />
                }
              }
              <text class="end aka" [attr.x]="W - M.right + 8" [attr.y]="endY('aka')">AKA {{ d.aka.score }}</text>
              <text class="end ao" [attr.x]="W - M.right + 8" [attr.y]="endY('ao')">AO {{ d.ao.score }}</text>
              @if (hover(); as h) {
                <line class="cross" [attr.x1]="x(h.elapsed)" [attr.x2]="x(h.elapsed)" [attr.y1]="M.top" [attr.y2]="y(0)" />
              }
            </svg>
            @if (hover(); as h) {
              <div class="tip" [style.left.%]="(100 * x(h.elapsed)) / W">
                <strong>{{ h.aka }}–{{ h.ao }}</strong>
                <span>{{ describe(h) }}</span>
                <span class="muted">{{ mm(h.elapsed) }} de reloj</span>
              </div>
            }
          </div>
        } @else {
          <p class="muted small">El combate no tiene puntos registrados.</p>
        }
      </section>

      <div class="cols">
        <section class="card" aria-label="Técnicas por lado">
          <h3>Técnicas</h3>
          <table class="table compact">
            <thead>
              <tr><th scope="col"></th><th scope="col" class="center">AKA</th><th scope="col" class="center">AO</th></tr>
            </thead>
            <tbody>
              @for (t of techRows; track t.key) {
                <tr>
                  <th scope="row">{{ t.label }}</th>
                  <td class="center num">{{ d.aka.techniques[t.key] }}</td>
                  <td class="center num">{{ d.ao.techniques[t.key] }}</td>
                </tr>
              }
              <tr>
                <th scope="row">Senshu</th>
                <td class="center">{{ d.senshu === 'aka' ? '先' : '' }}</td>
                <td class="center">{{ d.senshu === 'ao' ? '先' : '' }}</td>
              </tr>
            </tbody>
          </table>
          <p class="small muted">Tiempo de reloj: {{ mm(d.elapsed) }}@if (d.duration) { de {{ mm(d.duration) }}}</p>
        </section>
        <section class="card" aria-label="Momentos del combate">
          <h3>Momentos</h3>
          <ol class="moments">
            @for (p of points(); track p.event_id) {
              <li>
                <span class="t num">{{ mm(p.elapsed) }}</span>
                <span class="mark {{ p.color ?? '' }}"></span>
                <span class="grow">{{ describe(p) }}</span>
                <span class="num">{{ p.aka }}–{{ p.ao }}</span>
              </li>
            } @empty {
              <li class="muted small">Sin eventos de marcador.</li>
            }
          </ol>
          @if (d.match.parent_match_id) {
            <p class="small"><a [routerLink]="['/mesa', d.match.parent_match_id]">Ver el enfrentamiento por equipos</a></p>
          }
        </section>
      </div>
    } @else if (error()) {
      <p class="alert danger">{{ error() }}</p>
    }
    </div>
  `,
  styleUrl: './match-summary.scss',
})
export class MatchSummaryPage {
  private api = inject(ApiService);
  private toast = inject(ToastService);
  readonly id = input.required<string>();
  readonly data = signal<MatchSummary | null>(null);
  readonly error = signal('');
  readonly hover = signal<TimelinePoint | null>(null);

  readonly W = W;
  readonly H = H;
  readonly M = M;
  readonly colors: Color[] = ['aka', 'ao'];
  readonly fdate = fmtDate;
  readonly techRows = [
    { key: 'ippon', label: 'Ippon (3)' },
    { key: 'waza_ari', label: 'Waza-ari (2)' },
    { key: 'yuko', label: 'Yuko (1)' },
  ] as const;

  readonly points = computed(() => this.data()?.timeline.filter((p) => p.type !== 'sanction') ?? []);
  private readonly xMax = computed(() => {
    const d = this.data();
    return Math.max(d?.duration ?? 0, d?.elapsed ?? 0, ...this.points().map((p) => p.elapsed), 10);
  });
  private readonly yMax = computed(() => {
    const d = this.data();
    return Math.max(4, d?.aka.score ?? 0, d?.ao.score ?? 0);
  });
  readonly yTicks = computed(() => {
    const max = this.yMax();
    const step = max <= 6 ? 1 : max <= 12 ? 2 : 4;
    return Array.from({ length: Math.floor(max / step) + 1 }, (_, i) => i * step);
  });
  readonly xTicks = computed(() => {
    const max = this.xMax();
    const step = max <= 120 ? 30 : 60;
    return Array.from({ length: Math.floor(max / step) + 1 }, (_, i) => i * step);
  });

  readonly resultText = computed(() => {
    const d = this.data();
    if (!d) return '';
    if (d.match.status !== 'finished') return 'Combate en curso';
    if (d.match.method === 'draw') return 'Hikiwake (empate)';
    return `por ${METHOD_LABEL[d.match.method ?? ''] ?? d.match.method ?? ''}`;
  });

  readonly chartLabel = computed(() => {
    const d = this.data();
    if (!d) return '';
    return `Marcador acumulado en el tiempo: AKA termina con ${d.aka.score} y AO con ${d.ao.score}.`;
  });

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() =>
        this.api.get<MatchSummary>(`/matches/${id}/summary`).subscribe({
          next: (d) => this.data.set(d),
          error: (e) => this.error.set(ApiError.from(e).fullMessage),
        }),
      );
    });
  }

  x(t: number): number {
    return M.left + ((W - M.left - M.right) * t) / this.xMax();
  }

  y(v: number): number {
    return H - M.bottom - ((H - M.top - M.bottom) * v) / this.yMax();
  }

  mm(t: number): string {
    return mmss(Math.round(t));
  }

  /** Escalón: el marcador cambia en el instante del punto y se mantiene hasta el siguiente. */
  path(c: Color): string {
    const pts = this.points();
    let v = 0;
    let d = `M${this.x(0)},${this.y(0)}`;
    for (const p of pts) {
      const nv = c === 'aka' ? p.aka : p.ao;
      d += ` H${this.x(p.elapsed)}`;
      if (nv !== v) d += ` V${this.y(nv)}`;
      v = nv;
    }
    const d0 = this.data();
    return d + ` H${this.x(Math.max(d0?.elapsed ?? 0, pts.at(-1)?.elapsed ?? 0))}`;
  }

  /** Etiquetas finales separadas si los dos lados terminan con el mismo puntaje. */
  endY(c: Color): number {
    const d = this.data();
    if (!d) return 0;
    const ya = this.y(d.aka.score);
    const yo = this.y(d.ao.score);
    const close = Math.abs(ya - yo) < 14;
    const base = c === 'aka' ? ya : yo;
    if (!close) return base + 4;
    const upper = d.aka.score >= d.ao.score ? 'aka' : 'ao';
    return base + (c === upper ? -4 : 12);
  }

  onMove(ev: PointerEvent): void {
    const svg = ev.currentTarget as SVGSVGElement;
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    let best: TimelinePoint | null = null;
    let dist = Infinity;
    for (const p of this.points()) {
      const dx = Math.abs(this.x(p.elapsed) - px);
      if (dx < dist) {
        dist = dx;
        best = p;
      }
    }
    this.hover.set(best);
  }

  describe(p: TimelinePoint): string {
    const who = p.color ? p.color.toUpperCase() : '';
    if (p.type === 'point') return `${who} · ${POINT_LABEL[p.value ?? 0] ?? 'Punto'} +${p.value}`;
    if (p.type === 'finish') {
      const d = this.data();
      if (d?.match.method === 'draw' || !p.color) return 'Cierre: hikiwake';
      return `Cierre: gana ${who}`;
    }
    return who;
  }

  async share(): Promise<void> {
    const d = this.data();
    if (!d) return;
    try {
      const shared = await shareMatchCard(d, this.resultText());
      if (!shared) this.toast.ok('Imagen descargada');
    } catch {
      this.toast.error('No se pudo generar la imagen');
    }
  }
}
