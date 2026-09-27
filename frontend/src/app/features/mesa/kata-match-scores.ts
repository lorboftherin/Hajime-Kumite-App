import { Component, OnInit, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { DialogService } from '../../core/dialog.service';
import { newId } from '../../core/format';
import { Color, KataCatalog, Scoreboard } from '../../core/models';
import { MutationService } from '../../core/mutation.service';

interface KataScoreOut {
  winner: Color | null;
  needs_head_judge: boolean;
  aka_total: number;
  ao_total: number;
}

/**
 * Kata por puntuación en llave (aka vs ao): cada uno recibe la nota del panel
 * y gana la mayor, con los desempates de la puntuación. Si siguen empatados
 * decide el juez principal. Con notas técnico / atléticas, dos por juez.
 */
@Component({
  selector: 'app-kata-match-scores',
  imports: [FormsModule],
  template: `
    <main class="kscores">
      @for (c of colors; track c) {
        <section class="kside {{ c }}" [attr.aria-label]="c === 'aka' ? 'AKA' : 'AO'">
          <header>
            <span class="clabel">{{ c === 'aka' ? 'AKA' : 'AO' }}</span>
            <span class="pname">{{ (c === 'aka' ? sb().aka?.name : sb().ao?.name) ?? '—' }}</span>
            <span class="pdojo">{{
              (c === 'aka' ? sb().aka?.dojo_name : sb().ao?.dojo_name) ?? ''
            }}</span>
          </header>
          <label class="kname">
            <span i18n="@@mesa.kata.kata">Kata</span>
            <input i18n-placeholder="@@mesa.kata.nombre-kata"
              [(ngModel)]="names[c]"
              [name]="'kn' + c"
              list="kata-catalog-mesa"
              placeholder="Nombre del kata"
            />
          </label>
          <div class="jgrid">
            @for (j of judgeIdx; track j) {
              <label class="jcell">
                <span i18n="@@mesa.kata.j">J{{ j + 1 }}</span>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max="10"
                  inputmode="decimal"
                  [(ngModel)]="scores[c][j]"
                  [name]="'s' + c + j"
                  [attr.aria-label]="ariaNotaJuez(j + 1)"
                />
                @if (split()) {
                  <input i18n-placeholder="@@mesa.kata.atl"
                    type="number"
                    step="0.1"
                    min="0"
                    max="10"
                    inputmode="decimal"
                    [(ngModel)]="athletic[c][j]"
                    [name]="'a' + c + j"
                    placeholder="Atl."
                    [attr.aria-label]="ariaNotaAtletica(j + 1)"
                  />
                }
              </label>
            }
          </div>
          @if (result(); as r) {
            <div i18n="@@mesa.kata.total" class="total">
              Total <b>{{ c === 'aka' ? r.aka_total : r.ao_total }}</b>
            </div>
          }
        </section>
      }
      <datalist id="kata-catalog-mesa">
        @for (k of catalog(); track k) {
          <option [value]="k"></option>
        }
      </datalist>
      <section class="kfoot">
        @if (needsHead()) {
          <div class="head">
            <span i18n="@@mesa.kata.empate-todo-decide-juez">Empate en todo: decide el juez principal.</span>
            <button i18n="@@mesa.kata.aka" class="flag aka" [class.on]="head() === 'aka'" (click)="head.set('aka')">
              AKA
            </button>
            <button i18n="@@mesa.kata.ao" class="flag ao" [class.on]="head() === 'ao'" (click)="head.set('ao')">
              AO
            </button>
          </div>
        }
        <p i18n="@@mesa.kata.jueces" class="hint">
          {{ judges() }} jueces@if (split()) { · técnica y atlética (70 / 30)}@if (discard()) { · se descartan {{ discard() }} nota(s) por extremo}
        </p>
        <button
          class="go"
          [disabled]="busy() || locked() || (needsHead() && !head())"
          (click)="submit()"
        >
          <ng-container i18n="@@mesa.kata.cerrado-registrar">@if (locked()) {Combate cerrado} @else {Registrar notas}</ng-container>
        </button>
      </section>
    </main>
  `,
  styles: `
    .kscores {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      padding: 16px;
    }
    .kside {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 16px;
      border-radius: 16px;
      background: var(--y-panel, #1b1917);
      border-top: 6px solid var(--shu, #d9534a);
      &.ao {
        border-top-color: var(--ai, #5a83c0);
      }
      header {
        display: flex;
        flex-direction: column;
      }
    }
    .clabel {
      font-weight: 800;
      letter-spacing: 0.08em;
    }
    .pname {
      font-size: 1.35rem;
      font-weight: 700;
    }
    .pdojo,
    .hint {
      color: var(--y-dim, #a79f91);
    }
    .kname,
    .jcell {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .jgrid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
      gap: 8px;
    }
    input {
      min-height: 46px;
      border-radius: 10px;
      border: 1px solid var(--y-line, #34302b);
      background: var(--y-panel-2, #24211e);
      color: var(--y-text, #f5f0e6);
      font-size: 1.1rem;
      padding: 0 10px;
    }
    .total b {
      font-size: 1.6rem;
    }
    .kfoot {
      grid-column: 1 / -1;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
    }
    .head {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .flag {
      min-height: 46px;
      min-width: 90px;
      border-radius: 10px;
      border: 1px solid var(--y-line, #34302b);
      background: transparent;
      color: inherit;
      font-weight: 700;
      &.aka.on {
        background: var(--shu, #d9534a);
      }
      &.ao.on {
        background: var(--ai, #5a83c0);
      }
    }
    .go {
      min-height: 56px;
      min-width: 260px;
      border-radius: 14px;
      border: 0;
      background: var(--y-text, #f5f0e6);
      color: var(--y-bg, #121110);
      font-weight: 800;
      font-size: 1.1rem;
      &:disabled {
        opacity: 0.5;
      }
    }
    @media (max-width: 720px) {
      .kscores {
        grid-template-columns: 1fr;
      }
    }
  `,
})
export class KataMatchScores implements OnInit {
  ariaNotaJuez = (juez: number) => $localize`:@@mesa.kata.nota-juez:Nota del juez ${juez}:juez:`;
  ariaNotaAtletica = (juez: number) => $localize`:@@llave.nota-atletica-juez:Nota atlética del juez ${juez}:juez:`;
  private api = inject(ApiService);
  private mut = inject(MutationService);
  private dialog = inject(DialogService);

  readonly sb = input.required<Scoreboard>();
  readonly judges = input(5);
  readonly split = input(false);
  readonly discard = input(1);
  readonly locked = input(false);
  readonly changed = output<void>();

  readonly colors: Color[] = ['aka', 'ao'];
  judgeIdx: number[] = [];
  scores: Record<Color, Array<number | null>> = { aka: [], ao: [] };
  athletic: Record<Color, Array<number | null>> = { aka: [], ao: [] };
  names: Record<Color, string> = { aka: '', ao: '' };
  readonly catalog = signal<string[]>([]);
  readonly result = signal<KataScoreOut | null>(null);
  readonly needsHead = signal(false);
  readonly head = signal<Color | null>(null);
  readonly busy = signal(false);
  /** Uno por decisión: reintentos idempotentes. */
  private eventId = newId();

  ngOnInit(): void {
    const n = this.judges();
    this.judgeIdx = Array.from({ length: n }, (_, i) => i);
    this.scores = { aka: Array(n).fill(null), ao: Array(n).fill(null) };
    this.athletic = { aka: Array(n).fill(null), ao: Array(n).fill(null) };
    firstValueFrom(this.api.get<KataCatalog>('/kata-catalog'))
      .then((c) => this.catalog.set(c.katas))
      .catch(() => {});
  }

  private clean(xs: Array<number | null>): number[] | null {
    if (xs.some((x) => x === null || x === undefined || isNaN(Number(x)))) return null;
    return xs.map((x) => Math.round(Number(x) * 10) / 10);
  }

  async submit(): Promise<void> {
    const aka = this.clean(this.scores.aka);
    const ao = this.clean(this.scores.ao);
    const akaAth = this.split() ? this.clean(this.athletic.aka) : null;
    const aoAth = this.split() ? this.clean(this.athletic.ao) : null;
    if (!aka || !ao || (this.split() && (!akaAth || !aoAth))) {
      this.needsHead.set(false);
      this.result.set(null);
      this.dialog.alert($localize`:@@mesa.kata.notas-incompletas:Notas incompletas`, $localize`:@@mesa.kata.ingresa-nota-cada-juez-decimal:Ingresa la nota de cada juez (un decimal).`);
      return;
    }
    this.busy.set(true);
    const res = await this.mut.post<KataScoreOut>(`/matches/${this.sb().match.id}/kata-scores`, {
      aka_scores: aka,
      ao_scores: ao,
      aka_athletic: akaAth,
      ao_athletic: aoAth,
      aka_kata_name: this.names.aka || null,
      ao_kata_name: this.names.ao || null,
      head_judge_vote: this.needsHead() ? this.head() : null,
      event_id: this.eventId,
      at: new Date().toISOString(),
    });
    this.busy.set(false);
    if (!res) return;
    this.result.set(res);
    if (res.needs_head_judge) {
      this.needsHead.set(true);
      return;
    }
    this.needsHead.set(false);
    this.eventId = newId();
    this.changed.emit();
  }
}
