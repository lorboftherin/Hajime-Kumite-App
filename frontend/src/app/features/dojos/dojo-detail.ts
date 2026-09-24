import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiError } from '../../core/api-error';
import { ApiService } from '../../core/api.service';
import { MEDAL_ICON, fmtDate } from '../../core/format';
import { Dojo, DojoHistory } from '../../core/models';

/** Ficha del dojo con su historial de medallas (GET /dojos/{id}/history). */
@Component({
  selector: 'app-dojo-detail',
  imports: [RouterLink],
  template: `
    <div class="container">
      <div class="small"><a routerLink="/dojos">← Dojos</a></div>
      @if (dojo(); as d) {
        <div class="page-header">
          <div>
            <h1>{{ d.name }}</h1>
            <div class="row small muted">
              @if (d.short_name) {
                <span class="mono">{{ d.short_name }}</span>
              }
              @if (d.city) {
                <span>{{ d.city }}</span>
              }
              @if (d.is_independent) {
                <span class="badge">Independiente</span>
              }
              @if (d.is_claimed) {
                <span class="badge ok">Registrado</span>
              }
            </div>
            @if (d.branches.length) {
              <div class="small">Sedes: {{ branchNames() }}</div>
            }
          </div>
          <a class="btn" [routerLink]="['/personas']" [queryParams]="{ dojo: d.id }">Ver competidores</a>
        </div>
      }

      @if (history(); as h) {
        <div class="card totals" aria-label="Medallero histórico">
          <div class="medal"><span class="icon">🥇</span><strong>{{ totals().gold }}</strong><span class="small muted">Oro</span></div>
          <div class="medal"><span class="icon">🥈</span><strong>{{ totals().silver }}</strong><span class="small muted">Plata</span></div>
          <div class="medal"><span class="icon">🥉</span><strong>{{ totals().bronze }}</strong><span class="small muted">Bronce</span></div>
          <div class="medal"><span class="icon">🏆</span><strong>{{ h.tournaments.length }}</strong><span class="small muted">Torneos con medalla</span></div>
        </div>

        @for (t of h.tournaments; track t.tournament_id) {
          <div class="card tour">
            <div class="tour-head">
              <div class="grow">
                <div class="small muted">{{ fdate(t.date) }}</div>
                <h3><a [routerLink]="['/torneos', t.tournament_id, 'resultados']">{{ t.tournament_name }}</a></h3>
              </div>
              <div class="row nowrap"><span>🥇 {{ t.gold }}</span><span>🥈 {{ t.silver }}</span><span>🥉 {{ t.bronze }}</span></div>
            </div>
            <table class="table small mt">
              <tbody>
                @for (r of t.results; track $index) {
                  <tr>
                    <td class="nowrap place">{{ medal[r.place] || r.place + '.º' }}</td>
                    <td>
                      @if (r.person_id) {
                        <a [routerLink]="['/personas', r.person_id]" [queryParams]="{ tab: 'historial' }">{{ r.name }}</a>
                      } @else {
                        {{ r.name }}
                      }
                    </td>
                    <td class="muted">{{ r.category_name }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @empty {
          <div class="card empty">
            <div class="big">🏆</div>
            <p><strong>Este dojo aún no tiene medallas en su historial.</strong></p>
            <p class="small">Los torneos de prueba no aparecen en el historial. Solo cuentan las categorías finalizadas de torneos oficiales.</p>
          </div>
        }
      } @else if (error()) {
        <div class="alert danger">{{ error() }}</div>
      } @else {
        <div class="empty"><span class="spinner"></span></div>
      }
    </div>
  `,
  styles: `
    .totals {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 0.5rem;
      margin-bottom: 1rem;
      max-width: 640px;
    }
    .medal {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.1rem;
      text-align: center;
      strong {
        font-size: 1.6rem;
        line-height: 1;
      }
    }
    .icon {
      font-size: 1.5rem;
    }
    .tour {
      margin-bottom: 0.75rem;
    }
    .tour-head {
      display: flex;
      gap: 1rem;
      align-items: flex-start;
      h3 {
        margin: 0.1rem 0 0;
      }
    }
    .place {
      width: 3rem;
    }
    .big {
      font-size: 2rem;
    }
  `,
})
export class DojoDetailPage {
  private api = inject(ApiService);
  readonly id = input.required<string>();

  readonly dojo = signal<Dojo | null>(null);
  readonly history = signal<DojoHistory | null>(null);
  readonly error = signal('');
  readonly fdate = fmtDate;
  readonly medal = MEDAL_ICON;
  readonly branchNames = computed(() => (this.dojo()?.branches ?? []).map((b) => b.name).join(', '));
  readonly totals = computed(() =>
    (this.history()?.tournaments ?? []).reduce(
      (acc, t) => ({ gold: acc.gold + t.gold, silver: acc.silver + t.silver, bronze: acc.bronze + t.bronze }),
      { gold: 0, silver: 0, bronze: 0 },
    ),
  );

  constructor() {
    effect(() => {
      const id = Number(this.id());
      if (!id) return;
      this.dojo.set(null);
      this.history.set(null);
      this.error.set('');
      this.api.get<Dojo>(`/dojos/${id}`).subscribe({ next: (d) => this.dojo.set(d), error: () => {} });
      this.api.get<DojoHistory>(`/dojos/${id}/history`).subscribe({
        next: (h) => this.history.set(h),
        error: (e) => this.error.set(ApiError.from(e).fullMessage),
      });
    });
  }
}
