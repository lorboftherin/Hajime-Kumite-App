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
    <div class="card intro">
      <div class="grow">
        <h2 i18n="@@torneo.sombra.shadow-mode">Shadow Mode</h2>
        <p i18n="@@torneo.sombra.comparacion-resultado-oficial" class="muted">Comparación con el resultado oficial. Registra lo que dice la mesa oficial (papel) para cada combate; las diferencias se marcan y alimentan los criterios de éxito.</p>
        <label i18n="@@torneo.sombra.mostrar-solo-diferencias" class="field inline small"><input type="checkbox" [checked]="onlyDiffs()" (change)="onlyDiffs.set(!onlyDiffs())" /> Mostrar solo diferencias</label>
      </div>
      @if (report(); as r) {
        <div class="kpi">
          <div class="figure">{{ r.winner_agreement_pct === null ? '—' : r.winner_agreement_pct + '%' }}</div>
          <div i18n="@@torneo.sombra.coincidencia-ganador" class="small muted">coincidencia de ganador</div>
          <div i18n="@@torneo.sombra.comparados-diferencias" class="small num">{{ r.compared }} comparados de {{ r.matches }} · {{ r.differences.length }} diferencias</div>
        </div>
      }
    </div>

    <div class="table-wrap">
      <table class="table shadow-table">
        <colgroup>
          <col class="c-match" />
          <col class="c-app" />
          <col class="c-winner" />
          <col class="c-score" />
          <col />
          <col class="c-source" />
          <col class="c-save" />
        </colgroup>
        <thead>
          <tr>
            <th i18n="@@torneo.sombra.combate">Combate</th>
            <th i18n="@@torneo.sombra.app">App</th>
            <th i18n="@@torneo.sombra.ganador-oficial">Ganador oficial</th>
            <th i18n="@@torneo.sombra.marcador-oficial-aka-ao">Marcador oficial (aka–ao)</th>
            <th i18n="@@torneo.sombra.hallazgo">Hallazgo</th>
            <th i18n="@@torneo.sombra.origen-error">Origen del error</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          @for (it of shown(); track it.match_id) {
            @let d = drafts()[it.match_id];
            @let m = matchInfo()[it.match_id];
            @let flags = m?.method === 'flags';
            <tr [class.diff]="it.winner_matches === false || it.score_matches === false">
              <td>
                <span class="code">{{ it.code }}</span>
                <div class="small muted">{{ it.category_name }}</div>
              </td>
              <td class="small">
                <div><strong>{{ pname(it.app_winner_registration_id) }}</strong></div>
                @if (flags) {
                  <div i18n="@@torneo.sombra.banderas" class="muted">Banderas</div>
                } @else {
                  <div class="muted num">{{ it.app_score[0] ?? '–' }} – {{ it.app_score[1] ?? '–' }}</div>
                }
              </td>
              <td>
                @if (d) {
                  <select i18n-aria-label="@@torneo.sombra.ganador-oficial-2" class="cell-input" [(ngModel)]="d.winner" aria-label="Ganador oficial">
                    <option [ngValue]="null">—</option>
                    @if (m?.aka_registration_id) {
                      <option i18n="@@torneo.sombra.aka" [ngValue]="m!.aka_registration_id">Aka: {{ pname(m!.aka_registration_id) }}</option>
                    }
                    @if (m?.ao_registration_id) {
                      <option i18n="@@torneo.sombra.ao" [ngValue]="m!.ao_registration_id">Ao: {{ pname(m!.ao_registration_id) }}</option>
                    }
                  </select>
                  @if (it.winner_matches === false) {
                    <div i18n="@@torneo.sombra.ganador" class="error-text">≠ ganador</div>
                  }
                }
              </td>
              <td class="nowrap">
                @if (flags) {
                  <span i18n="@@torneo.sombra.no-aplica" i18n-title="@@torneo.sombra.decision-banderas-no-hay" class="muted small" title="Decisión por banderas: no hay marcador que comparar">No aplica</span>
                } @else if (d) {
                  <input i18n-aria-label="@@torneo.sombra.marcador-oficial-aka" class="score aka-b" type="number" min="0" [(ngModel)]="d.aka" aria-label="Marcador oficial aka" /> –
                  <input i18n-aria-label="@@torneo.sombra.marcador-oficial-ao" class="score ao-b" type="number" min="0" [(ngModel)]="d.ao" aria-label="Marcador oficial ao" />
                  @if (it.score_matches === false) {
                    <div i18n="@@torneo.sombra.marcador" class="error-text">≠ marcador</div>
                  }
                }
              </td>
              <td>@if (d) {<textarea i18n-aria-label="@@torneo.sombra.hallazgo-2" i18n-placeholder="@@torneo.sombra.descripcion" class="cell-input finding" [rows]="d.finding.length > 70 ? 3 : 2" [(ngModel)]="d.finding" placeholder="Descripción" aria-label="Hallazgo"></textarea>}</td>
              <td>
                @if (d) {
                  <select i18n-aria-label="@@torneo.sombra.origen-error-2" class="cell-input" [(ngModel)]="d.error_source" aria-label="Origen del error">
                    <option [ngValue]="null">—</option>
                    <option i18n="@@torneo.sombra.sin-error" value="none">Sin error</option>
                    <option i18n="@@torneo.sombra.app" value="app">App</option>
                    <option i18n="@@torneo.sombra.papel" value="paper">Papel</option>
                  </select>
                }
              </td>
              <td><button i18n="@@torneo.sombra.guardar" class="btn sm" (click)="save(it)">Guardar</button></td>
            </tr>
          } @empty {
            <tr><td i18n="@@torneo.sombra.no-hay-combates-finalizados-para" colspan="7" class="empty">No hay combates finalizados para comparar.</td></tr>
          }
        </tbody>
      </table>
    </div>
  `,
  styles: `
    .intro {
      display: flex;
      gap: 2rem;
      align-items: flex-start;
      flex-wrap: wrap;
      h2 {
        margin-bottom: 0.35rem;
      }
      p {
        max-width: 60ch;
      }
    }
    .kpi {
      text-align: right;
      padding-left: 2rem;
      border-left: 1px solid var(--kasumi);
      .figure {
        margin-bottom: 0.35rem;
      }
    }
    /* Anchos fijos para que la tabla quepa en la tarjeta a 1366 px; en pantallas
       más estrechas se desplaza dentro de .table-wrap. */
    .shadow-table {
      table-layout: fixed;
      min-width: 58rem;
      th,
      td {
        padding-left: 0.6rem;
        padding-right: 0.6rem;
        vertical-align: top;
      }
      th {
        white-space: normal;
      }
      .c-match {
        width: 8.25rem;
      }
      .c-app {
        width: 7.75rem;
      }
      .c-winner {
        width: 10.5rem;
      }
      .c-score {
        width: 7.5rem;
      }
      .c-source {
        width: 7.6rem;
      }
      .c-save {
        width: 5.75rem;
      }
    }
    .cell-input {
      width: 100%;
      min-width: 0;
      font-size: var(--fs-14);
    }
    textarea.finding {
      resize: vertical;
      min-height: 2.6rem;
      font-size: var(--fs-14);
      line-height: 1.35;
    }
    input.score {
      width: 2.9rem;
      padding: 0 0.25rem 0 0.45rem;
      text-align: center;
      font-size: var(--fs-14);
      -moz-appearance: textfield;
      appearance: textfield;
      &::-webkit-outer-spin-button,
      &::-webkit-inner-spin-button {
        -webkit-appearance: none;
        margin: 0;
      }
    }
    select.cell-input {
      padding-left: 0.6rem;
      padding-right: 1.9rem;
      background-position: right 0.5rem center;
    }
    .aka-b {
      box-shadow: inset 3px 0 0 var(--shu);
    }
    .ao-b {
      box-shadow: inset 3px 0 0 var(--ai);
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
      { success: $localize`:@@torneo.sombra.resultado-oficial-guardado:Resultado oficial guardado` },
    );
    if (res) this.load();
  }
}
