import { Component, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiError } from '../../core/api-error';
import { ApiService } from '../../core/api.service';
import { MEDAL_ICON, METHOD_LABEL, REGISTRATION_STATUS, fmtDate, placeLabel, scoreText } from '../../core/format';
import { PersonHistory } from '../../core/models';

/** Historial deportivo de una persona (GET /persons/{id}/history). Foto al momento de cada torneo. */
@Component({
  selector: 'app-person-history',
  imports: [RouterLink],
  template: `
    @if (history(); as h) {
      <div class="summary">
        <div class="card medals" aria-label="Medallero personal">
          <div class="medal"><span class="icon">🥇</span><strong>{{ h.medals.gold }}</strong><span class="small muted">Oro</span></div>
          <div class="medal"><span class="icon">🥈</span><strong>{{ h.medals.silver }}</strong><span class="small muted">Plata</span></div>
          <div class="medal"><span class="icon">🥉</span><strong>{{ h.medals.bronze }}</strong><span class="small muted">Bronce</span></div>
          <div class="medal"><span class="icon">🥋</span><strong>{{ h.tournaments.length }}</strong><span class="small muted">Categorías</span></div>
        </div>
        <div class="card grades">
          <h3>Grados</h3>
          @if (h.grades.length) {
            <ol class="timeline">
              @for (g of h.grades; track $index; let last = $last) {
                <li [class.current]="last">
                  <strong>{{ g.grade }}</strong>
                  <span class="small muted">{{ fdate(g.awarded_on) }}</span>
                </li>
              }
            </ol>
          } @else {
            <p class="muted small">Sin grados registrados.</p>
          }
        </div>
      </div>

      @for (t of h.tournaments; track t.tournament_id + '-' + t.category_id) {
        <div class="card tour">
          <div class="tour-head">
            <div class="grow">
              <div class="small muted">{{ fdate(t.date) }}</div>
              <h3><a [routerLink]="['/torneos', t.tournament_id]">{{ t.tournament_name }}</a></h3>
              <div class="small">
                <a [routerLink]="['/categorias', t.category_id, 'llave']">{{ t.category_name }}</a>
                @if (t.merged) {
                  <span class="badge info" title="La categoría original se fusionó con otra">Categoría fusionada</span>
                }
                @if (t.status !== 'active') {
                  <span class="badge warn">{{ regStatus[t.status] || t.status }}</span>
                }
              </div>
              <div class="small muted">
                {{ t.dojo_name || 'Sin dojo' }} · {{ t.grade || 'grado s/d' }}@if (t.weight_class) { · {{ t.weight_class }}}
              </div>
            </div>
            <div class="place" [class.podium]="t.place && t.place <= 3">{{ place(t.place) }}</div>
          </div>
          @if (t.matches.length) {
            <table class="table small fights">
              <thead><tr><th></th><th>Combate</th><th>Resultado</th><th class="center">Marcador</th><th>Rival</th><th>Forma</th></tr></thead>
              <tbody>
                @for (m of t.matches; track m.match_id) {
                  <tr>
                    <td><span class="dot" [class.aka]="m.color === 'aka'" [class.ao]="m.color === 'ao'" [title]="m.color === 'aka' ? 'Aka' : 'Ao'"></span></td>
                    <td class="mono">{{ m.code }}</td>
                    <td>
                      @if (m.won) {
                        <span class="badge ok">Ganó</span>
                      } @else {
                        <span class="badge danger">Perdió</span>
                      }
                    </td>
                    <td class="center mono nowrap">{{ score(m.score) }}</td>
                    <td>
                      {{ m.opponent || '—' }}
                      @if (m.opponent_dojo) {
                        <span class="muted"> · {{ m.opponent_dojo }}</span>
                      }
                    </td>
                    <td class="muted">{{ m.method ? methodLabel[m.method] || m.method : '—' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <p class="muted small">Sin combates finalizados en esta categoría.</p>
          }
        </div>
      } @empty {
        <div class="card empty">
          <div class="big">🥋</div>
          <p><strong>Aún no tiene torneos en su historial.</strong></p>
          <p class="small">Los torneos de prueba no aparecen en el historial. Solo cuentan los torneos oficiales.</p>
        </div>
      }
    } @else if (error()) {
      <div class="alert danger">{{ error() }}</div>
    } @else {
      <div class="empty"><span class="spinner"></span></div>
    }
  `,
  styles: `
    .summary {
      display: grid;
      grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
      gap: 1rem;
      margin-bottom: 1rem;
    }
    @media (max-width: 800px) {
      .summary {
        grid-template-columns: 1fr;
      }
    }
    .medals {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 0.5rem;
      align-items: center;
    }
    .medal {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.1rem;
      strong {
        font-size: 1.6rem;
        line-height: 1;
      }
    }
    .icon {
      font-size: 1.5rem;
    }
    .timeline {
      list-style: none;
      margin: 0;
      padding: 0 0 0 0.9rem;
      border-left: 2px solid var(--gray-200);
      li {
        position: relative;
        display: flex;
        gap: 0.6rem;
        align-items: baseline;
        padding: 0.2rem 0;
      }
      li::before {
        content: '';
        position: absolute;
        left: calc(-0.9rem - 6px);
        top: 0.55rem;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--gray-300);
      }
      li.current::before {
        background: var(--aka);
      }
    }
    .tour {
      margin-bottom: 0.75rem;
    }
    .tour-head {
      display: flex;
      gap: 1rem;
      align-items: flex-start;
      h3 {
        margin: 0.1rem 0 0.2rem;
      }
    }
    .place {
      font-weight: 700;
      white-space: nowrap;
      padding: 0.3rem 0.6rem;
      border-radius: var(--radius-sm);
      background: var(--gray-100);
      color: var(--gray-600);
    }
    .place.podium {
      background: var(--warn-soft);
      color: var(--gray-900);
    }
    .fights {
      margin-top: 0.6rem;
    }
    .big {
      font-size: 2rem;
    }
  `,
})
export class PersonHistoryView {
  private api = inject(ApiService);
  readonly personId = input.required<number>();

  readonly history = signal<PersonHistory | null>(null);
  readonly error = signal('');
  readonly fdate = fmtDate;
  readonly place = placeLabel;
  readonly score = scoreText;
  readonly medalIcon = MEDAL_ICON;
  readonly methodLabel = METHOD_LABEL;
  readonly regStatus = REGISTRATION_STATUS;

  constructor() {
    effect(() => {
      const id = this.personId();
      this.history.set(null);
      this.error.set('');
      this.api.get<PersonHistory>(`/persons/${id}/history`).subscribe({
        next: (h) => this.history.set(h),
        error: (e) => this.error.set(ApiError.from(e).fullMessage),
      });
    });
  }
}
