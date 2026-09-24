import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../../core/api.service';
import { FilesService } from '../../../core/files.service';
import { CategoryResult, MedalTable } from '../../../core/models';
import { StatusBadge } from '../../../shared/badge';
import { TournamentContext } from '../tournament-context';

const MEDAL: Record<number, string> = { 1: '🥇 Oro', 2: '🥈 Plata', 3: '🥉 Bronce' };

@Component({
  selector: 'app-results-tab',
  imports: [RouterLink, StatusBadge],
  template: `
    <div class="row mb">
      <button class="btn" (click)="files.download('/tournaments/' + ctx.id() + '/results.xlsx', 'resultados-' + ctx.id() + '.xlsx')">⬇ Resultados Excel</button>
      <button class="btn" (click)="files.open('/tournaments/' + ctx.id() + '/results.pdf')">🖨 Resultados PDF</button>
      <button class="btn sm" (click)="load()">↻ Actualizar</button>
    </div>
    <div class="layout">
      <section>
        <h3>Resultados por categoría</h3>
        <label class="field inline small mb"><input type="checkbox" [checked]="onlyWithResults()" (change)="onlyWithResults.set(!onlyWithResults())" /> Solo categorías con resultados</label>
        @for (c of shown(); track c.category_id) {
          <div class="card cat">
            <div class="row">
              <strong class="grow">{{ c.category_name }}</strong>
              <app-status [status]="c.status" />
              @if (['ready', 'in_progress', 'finished'].includes(c.status)) {
                <a class="btn sm" [routerLink]="['/categorias', c.category_id, 'llave']">Llave</a>
              }
            </div>
            @if (c.places.length) {
              <table class="table mt">
                <tbody>
                  @for (p of c.places; track p.registration_id) {
                    <tr>
                      <td class="nowrap medal">{{ medal(p.place) }}</td>
                      <td>{{ p.name }}</td>
                      <td class="muted"><a class="muted" [routerLink]="['/dojos', p.dojo_id]">{{ p.dojo_name }}</a></td>
                    </tr>
                  }
                </tbody>
              </table>
            } @else {
              <div class="muted small">Sin resultados todavía.</div>
            }
          </div>
        } @empty {
          <div class="card empty">Aún no hay resultados.</div>
        }
      </section>
      <section>
        <h3>Medallero por dojo</h3>
        @if (medals()?.is_test) {
          <div class="alert warn small">Torneo de prueba: el medallero no cuenta para historial ni estadísticas.</div>
        }
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr><th>#</th><th>Dojo</th><th class="center">🥇</th><th class="center">🥈</th><th class="center">🥉</th><th class="center">Total</th></tr>
            </thead>
            <tbody>
              @for (r of medals()?.rows ?? []; track r.dojo_id) {
                <tr>
                  <td>{{ r.rank }}</td>
                  <td><a [routerLink]="['/dojos', r.dojo_id]" title="Historial del dojo">{{ r.dojo_name }}</a></td>
                  <td class="center">{{ r.gold }}</td>
                  <td class="center">{{ r.silver }}</td>
                  <td class="center">{{ r.bronze }}</td>
                  <td class="center"><strong>{{ r.total }}</strong></td>
                </tr>
              } @empty {
                <tr><td colspan="6" class="empty">Sin medallas (solo cuentan categorías finalizadas).</td></tr>
              }
            </tbody>
          </table>
        </div>
      </section>
    </div>
  `,
  styles: `
    .layout {
      display: grid;
      grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
      gap: 1.25rem;
      align-items: start;
    }
    @media (max-width: 900px) {
      .layout {
        grid-template-columns: 1fr;
      }
    }
    .cat {
      padding: 0.75rem;
      margin-bottom: 0.6rem;
    }
    .medal {
      width: 7rem;
    }
  `,
})
export class ResultsTab {
  readonly ctx = inject(TournamentContext);
  readonly files = inject(FilesService);
  private api = inject(ApiService);

  readonly results = signal<CategoryResult[]>([]);
  readonly medals = signal<MedalTable | null>(null);
  readonly onlyWithResults = signal(false);
  readonly shown = computed(() =>
    this.results().filter((c) =>
      this.onlyWithResults() ? c.places.length > 0 : !['empty', 'merged', 'cancelled'].includes(c.status),
    ),
  );

  constructor() {
    this.load();
  }

  load(): void {
    this.api.get<CategoryResult[]>(`/tournaments/${this.ctx.id()}/results`).subscribe({ next: (r) => this.results.set(r), error: () => {} });
    this.api.get<MedalTable>(`/tournaments/${this.ctx.id()}/medal-table`).subscribe({ next: (m) => this.medals.set(m), error: () => {} });
  }

  medal(place: number): string {
    return MEDAL[place] ?? `${place}.º`;
  }
}
