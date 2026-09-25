import { Component, computed, effect, input, inject, signal, untracked } from '@angular/core';
import { ApiService } from '../core/api.service';
import { METHOD_LABEL, mmss } from '../core/format';
import { PersonStats } from '../core/models';

const TECH = [
  { key: 'ippon', label: 'Ippon', pts: 3 },
  { key: 'waza_ari', label: 'Waza-ari', pts: 2 },
  { key: 'yuko', label: 'Yuko', pts: 1 },
] as const;

const FORM = { win: { k: '勝', t: 'Ganó' }, loss: { k: '負', t: 'Perdió' }, draw: { k: '分', t: 'Empate' } } as const;

/**
 * Perfil deportivo (GET /persons/{id}/stats): números de kumite, técnicas,
 * forma reciente, índice Hajime e insignias. Idea tomada de los perfiles de
 * jugador de CricHeroes, calculado a partir de los eventos de la mesa.
 */
@Component({
  selector: 'app-person-stats',
  template: `
    @if (stats(); as s) {
      @let k = s.kumite;
      <section class="card profile" aria-label="Perfil deportivo">
        <div class="head">
          <div>
            <h3>Perfil deportivo</h3>
            <p class="muted small">Kumite en torneos oficiales · {{ s.tournaments }} torneo(s)</p>
          </div>
          @if (s.form.length) {
            <div class="form" aria-label="Últimos combates">
              <span class="small muted">Forma</span>
              @for (r of s.form; track $index) {
                <span class="f {{ r }}" [title]="formInfo[r].t">{{ formInfo[r].k }}</span>
              }
            </div>
          }
          <div class="index" title="Índice Hajime: victorias y podios pesan más que la técnica; recibir puntos resta un poco.">
            <span class="num">{{ s.mvp_index }}</span>
            <span class="small muted">índice Hajime</span>
          </div>
        </div>

        @if (k.matches) {
          <div class="tiles">
            <div class="tile"><span class="v">{{ k.matches }}</span><span class="l">Combates</span></div>
            <div class="tile"><span class="v">{{ k.wins }}<small>–{{ k.losses }}@if (k.draws) {–{{ k.draws }}}</small></span><span class="l">Ganados–perdidos</span></div>
            <div class="tile"><span class="v">{{ k.win_pct }}<small>%</small></span><span class="l">Victorias</span></div>
            <div class="tile"><span class="v">{{ k.avg_points }}</span><span class="l">Puntos por combate</span></div>
            <div class="tile"><span class="v">{{ k.senshu_pct ?? '—' }}@if (k.senshu_pct !== null) {<small>%</small>}</span><span class="l">Senshu (primera ventaja)</span></div>
            <div class="tile"><span class="v">{{ k.longest_streak }}</span><span class="l">Racha de victorias</span></div>
            <div class="tile"><span class="v">{{ k.fastest_win !== null ? mmss(k.fastest_win) : '—' }}</span><span class="l">Victoria más rápida</span></div>
            @if (s.best_kata_score !== null) {
              <div class="tile"><span class="v">{{ s.best_kata_score.toFixed(1) }}</span><span class="l">Mejor nota de kata</span></div>
            }
          </div>

          <div class="cols">
            <div>
              <h4>Técnicas</h4>
              <table class="tech">
                <thead>
                  <tr><th scope="col"><span class="sr-only">Técnica</span></th><th scope="col">Marcadas</th><th scope="col" class="right">Recibidas</th></tr>
                </thead>
                <tbody>
                  @for (t of tech; track t.key) {
                    <tr>
                      <th scope="row">{{ t.label }} <span class="muted small">{{ t.pts }} pt</span></th>
                      <td>
                        <span class="bar-wrap" [title]="t.label + ': ' + k.techniques[t.key] + ' marcadas'">
                          <span class="bar" [style.width.%]="pct(k.techniques[t.key])"></span>
                          <span class="bv">{{ k.techniques[t.key] }}</span>
                        </span>
                      </td>
                      <td class="right muted">{{ k.techniques_against[t.key] }}</td>
                    </tr>
                  }
                </tbody>
              </table>
              <p class="small muted">Puntos a favor {{ k.points_for }} · en contra {{ k.points_against }}</p>
            </div>
            <div>
              <h4>Cómo gana</h4>
              @if (methods().length) {
                <ul class="methods">
                  @for (m of methods(); track m.key) {
                    <li><span>{{ m.label }}</span><span class="num">{{ m.n }}</span></li>
                  }
                </ul>
              } @else {
                <p class="small muted">Todavía sin victorias.</p>
              }
            </div>
          </div>
        } @else {
          <p class="muted small">Todavía no tiene combates de kumite cerrados en torneos oficiales.</p>
        }

        <h4>Insignias <span class="muted small">{{ earned() }} de {{ s.badges.length }}</span></h4>
        <ul class="badges">
          @for (b of s.badges; track b.code) {
            <li [class.on]="b.earned" [title]="b.description + (b.earned ? '' : ' (pendiente)')">
              <span class="seal" aria-hidden="true">{{ b.kanji }}</span>
              <span class="bn">{{ b.name }}</span>
              <span class="sr-only">{{ b.earned ? 'obtenida' : 'pendiente' }}: {{ b.description }}</span>
            </li>
          }
        </ul>
      </section>
    }
  `,
  styles: `
    .profile {
      margin-bottom: 1.5rem;
    }
    .head {
      display: flex;
      align-items: center;
      gap: 1.5rem;
      flex-wrap: wrap;
      h3 {
        margin: 0;
      }
      p {
        margin: 0.15rem 0 0;
      }
      > div:first-child {
        flex: 1;
        min-width: 12rem;
      }
    }
    .form {
      display: flex;
      align-items: center;
      gap: 0.3rem;
    }
    .f {
      display: inline-grid;
      place-items: center;
      width: 1.75rem;
      height: 1.75rem;
      border-radius: 5px;
      font-family: var(--font-display);
      font-weight: 700;
      font-size: 0.95rem;
      border: 1px solid var(--kasumi-2);
      color: var(--nezumi-ink);
      &.win {
        background: var(--sumi);
        border-color: var(--sumi);
        color: var(--kinu);
      }
    }
    .index {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      .num {
        font-family: var(--font-display);
        font-weight: 800;
        font-size: 2.2rem;
        line-height: 1;
      }
    }
    .tiles {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(8.5rem, 1fr));
      gap: 0.75rem;
      margin: 1.25rem 0;
    }
    .tile {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
      padding: 0.75rem 0.9rem;
      border: 1px solid var(--kasumi);
      border-radius: var(--radius-sm);
      background: var(--washi);
      .v {
        font-weight: 800;
        font-size: 1.5rem;
        font-variant-numeric: tabular-nums;
        line-height: 1.1;
        small {
          font-size: 0.9rem;
          font-weight: 600;
          color: var(--sumi-2);
        }
      }
      .l {
        font-size: var(--fs-12, 0.75rem);
        color: var(--nezumi-ink);
      }
    }
    .cols {
      display: grid;
      grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
      gap: 1.5rem;
      margin-bottom: 1rem;
    }
    @media (max-width: 720px) {
      .cols {
        grid-template-columns: 1fr;
      }
    }
    h4 {
      margin: 0.5rem 0 0.6rem;
      font-size: var(--fs-14);
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--sumi-2);
    }
    .tech {
      width: 100%;
      border-collapse: collapse;
      th,
      td {
        padding: 0.35rem 0.25rem;
        text-align: left;
        font-weight: 500;
      }
      thead th {
        font-size: var(--fs-12, 0.75rem);
        color: var(--nezumi-ink);
        font-weight: 500;
      }
      tbody th {
        white-space: nowrap;
        width: 1%;
        padding-right: 1rem;
      }
      .right {
        text-align: right;
      }
    }
    .bar-wrap {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .bar {
      height: 10px;
      min-width: 2px;
      border-radius: 0 4px 4px 0;
      background: var(--sumi-2);
    }
    .bv {
      font-variant-numeric: tabular-nums;
      font-weight: 700;
    }
    .methods {
      list-style: none;
      margin: 0;
      padding: 0;
      li {
        display: flex;
        justify-content: space-between;
        padding: 0.35rem 0;
        border-bottom: 1px solid var(--kasumi);
      }
      .num {
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }
    }
    .badges {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(6.5rem, 1fr));
      gap: 0.75rem;
      li {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.35rem;
        text-align: center;
        opacity: 0.45;
        &.on {
          opacity: 1;
        }
      }
      .seal {
        display: grid;
        place-items: center;
        width: 3rem;
        height: 3rem;
        border-radius: 50%;
        border: 1.5px dashed var(--nezumi);
        font-family: var(--font-display);
        font-size: 1.35rem;
        font-weight: 700;
        color: var(--nezumi-ink);
      }
      li.on .seal {
        border: 0;
        background: var(--shu);
        color: #fff;
        box-shadow: 0 0 0 3px var(--kinu), 0 0 0 4px var(--shu);
        transform: rotate(-4deg);
      }
      .bn {
        font-size: var(--fs-12, 0.75rem);
        font-weight: 600;
        color: var(--sumi-2);
      }
    }
  `,
})
export class PersonStatsView {
  private api = inject(ApiService);
  readonly personId = input.required<number>();
  readonly stats = signal<PersonStats | null>(null);
  readonly tech = TECH;
  readonly formInfo = FORM;
  readonly mmss = (s: number) => mmss(Math.round(s));

  readonly earned = computed(() => this.stats()?.badges.filter((b) => b.earned).length ?? 0);
  readonly methods = computed(() => {
    const s = this.stats();
    if (!s) return [];
    return Object.entries(s.kumite.wins_by_method)
      .map(([key, n]) => ({ key, n, label: METHOD_LABEL[key] ?? key }))
      .sort((a, b) => b.n - a.n);
  });
  private readonly maxTech = computed(() => {
    const k = this.stats()?.kumite;
    return k ? Math.max(1, k.techniques.ippon, k.techniques.waza_ari, k.techniques.yuko) : 1;
  });

  constructor() {
    effect(() => {
      const id = this.personId();
      untracked(() =>
        this.api.get<PersonStats>(`/persons/${id}/stats`).subscribe({ next: (s) => this.stats.set(s), error: () => {} }),
      );
    });
  }

  pct(n: number): number {
    return (100 * n) / this.maxTech();
  }
}
