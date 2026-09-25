import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../../core/api.service';
import { mmss } from '../../../core/format';
import { LeaderRow, Leaders, TournamentLeaders } from '../../../core/models';
import { TournamentContext } from '../tournament-context';

type BoardKey = 'mvp' | 'wins' | 'ippon' | 'points' | 'senshu' | 'fastest_win';

const BOARDS: Array<{ key: BoardKey; label: string; stat: string }> = [
  { key: 'mvp', label: 'Índice Hajime', stat: 'Índice' },
  { key: 'wins', label: 'Victorias', stat: 'Victorias' },
  { key: 'ippon', label: 'Ippon', stat: 'Ippon' },
  { key: 'points', label: 'Puntos', stat: 'Puntos' },
  { key: 'senshu', label: 'Senshu', stat: 'Senshu' },
  { key: 'fastest_win', label: 'Más rápida', stat: 'Tiempo' },
];

const AWARD_KANJI: Record<string, string> = { mvp: '賞', ippon: '一', fastest: '速', senshu: '先', kata: '型' };

/**
 * Líderes y premios del torneo (GET /tournaments/{id}/leaders): los «héroes»
 * del evento al estilo de CricHeroes, calculados de los eventos de la mesa.
 */
@Component({
  selector: 'app-leaders-tab',
  imports: [RouterLink],
  template: `
    @if (data(); as d) {
      @if (d.is_test) {
        <div class="alert info">Torneo de prueba: no genera premios ni líderes (no cuenta para las estadísticas).</div>
      }
      @if (d.awards.length) {
        <h2 class="section-title">Premios del torneo</h2>
        <div class="awards">
          @for (a of d.awards; track a.title) {
            <article class="card award">
              <span class="seal" aria-hidden="true">{{ kanji(a.code) }}</span>
              <div class="grow">
                <div class="eyebrow">{{ a.title }} · <span class="value">{{ a.value }}</span></div>
                @if (a.person_id) {
                  <a class="who" [routerLink]="['/personas', a.person_id]">{{ a.name }}</a>
                } @else {
                  <span class="who">{{ a.name }}</span>
                }
                <div class="small muted">{{ a.dojo }}</div>
                <div class="small muted">{{ a.detail }}</div>
              </div>
            </article>
          }
        </div>
      } @else if (!d.is_test) {
        <div class="empty">
          <p><strong>Todavía no hay premios.</strong></p>
          Aparecen solos a medida que la mesa cierra combates de kumite o registra notas de kata.
        </div>
      }

      @if (!d.is_test) {
        <h2 class="section-title">Líderes</h2>
        <div class="seg" role="tablist" aria-label="Tabla de líderes">
          @for (b of boards; track b.key) {
            <button role="tab" [attr.aria-selected]="board() === b.key" [class.on]="board() === b.key" (click)="board.set(b.key)">
              {{ b.label }}
            </button>
          }
        </div>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th class="center">#</th>
                <th>Competidor</th>
                <th>Dojo o equipo</th>
                <th class="right">{{ current().stat }}</th>
                <th class="right">Combates</th>
                <th class="right">Victorias</th>
                <th class="center">Medallas</th>
              </tr>
            </thead>
            <tbody>
              @for (r of rows(); track r.person_id; let i = $index) {
                <tr>
                  <td class="center rank" [class.top]="i < 3">{{ i + 1 }}</td>
                  <td><a class="who" [routerLink]="['/personas', r.person_id]">{{ r.name }}</a></td>
                  <td>{{ r.dojo }}</td>
                  <td class="right stat">{{ value(r) }}</td>
                  <td class="right">{{ r.matches }}</td>
                  <td class="right">{{ r.wins }}</td>
                  <td class="center medals">
                    @if (r.medals.gold) {<span class="m gold" title="Oro">{{ r.medals.gold }}</span>}
                    @if (r.medals.silver) {<span class="m silver" title="Plata">{{ r.medals.silver }}</span>}
                    @if (r.medals.bronze) {<span class="m bronze" title="Bronce">{{ r.medals.bronze }}</span>}
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="7" class="empty">Sin datos todavía.</td></tr>
              }
            </tbody>
          </table>
        </div>
        @if (board() === 'mvp') {
          <p class="small muted note">
            Índice Hajime: victoria {{ d.leaders.mvp_weights['win'] }}, oro {{ d.leaders.mvp_weights['gold'] }}, plata
            {{ d.leaders.mvp_weights['silver'] }}, bronce {{ d.leaders.mvp_weights['bronze'] }}, ippon {{ d.leaders.mvp_weights['ippon'] }},
            waza-ari {{ d.leaders.mvp_weights['waza_ari'] }}, yuko {{ d.leaders.mvp_weights['yuko'] }}, senshu {{ d.leaders.mvp_weights['senshu'] }};
            cada punto recibido resta {{ -d.leaders.mvp_weights['point_against'] }}. Sirve para reconocer, no es un ranking oficial.
          </p>
        }
      }
    }
  `,
  styles: `
    .awards {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr));
      gap: 1rem;
      margin-bottom: 1.5rem;
    }
    .award {
      display: flex;
      align-items: flex-start;
      gap: 1rem;
      margin: 0;
    }
    .seal {
      flex: none;
      display: grid;
      place-items: center;
      width: 3rem;
      height: 3rem;
      border-radius: 6px;
      background: var(--shu);
      color: #fff;
      font-family: var(--font-display);
      font-weight: 800;
      font-size: 1.5rem;
      transform: rotate(-4deg);
    }
    .who {
      display: block;
      font-family: var(--font-display);
      font-weight: 700;
      font-size: 1.15rem;
      color: var(--sumi);
    }
    a.who:hover {
      color: var(--ai-ink);
    }
    .value {
      color: var(--sumi);
      font-weight: 800;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      letter-spacing: 0;
      text-transform: none;
    }
    .seg {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem;
      margin-bottom: 0.75rem;
      button {
        border: 1px solid var(--kasumi-2);
        background: var(--kinu);
        border-radius: 999px;
        padding: 0.35rem 0.9rem;
        font: inherit;
        font-size: var(--fs-14);
        cursor: pointer;
        color: var(--sumi-2);
        &.on {
          background: var(--sumi);
          border-color: var(--sumi);
          color: var(--kinu);
        }
      }
    }
    .rank {
      font-weight: 700;
      color: var(--nezumi-ink);
      &.top {
        color: var(--shu-ink, var(--shu));
      }
    }
    .stat {
      font-weight: 800;
      font-variant-numeric: tabular-nums;
    }
    td .who {
      font-size: 1rem;
    }
    .medals .m {
      display: inline-grid;
      place-items: center;
      min-width: 1.4rem;
      height: 1.4rem;
      margin: 0 0.1rem;
      border-radius: 50%;
      font-size: 0.75rem;
      font-weight: 800;
      color: #fff;
      &.gold {
        background: var(--kin);
      }
      &.silver {
        background: var(--gin);
      }
      &.bronze {
        background: var(--dou);
      }
    }
    .note {
      margin-top: 0.75rem;
      max-width: 60rem;
    }
  `,
})
export class LeadersTab {
  private api = inject(ApiService);
  private ctx = inject(TournamentContext);
  readonly data = signal<TournamentLeaders | null>(null);
  readonly boards = BOARDS;
  readonly board = signal<BoardKey>('mvp');
  readonly current = computed(() => BOARDS.find((b) => b.key === this.board())!);
  readonly rows = computed<LeaderRow[]>(() => (this.data()?.leaders as Leaders | undefined)?.[this.board()] ?? []);

  constructor() {
    this.api.get<TournamentLeaders>(`/tournaments/${this.ctx.id()}/leaders`).subscribe({
      next: (d) => this.data.set(d),
      error: () => {},
    });
  }

  kanji(code?: string): string {
    return AWARD_KANJI[code ?? ''] ?? '賞';
  }

  value(r: LeaderRow): string {
    switch (this.board()) {
      case 'mvp':
        return String(r.mvp_index);
      case 'wins':
        return String(r.wins);
      case 'ippon':
        return String(r.ippon);
      case 'points':
        return String(r.points);
      case 'senshu':
        return String(r.senshu);
      default:
        return r.fastest_win !== null ? mmss(Math.round(r.fastest_win)) : '—';
    }
  }
}
