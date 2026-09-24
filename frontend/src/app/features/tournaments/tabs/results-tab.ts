import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../../core/api.service';
import { FilesService } from '../../../core/files.service';
import { CategoryResult, MedalTable } from '../../../core/models';
import { StatusBadge } from '../../../shared/badge';
import { Hanko } from '../../../shared/hanko';
import { Icon } from '../../../shared/icon';
import { TournamentContext } from '../tournament-context';


@Component({
  selector: 'app-results-tab',
  imports: [RouterLink, StatusBadge, Hanko, Icon],
  template: `
    <div class="toolbar">
      <span class="grow"></span>
      <button class="btn icon-only ghost" (click)="load()" title="Actualizar" aria-label="Actualizar"><app-icon name="refresh" /></button>
      <button class="btn" (click)="files.download('/tournaments/' + ctx.id() + '/results.xlsx', 'resultados-' + ctx.id() + '.xlsx')"><app-icon name="download" /> Excel</button>
      <button class="btn" (click)="files.open('/tournaments/' + ctx.id() + '/results.pdf')"><app-icon name="print" /> PDF</button>
    </div>
    <div class="layout">
      <section>
        <h2 class="section-title"><span class="kanji" aria-hidden="true">結果</span> Resultados por categoría</h2>
        @for (c of shown(); track c.category_id) {
          <article class="card cat">
            <header class="cat-head">
              <h3>{{ c.category_name }}</h3>
              <app-status [status]="c.status" />
              @if (['ready', 'in_progress', 'finished'].includes(c.status)) {
                <a class="btn sm ghost" [routerLink]="['/categorias', c.category_id, 'llave']">Llave</a>
              }
            </header>
            @if (c.places.length) {
              <ol class="podium" aria-label="Podio">
                @for (p of c.places; track p.registration_id) {
                  <li>
                    <app-hanko [place]="p.place" />
                    <span class="pname">{{ p.name }}</span>
                    <a class="dojo" [routerLink]="['/dojos', p.dojo_id]">{{ p.dojo_name }}</a>
                  </li>
                }
              </ol>
            } @else {
              <div class="muted small">Sin resultados todavía.</div>
            }
          </article>
        } @empty {
          <div class="card empty"><p><strong>Aún no hay resultados.</strong></p>Aparecerán aquí a medida que terminen los combates.</div>
        }
        @if (pending().length) {
          <details class="pending card quiet">
            <summary>{{ pending().length }} categorías aún sin resultados</summary>
            <ul>
              @for (c of pending(); track c.category_id) {
                <li>
                  <span class="grow">{{ c.category_name }}</span>
                  <app-status [status]="c.status" />
                  @if (['ready', 'in_progress', 'finished'].includes(c.status)) {
                    <a class="btn sm ghost" [routerLink]="['/categorias', c.category_id, 'llave']">Llave</a>
                  }
                </li>
              }
            </ul>
          </details>
        }
      </section>
      <section class="medals">
        <h2 class="section-title">Medallero por dojo</h2>
        @if (medals()?.is_test) {
          <div class="alert warn small">Torneo de prueba: el medallero no cuenta para historial ni estadísticas.</div>
        }
        <div class="table-wrap">
          <table class="table medal-table">
            <thead>
              <tr>
                <th class="center">#</th>
                <th>Dojo</th>
                <th class="center"><span class="ring kin" aria-hidden="true"></span><span class="sr-only">Oro</span></th>
                <th class="center"><span class="ring gin" aria-hidden="true"></span><span class="sr-only">Plata</span></th>
                <th class="center"><span class="ring dou" aria-hidden="true"></span><span class="sr-only">Bronce</span></th>
                <th class="center">Total</th>
              </tr>
            </thead>
            <tbody>
              @for (r of medals()?.rows ?? []; track r.dojo_id) {
                <tr>
                  <td class="center rank">{{ r.rank }}</td>
                  <td><a [routerLink]="['/dojos', r.dojo_id]" title="Historial del dojo">{{ r.dojo_name }}</a></td>
                  <td class="center" [class.zero]="!r.gold">{{ r.gold }}</td>
                  <td class="center" [class.zero]="!r.silver">{{ r.silver }}</td>
                  <td class="center" [class.zero]="!r.bronze">{{ r.bronze }}</td>
                  <td class="center total">{{ r.total }}</td>
                </tr>
              } @empty {
                <tr><td colspan="6" class="empty">Sin medallas todavía. Solo cuentan las categorías finalizadas.</td></tr>
              }
            </tbody>
          </table>
        </div>
        <p class="hint legend"><span class="ring kin"></span> Oro <span class="ring gin"></span> Plata <span class="ring dou"></span> Bronce</p>
      </section>
    </div>
  `,
  styles: `
    .layout {
      display: grid;
      grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
      gap: 2rem;
      align-items: start;
    }
    @media (max-width: 1000px) {
      .layout {
        grid-template-columns: 1fr;
      }
    }
    .section-title .kanji {
      font-weight: 500;
      color: var(--nezumi);
      font-size: var(--fs-16);
      letter-spacing: 0.1em;
    }
    .cat {
      padding: 1.1rem 1.35rem;
      margin-bottom: 0.9rem;
    }
    .cat-head {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      flex-wrap: wrap;
      h3 {
        margin: 0;
        flex: 1;
        font-size: var(--fs-16);
      }
    }
    .podium {
      list-style: none;
      margin: 0.85rem 0 0;
      padding: 0;
      li {
        display: grid;
        grid-template-columns: 2.25rem minmax(0, 1fr) auto;
        align-items: center;
        gap: 0.75rem;
        padding: 0.5rem 0;
        border-top: 1px solid var(--kasumi);
        font-size: var(--fs-14);
      }
      .pname {
        font-weight: 700;
      }
      .dojo {
        color: var(--nezumi-ink);
        text-align: right;
      }
      .dojo:hover {
        color: var(--ai-ink);
      }
    }
    .pending {
      padding: 0.9rem 1.35rem;
      summary {
        color: var(--sumi-2);
      }
      ul {
        list-style: none;
        margin: 0.75rem 0 0;
        padding: 0;
      }
      li {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.5rem 0;
        border-top: 1px solid var(--kasumi);
        font-size: var(--fs-14);
      }
    }
    .medal-table {
      th:nth-child(n + 3),
      td:nth-child(n + 3) {
        width: 3.25rem;
        padding-left: 0.4rem;
        padding-right: 0.4rem;
      }
      .rank {
        font-family: var(--font-display);
        font-weight: 700;
        color: var(--sumi-2);
        width: 3rem;
      }
      td.zero {
        color: var(--nezumi);
      }
      .total {
        font-weight: 700;
      }
      a {
        color: var(--sumi);
        font-weight: 500;
      }
      a:hover {
        color: var(--ai-ink);
      }
    }
    .ring {
      display: inline-block;
      width: 0.75rem;
      height: 0.75rem;
      border-radius: 50%;
      border: 2.5px solid;
      vertical-align: -0.1rem;
      &.kin {
        border-color: var(--kin);
      }
      &.gin {
        border-color: var(--gin);
      }
      &.dou {
        border-color: var(--dou);
      }
    }
    .legend {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      .ring + .ring,
      .ring {
        margin-left: 0.5rem;
      }
      .ring:first-child {
        margin-left: 0;
      }
    }
  `,
})
export class ResultsTab {
  readonly ctx = inject(TournamentContext);
  readonly files = inject(FilesService);
  private api = inject(ApiService);

  readonly results = signal<CategoryResult[]>([]);
  readonly medals = signal<MedalTable | null>(null);
  /** Con podio: a la vista. Sin resultados aún: plegadas al final (revelar de a poco). */
  readonly shown = computed(() => this.results().filter((c) => c.places.length > 0));
  readonly pending = computed(() =>
    this.results().filter((c) => !c.places.length && !['empty', 'merged', 'cancelled'].includes(c.status)),
  );

  constructor() {
    this.load();
  }

  load(): void {
    this.api.get<CategoryResult[]>(`/tournaments/${this.ctx.id()}/results`).subscribe({ next: (r) => this.results.set(r), error: () => {} });
    this.api.get<MedalTable>(`/tournaments/${this.ctx.id()}/medal-table`).subscribe({ next: (m) => this.medals.set(m), error: () => {} });
  }
}
