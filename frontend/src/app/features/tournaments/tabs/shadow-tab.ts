import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../../core/api.service';
import { Bracket, ComparisonItem, ComparisonReport, Match, Participant } from '../../../core/models';
import { MutationService } from '../../../core/mutation.service';
import { TournamentContext } from '../tournament-context';

interface Draft {
  winner: number | null;
  aka: number | null;
  ao: number | null;
  finding: string;
  error_source: string | null;
}

@Component({
  selector: 'app-shadow-tab',
  imports: [FormsModule],
  template: `
    <div class="card">
      <div class="row">
        <div class="grow">
          <h3>Shadow Mode: comparación con el resultado oficial</h3>
          <p class="small muted">Registra lo que dice la mesa oficial (papel) para cada combate. Las diferencias se marcan y alimentan los criterios de éxito.</p>
        </div>
        @if (report(); as r) {
          <div class="kpi">
            <div class="big">{{ r.winner_agreement_pct === null ? '—' : r.winner_agreement_pct + '%' }}</div>
            <div class="small muted">coincidencia de ganador</div>
            <div class="small">{{ r.compared }} comparados de {{ r.matches }} · {{ r.differences.length }} diferencias</div>
          </div>
        }
      </div>
      <label class="field inline small"><input type="checkbox" [checked]="onlyDiffs()" (change)="onlyDiffs.set(!onlyDiffs())" /> Mostrar solo diferencias</label>
    </div>

    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>Combate</th>
            <th>App</th>
            <th>Ganador oficial</th>
            <th>Marcador oficial (aka–ao)</th>
            <th>Hallazgo</th>
            <th>Origen del error</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          @for (it of shown(); track it.match_id) {
            @let d = drafts()[it.match_id];
            @let m = matchInfo()[it.match_id];
            <tr [class.diff]="it.winner_matches === false || it.score_matches === false">
              <td>
                <strong>{{ it.code }}</strong>
                <div class="small muted">{{ it.category_name }}</div>
              </td>
              <td class="small">
                <div><strong>{{ pname(it.app_winner_registration_id) }}</strong></div>
                <div class="muted">{{ it.app_score[0] ?? '–' }} – {{ it.app_score[1] ?? '–' }}</div>
              </td>
              <td>
                @if (d) {
                  <select [(ngModel)]="d.winner">
                    <option [ngValue]="null">—</option>
                    @if (m?.aka_registration_id) {
                      <option [ngValue]="m!.aka_registration_id">Aka: {{ pname(m!.aka_registration_id) }}</option>
                    }
                    @if (m?.ao_registration_id) {
                      <option [ngValue]="m!.ao_registration_id">Ao: {{ pname(m!.ao_registration_id) }}</option>
                    }
                  </select>
                  @if (it.winner_matches === false) {
                    <div class="error-text">≠ ganador</div>
                  }
                }
              </td>
              <td class="nowrap">
                @if (d) {
                  <input class="score aka-b" type="number" min="0" [(ngModel)]="d.aka" /> –
                  <input class="score ao-b" type="number" min="0" [(ngModel)]="d.ao" />
                  @if (it.score_matches === false) {
                    <div class="error-text">≠ marcador</div>
                  }
                }
              </td>
              <td>@if (d) {<input [(ngModel)]="d.finding" placeholder="Descripción" />}</td>
              <td>
                @if (d) {
                  <select [(ngModel)]="d.error_source">
                    <option [ngValue]="null">—</option>
                    <option value="none">Sin error</option>
                    <option value="app">App</option>
                    <option value="paper">Papel</option>
                  </select>
                }
              </td>
              <td><button class="btn sm primary" (click)="save(it)">Guardar</button></td>
            </tr>
          } @empty {
            <tr><td colspan="7" class="empty">No hay combates finalizados para comparar.</td></tr>
          }
        </tbody>
      </table>
    </div>
  `,
  styles: `
    .kpi {
      text-align: right;
      .big {
        font-size: 2rem;
        font-weight: 800;
      }
    }
    .score {
      width: 4rem;
    }
    .aka-b {
      border-left: 4px solid var(--aka) !important;
    }
    .ao-b {
      border-left: 4px solid var(--ao) !important;
    }
  `,
})
export class ShadowTab {
  readonly ctx = inject(TournamentContext);
  private api = inject(ApiService);
  private mut = inject(MutationService);

  readonly report = signal<ComparisonReport | null>(null);
  readonly drafts = signal<Record<number, Draft>>({});
  readonly matchInfo = signal<Record<number, Match>>({});
  readonly participants = signal<Record<number, Participant>>({});
  readonly onlyDiffs = signal(false);
  readonly shown = computed(() => {
    const r = this.report();
    if (!r) return [];
    return this.onlyDiffs() ? r.differences : r.items;
  });

  constructor() {
    this.load();
  }

  async load(): Promise<void> {
    const r = await firstValueFrom(this.api.get<ComparisonReport>(`/tournaments/${this.ctx.id()}/comparison-report`));
    const drafts: Record<number, Draft> = {};
    for (const it of r.items) {
      drafts[it.match_id] = {
        winner: it.official_winner_registration_id,
        aka: it.official_score[0],
        ao: it.official_score[1],
        finding: it.finding ?? '',
        error_source: it.error_source,
      };
    }
    this.drafts.set(drafts);
    this.report.set(r);
    // Participantes de cada combate (para elegir el ganador oficial): se leen de las llaves.
    const cats = [...new Set(r.items.map((i) => i.category_id))];
    const brackets = await Promise.all(
      cats.map((c) => firstValueFrom(this.api.get<Bracket>(`/categories/${c}/bracket`)).catch(() => null)),
    );
    const mi: Record<number, Match> = {};
    const parts: Record<number, Participant> = {};
    for (const b of brackets) {
      if (!b) continue;
      for (const m of b.matches) mi[m.id] = m;
      for (const [k, p] of Object.entries(b.participants)) parts[Number(k)] = p;
    }
    this.matchInfo.set(mi);
    this.participants.set(parts);
  }

  pname(rid: number | null | undefined): string {
    if (!rid) return '—';
    return this.participants()[rid]?.name ?? `#${rid}`;
  }

  async save(it: ComparisonItem): Promise<void> {
    const d = this.drafts()[it.match_id];
    const res = await this.mut.post(
      `/matches/${it.match_id}/official-result`,
      {
        official_winner_registration_id: d.winner,
        official_aka_score: d.aka === null || (d.aka as unknown) === '' ? null : Number(d.aka),
        official_ao_score: d.ao === null || (d.ao as unknown) === '' ? null : Number(d.ao),
        finding: d.finding || null,
        error_source: d.error_source,
      },
      { success: 'Resultado oficial guardado' },
    );
    if (res) this.load();
  }
}
