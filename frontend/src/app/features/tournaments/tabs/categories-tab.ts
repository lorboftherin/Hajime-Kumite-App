import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { DialogService } from '../../../core/dialog.service';
import { ADVICE_LABEL, CATEGORY_STATUS, FORMAT_LABEL, GRADES, MODALITY_LABEL, SEX_LABEL } from '../../../core/format';
import { Bracket, Category } from '../../../core/models';
import { MutationService } from '../../../core/mutation.service';
import { ToastService } from '../../../core/toast.service';
import { StatusBadge } from '../../../shared/badge';
import { Icon } from '../../../shared/icon';
import { Modal } from '../../../shared/modal';
import { MoreMenu } from '../../../shared/more-menu';
import { LabelPipe } from '../../../shared/pipes';
import { RulesForm, cleanRules, editableKata, kataPayload } from '../../../shared/rules-form';
import { CategorySplitDialog } from '../category-split';
import { PluralPipe, plural, pluralWord } from '../../../shared/plural';
import { BracketGenerator } from '../../checkin/bracket-absent';
import { TournamentContext } from '../tournament-context';

@Component({
  selector: 'app-categories-tab',
  imports: [FormsModule, RouterLink, StatusBadge, Modal, LabelPipe, Icon, MoreMenu, PluralPipe, RulesForm, CategorySplitDialog],
  template: `
    <div class="toolbar">
      <div class="search">
        <app-icon name="search" />
        <input placeholder="Buscar por nombre o código…" aria-label="Buscar categoría" [ngModel]="q()" (ngModelChange)="q.set($event)" />
      </div>
      <select aria-label="Estado" [ngModel]="status()" (ngModelChange)="status.set($event)">
        <option value="">Todos los estados</option>
        @for (s of statusKeys; track s) {
          <option [value]="s">{{ statusLabel[s] }}</option>
        }
      </select>
      <select aria-label="Modalidad" [ngModel]="modality()" (ngModelChange)="modality.set($event)">
        <option value="">Kumite y kata</option>
        <option value="kumite">Kumite</option>
        <option value="kata">Kata</option>
      </select>
      <label class="field inline small"><input type="checkbox" [ngModel]="hideEmpty()" (ngModelChange)="hideEmpty.set($event)" /> Ocultar vacías</label>
      <span class="count">{{ filtered().length }} de {{ ctx.categories().length }}</span>
      <button class="btn icon-only ghost" (click)="reload()" title="Recargar" aria-label="Recargar"><app-icon name="refresh" /></button>
      @if (pendingBrackets().length) {
        <button class="btn" [disabled]="generatingAll()" (click)="generateAll()" [title]="'Generar las llaves de ' + (pendingBrackets().length | plural: 'categoría con inscritos' : 'categorías con inscritos') + ' que aún no la tienen'">
          @if (generatingAll()) {
            <span class="spinner"></span>
          }
          Generar todas las llaves ({{ pendingBrackets().length }})
        </button>
      }
      <button class="btn primary" (click)="openCreate()"><app-icon name="plus" /> Categoría manual</button>
    </div>
    @if (selected().size) {
      <div class="selection-bar" role="status">
        <span><strong class="num">{{ selected().size }}</strong> {{ selected().size === 1 ? 'seleccionada' : 'seleccionadas' }}</span>
        <button class="btn sm" [disabled]="selected().size < 2" (click)="openMerge()">Fusionar seleccionadas</button>
        <button class="btn sm ghost" (click)="clearSelection()">Quitar selección</button>
      </div>
    }

    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th class="check"><span class="sr-only">Seleccionar</span></th>
            <th>Categoría</th>
            <th>Modalidad</th>
            <th class="center">Inscritos</th>
            <th>Estado</th>
            <th>Tatami · cola</th>
            <th class="right"><span class="sr-only">Acciones</span></th>
          </tr>
        </thead>
        <tbody>
          @for (c of filtered(); track c.id) {
            <tr [class.selected]="selected().has(c.id)">
              <td class="check"><input type="checkbox" [checked]="selected().has(c.id)" (change)="toggle(c.id)" [attr.aria-label]="'Seleccionar ' + c.name" /></td>
              <td class="cat">
                <div class="cat-name">{{ c.name }} @if (c.is_manual) {<span class="badge plain">manual</span>}</div>
                <div class="code">{{ c.code }}</div>
                @if (c.merged_into_id) {
                  <div class="small muted">→ fusionada en {{ catName(c.merged_into_id) }}</div>
                }
                @if (c.cancel_reason) {
                  <div class="small muted">Cancelada: {{ c.cancel_reason }}</div>
                }
                @if (c.advice.length && c.status !== 'empty') {
                  <div class="small advice">Sugerencia: {{ adviceText(c.advice) }}</div>
                }
                @if (c.split_from_id) {
                  <div class="small muted">← dividida de {{ catName(c.split_from_id) }}</div>
                }
              </td>
              <td class="nowrap">
                {{ c.modality | label: modalityLabel }}
                @if (c.is_team) {
                  <span class="badge plain">equipos</span>
                }
                <span class="muted">· {{ c.sex | label: sexLabel }}</span>
              </td>
              <td class="center">
                <span class="count-cell" [class.zero]="!c.entrant_count" [class.over]="!!c.max_entrants && c.entrant_count > c.max_entrants">{{ c.entrant_count }}</span>
                @if (c.max_entrants) {
                  <span class="muted small">/ {{ c.max_entrants }}</span>
                }
              </td>
              <td><app-status [status]="c.status" /></td>
              <td class="nowrap">
                @if (c.tatami_id) {
                  {{ tatamiName(c.tatami_id) }} <span class="muted">· {{ c.queue_position ?? '—' }}</span>
                } @else {
                  <span class="muted">—</span>
                }
              </td>
              <td class="right"><div class="actions">
                @if (hasBracket(c)) {
                  <a class="btn sm" [routerLink]="['/categorias', c.id, 'llave']">Llave</a>
                } @else if (c.status === 'open' && c.entrant_count > 0) {
                  <button class="btn sm primary" (click)="generate(c)">Generar llave</button>
                }
                <app-more [label]="'Más acciones · ' + c.name">
                  @if (c.status !== 'merged' && c.status !== 'cancelled') {
                    <button class="menu-item" (click)="openEdit(c)">Editar categoría</button>
                  }
                  <button class="menu-item" (click)="openTatami(c)">Asignar tatami</button>
                  @if (['open', 'ready'].includes(c.status) && c.entrant_count >= 2) {
                    <button class="menu-item" (click)="splitCat.set(c)">Dividir categoría…</button>
                  }
                  @if (c.has_split) {
                    <button class="menu-item" (click)="unsplit(c)">Deshacer división</button>
                  }
                  @if (mergeTargets().has(c.id)) {
                    <button class="menu-item" (click)="unmerge(c)">Separar (deshacer fusión)</button>
                  }
                  @if (c.status === 'finished') {
                    <button class="menu-item" (click)="reopen(c)">Reabrir categoría</button>
                  }
                  @if (c.status !== 'cancelled' && c.status !== 'merged') {
                    <hr />
                    <button class="menu-item danger" (click)="cancel(c)">Cancelar categoría</button>
                  }
                </app-more>
              </div></td>
            </tr>
          } @empty {
            <tr><td colspan="7" class="empty"><p><strong>Nada por aquí.</strong></p>No hay categorías con esos filtros.</td></tr>
          }
        </tbody>
      </table>
    </div>

    @if (mergeOpen()) {
      <app-modal title="Fusionar categorías" (closed)="mergeOpen.set(false)">
        <p class="small muted">Los inscritos pasan a la categoría destino; las demás quedan como "Fusionada" para el historial. Se puede deshacer si no hay combates iniciados.</p>
        <ul class="small">
          @for (c of selectedCats(); track c.id) {
            <li>{{ c.name }} ({{ c.entrant_count }})</li>
          }
        </ul>
        <div class="stack">
          <label class="field">
            <span>Destino</span>
            <select [(ngModel)]="merge.target_id">
              <option [ngValue]="null">Crear una categoría nueva</option>
              @for (c of selectedCats(); track c.id) {
                <option [ngValue]="c.id">{{ c.name }}</option>
              }
            </select>
          </label>
          @if (merge.target_id === null) {
            <label class="field"><span>Nombre de la nueva categoría</span><input [(ngModel)]="merge.new_name" /></label>
          }
          <label class="field"><span>Motivo</span><input [(ngModel)]="merge.reason" placeholder="Ej.: pocos inscritos" /></label>
        </div>
        <div class="form-actions">
          <button class="btn" (click)="mergeOpen.set(false)">Cancelar</button>
          <button class="btn primary" (click)="doMerge()">Fusionar</button>
        </div>
      </app-modal>
    }

    @if (splitCat(); as c) {
      <app-category-split [category]="c" (closed)="splitCat.set(null)" (done)="splitCat.set(null); reload()" />
    }

    @if (tatamiCat(); as c) {
      <app-modal [title]="'Tatami · ' + c.name" (closed)="tatamiCat.set(null)">
        <div class="grid-2">
          <label class="field">
            <span>Tatami</span>
            <select [(ngModel)]="tat.tatami_id">
              <option [ngValue]="null">— Sin asignar —</option>
              @for (tt of ctx.tournament()?.tatamis ?? []; track tt.id) {
                <option [ngValue]="tt.id">{{ tt.name || 'Tatami ' + tt.number }}</option>
              }
            </select>
          </label>
          <label class="field"><span>Posición en la cola</span><input type="number" min="1" [(ngModel)]="tat.queue_position" /></label>
        </div>
        <div class="form-actions">
          <button class="btn" (click)="tatamiCat.set(null)">Cancelar</button>
          <button class="btn primary" (click)="saveTatami(c)">Guardar</button>
        </div>
      </app-modal>
    }

    @if (editCat(); as c) {
      <app-modal [title]="'Editar · ' + c.name" [wide]="true" (closed)="editCat.set(null)">
        <form (ngSubmit)="saveEdit(c)">
          <h3 class="sec">Datos básicos</h3>
          <div class="grid-3">
            <label class="field" style="grid-column: span 2"><span>Nombre *</span><input name="name" [(ngModel)]="ec.name" required /></label>
            <label class="field">
              <span>Sexo</span>
              <select name="sex" [(ngModel)]="ec.sex">
                <option value="M">Masculino</option>
                <option value="F">Femenino</option>
                <option value="X">Mixto</option>
              </select>
            </label>
            <label class="field"><span>Edad mín.</span><input type="number" name="amin" [(ngModel)]="ec.age_min" /></label>
            <label class="field"><span>Edad máx.</span><input type="number" name="amax" [(ngModel)]="ec.age_max" /></label>
            <label class="field"><span>Peso</span><input name="w" [(ngModel)]="ec.weight_class" placeholder="-60" /></label>
            <label class="field">
              <span>Grado mín.</span>
              <select name="gmin" [(ngModel)]="ec.grade_min">
                <option [ngValue]="null">—</option>
                @for (g of grades; track g; let i = $index) {
                  <option [ngValue]="i + 1">{{ g }}</option>
                }
              </select>
            </label>
            <label class="field">
              <span>Grado máx.</span>
              <select name="gmax" [(ngModel)]="ec.grade_max">
                <option [ngValue]="null">—</option>
                @for (g of grades; track g; let i = $index) {
                  <option [ngValue]="i + 1">{{ g }}</option>
                }
              </select>
            </label>
            @if (c.modality === 'kumite') {
              <label class="field"><span>Duración (seg)</span><input type="number" min="0" name="dur" [(ngModel)]="ec.duration_seconds" placeholder="Por defecto" /></label>
            }
            <label class="field">
              <span>Formato</span>
              <select name="fmt" [(ngModel)]="ec.format" [disabled]="formatLocked(c)">
                <option [ngValue]="null">Por defecto del torneo</option>
                <option value="single_elimination">Eliminación directa</option>
                <option value="round_robin">Round robin</option>
                <option value="groups_knockout">Grupos + eliminación</option>
                @if (c.modality === 'kata') {
                  <option value="kata_rounds">Rondas de kata</option>
                }
              </select>
              @if (formatLocked(c)) {
                <span class="hint">Con combates iniciados el formato no cambia.</span>
              }
            </label>
          </div>
          @if (c.entrant_count) {
            <p class="hint">Cambiar edades, sexo, grados o peso no mueve a los {{ c.entrant_count | plural: 'inscrito' : 'inscritos' }}: revisa sus inscripciones si ya no encajan.</p>
          }
          <!-- Sección «Reglas» (docs/reglas-configurables.md): vacío = hereda del torneo.
               Sus campos van en el mismo PATCH /categories/{id} de saveEdit(). -->
          <section class="rules-slot" aria-labelledby="cat-rules-title">
            <h3 class="sec" id="cat-rules-title">Reglas</h3>
            <p class="hint">Cada campo vacío hereda la regla del torneo.</p>
            <div class="grid-3">
              <label class="field">
                <span>Terceros lugares</span>
                <select name="tp" [(ngModel)]="ec.third_place_rule" [disabled]="formatLocked(c)">
                  <option [ngValue]="null">Por defecto del torneo</option>
                  <option value="two_bronzes">Dos bronces</option>
                  <option value="third_place_match">Combate por el 3.º</option>
                  <option value="repechage">Repechaje</option>
                </select>
              </label>
              <label class="field">
                <span>Cupo (máx. inscritos)</span>
                <input type="number" min="2" name="max" [(ngModel)]="ec.max_entrants" placeholder="Sin cupo" />
                <span class="hint">Al superarlo se advierte y se sugiere dividir.</span>
              </label>
              @if (c.modality === 'kumite') {
                <div class="grid-2">
                  <label class="field">
                    <span>Peso desde (kg)</span>
                    <input type="number" step="0.1" name="wmin" [(ngModel)]="ec.weight_min_kg" placeholder="De la etiqueta" />
                  </label>
                  <label class="field">
                    <span>Hasta (kg)</span>
                    <input type="number" step="0.1" name="wmax" [(ngModel)]="ec.weight_max_kg" placeholder="De la etiqueta" />
                  </label>
                </div>
              }
            </div>
            <app-rules-form
              mode="category"
              [modality]="c.modality"
              [isTeam]="c.is_team"
              [kumite]="ruleKumite"
              [kata]="ruleKata"
              [competition]="ruleComp"
            />
            @if (formatLocked(c)) {
              <p class="hint">Con combates iniciados no cambian el formato ni las reglas de kata.</p>
            }
          </section>
          <div class="form-actions">
            <button type="button" class="btn" (click)="editCat.set(null)">Cancelar</button>
            <button class="btn primary" [disabled]="!ec.name.trim() || saving()">Guardar cambios</button>
          </div>
        </form>
      </app-modal>
    }

    @if (createOpen()) {
      <app-modal title="Nueva categoría manual" [wide]="true" (closed)="createOpen.set(false)">
        <form (ngSubmit)="create()">
          <div class="grid-3">
            <label class="field"><span>Código *</span><input name="code" [(ngModel)]="nc.code" required /></label>
            <label class="field" style="grid-column: span 2"><span>Nombre *</span><input name="name" [(ngModel)]="nc.name" required /></label>
            <label class="field">
              <span>Modalidad</span>
              <select name="mod" [(ngModel)]="nc.modality">
                <option value="kumite">Kumite</option>
                <option value="kata">Kata</option>
              </select>
            </label>
            <label class="field">
              <span>Sexo</span>
              <select name="sex" [(ngModel)]="nc.sex">
                <option value="M">Masculino</option>
                <option value="F">Femenino</option>
                <option value="X">Mixto</option>
              </select>
            </label>
            <label class="field"><span>Edad mín.</span><input type="number" name="amin" [(ngModel)]="nc.age_min" /></label>
            <label class="field"><span>Edad máx.</span><input type="number" name="amax" [(ngModel)]="nc.age_max" /></label>
            <label class="field">
              <span>Grado mín.</span>
              <select name="gmin" [(ngModel)]="nc.grade_min">
                <option [ngValue]="null">—</option>
                @for (g of grades; track g; let i = $index) {
                  <option [ngValue]="i + 1">{{ g }}</option>
                }
              </select>
            </label>
            <label class="field">
              <span>Grado máx.</span>
              <select name="gmax" [(ngModel)]="nc.grade_max">
                <option [ngValue]="null">—</option>
                @for (g of grades; track g; let i = $index) {
                  <option [ngValue]="i + 1">{{ g }}</option>
                }
              </select>
            </label>
            <label class="field"><span>Peso</span><input name="w" [(ngModel)]="nc.weight_class" placeholder="-60" /></label>
            <label class="field">
              <span>Formato</span>
              <select name="fmt" [(ngModel)]="nc.format">
                <option [ngValue]="null">Por defecto del torneo</option>
                <option value="single_elimination">Eliminación directa</option>
                <option value="round_robin">Round robin</option>
                <option value="groups_knockout">Grupos + eliminación</option>
                <option value="kata_rounds">Rondas de kata</option>
              </select>
            </label>
            <label class="field"><span>Cupo (máx. inscritos)</span><input type="number" min="2" name="max" [(ngModel)]="nc.max_entrants" placeholder="Sin cupo" /></label>
            <label class="field inline" style="align-self: end; min-height: 2.5rem"><input type="checkbox" name="team" [(ngModel)]="nc.is_team" /> Por equipos</label>
            @if (nc.modality === 'kumite') {
              <label class="field"><span>Duración (seg)</span><input type="number" name="dur" [(ngModel)]="nc.duration_seconds" /></label>
              @if (nc.is_team) {
                <label class="field">
                  <span>Combates por enfrentamiento</span>
                  <select name="tb" [(ngModel)]="nc.team_bouts">
                    <option [ngValue]="3">3</option>
                    <option [ngValue]="5">5</option>
                  </select>
                </label>
                <label class="field">
                  <span>Empate en victorias</span>
                  <select name="ttr" [(ngModel)]="nc.team_tie_rule">
                    <option value="points">Gana quien suma más puntos; si empatan, combate extra</option>
                    <option value="extra_bout">Combate extra</option>
                  </select>
                </label>
              }
            } @else {
              <label class="field">
                <span>Método kata</span>
                <select name="km" [(ngModel)]="nc.kata_method">
                  <option [ngValue]="null">Por defecto</option>
                  <option value="flags">Banderas</option>
                  <option value="scores">Puntuación</option>
                </select>
              </label>
              <label class="field">
                <span>Jueces</span>
                <select name="kj" [(ngModel)]="nc.kata_judges">
                  <option [ngValue]="null">Por defecto</option>
                  <option [ngValue]="3">3</option>
                  <option [ngValue]="5">5</option>
                  <option [ngValue]="7">7</option>
                </select>
              </label>
            }
          </div>
          <div class="form-actions">
            <button type="button" class="btn" (click)="createOpen.set(false)">Cancelar</button>
            <button class="btn primary" [disabled]="!nc.code || !nc.name">Crear</button>
          </div>
        </form>
      </app-modal>
    }
  `,
  styles: `
    .selection-bar {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.6rem 0.9rem;
      margin-bottom: 0.9rem;
      border-radius: var(--radius-sm);
      background: var(--ai-soft);
      font-size: var(--fs-14);
      animation: rise-in var(--dur-2) var(--ease);
    }
    .check {
      width: 2.5rem;
      padding-right: 0 !important;
    }
    .cat {
      min-width: 15rem;
    }
    .cat-name {
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .count-cell {
      font-weight: 700;
      &.zero {
        color: var(--nezumi-ink);
        font-weight: 400;
      }
      &.over {
        color: var(--yamabuki-ink);
      }
    }
    .actions {
      white-space: nowrap;
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 0.25rem;
    }
    .advice {
      color: var(--yamabuki-ink);
    }
    .sec {
      margin: 0 0 0.75rem;
      font-size: var(--fs-16);
    }
    .rules-slot {
      margin-top: var(--space-5);
      padding-top: var(--space-4);
      border-top: 1px solid var(--kasumi);
    }
  `,
})
export class CategoriesTab {
  private brackets = inject(BracketGenerator);
  readonly ctx = inject(TournamentContext);
  private mut = inject(MutationService);
  private dialog = inject(DialogService);
  private router = inject(Router);
  private toast = inject(ToastService);

  readonly statusLabel = CATEGORY_STATUS;
  readonly statusKeys = Object.keys(CATEGORY_STATUS);
  readonly modalityLabel = MODALITY_LABEL;
  readonly sexLabel = SEX_LABEL;
  readonly formatLabel = FORMAT_LABEL;
  readonly grades = GRADES;

  readonly q = signal('');
  readonly status = signal('');
  readonly modality = signal('');
  readonly hideEmpty = signal(true);
  readonly selected = signal(new Set<number>());
  readonly mergeOpen = signal(false);
  readonly createOpen = signal(false);
  readonly tatamiCat = signal<Category | null>(null);
  readonly splitCat = signal<Category | null>(null);
  merge = { target_id: null as number | null, new_name: '', reason: '' };
  tat = { tatami_id: null as number | null, queue_position: null as number | null };
  nc = this.blankCategory();

  readonly filtered = computed(() => {
    const q = this.q().trim().toLowerCase();
    return this.ctx.categories().filter(
      (c) =>
        (!this.hideEmpty() || c.status !== 'empty') &&
        (!this.status() || c.status === this.status()) &&
        (!this.modality() || c.modality === this.modality()) &&
        (!q || c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q)),
    );
  });
  readonly mergeTargets = computed(
    () => new Set(this.ctx.categories().filter((c) => c.merged_into_id).map((c) => c.merged_into_id as number)),
  );
  readonly selectedCats = computed(() => this.ctx.categories().filter((c) => this.selected().has(c.id)));

  constructor() {
    this.reload();
  }

  reload(): void {
    this.ctx.loadCategories();
  }

  hasBracket(c: Category): boolean {
    return ['ready', 'in_progress', 'finished'].includes(c.status);
  }

  adviceText(a: string[]): string {
    return a.map((x) => ADVICE_LABEL[x] ?? x).join(' · ');
  }

  catName(id: number): string {
    return this.ctx.categoryById().get(id)?.name ?? '#' + id;
  }

  tatamiName(id: number): string {
    const t = this.ctx.tournament()?.tatamis.find((x) => x.id === id);
    return t ? t.name || `Tatami ${t.number}` : '#' + id;
  }

  clearSelection(): void {
    this.selected.set(new Set());
  }

  toggle(id: number): void {
    const s = new Set(this.selected());
    if (s.has(id)) s.delete(id);
    else s.add(id);
    this.selected.set(s);
  }

  openMerge(): void {
    this.merge = { target_id: this.selectedCats()[0]?.id ?? null, new_name: '', reason: '' };
    this.mergeOpen.set(true);
  }

  async doMerge(): Promise<void> {
    const ids = [...this.selected()];
    const body: Record<string, unknown> = {
      source_ids: this.merge.target_id ? ids.filter((i) => i !== this.merge.target_id) : ids,
      target_id: this.merge.target_id,
      new_name: this.merge.target_id ? null : this.merge.new_name || null,
      reason: this.merge.reason,
    };
    const res = await this.mut.post<Category>(`/tournaments/${this.ctx.id()}/categories/merge`, body, {
      success: 'Categorías fusionadas',
    });
    if (res) {
      this.mergeOpen.set(false);
      this.selected.set(new Set());
      this.reload();
    }
  }

  async unmerge(c: Category): Promise<void> {
    const ok = await this.dialog.confirm({
      title: 'Deshacer fusión',
      message: `Se devolverán los inscritos a sus categorías originales (${c.name}). La llave de esta categoría se descarta.`,
      confirmText: 'Separar',
    });
    if (!ok) return;
    const res = await this.mut.post<Category>(`/categories/${c.id}/unmerge`, {}, { success: 'Fusión deshecha' });
    if (res) this.reload();
  }

  async unsplit(c: Category): Promise<void> {
    const ok = await this.dialog.confirm({
      title: 'Deshacer división',
      message: `Los inscritos vuelven a ${c.name}, que recupera su nombre y rangos; la categoría creada al dividir se cancela.`,
      confirmText: 'Deshacer',
    });
    if (!ok) return;
    const res = await this.mut.post<Category>(`/categories/${c.id}/unsplit`, {}, { success: 'División deshecha' });
    if (res) this.reload();
  }

  async cancel(c: Category): Promise<void> {
    const reason = await this.dialog.prompt({
      title: 'Cancelar categoría',
      message: c.name,
      label: 'Motivo',
      minLength: 3,
      confirmText: 'Cancelar categoría',
    });
    if (!reason) return;
    const res = await this.mut.post<Category>(`/categories/${c.id}/cancel`, { reason }, { success: 'Categoría cancelada' });
    if (res) this.reload();
  }

  async reopen(c: Category): Promise<void> {
    const reason = await this.dialog.prompt({
      title: 'Reabrir categoría',
      message: `${c.name}: la categoría vuelve a "En curso" para corregir resultados. El torneo no se reabre.`,
      label: 'Motivo (obligatorio)',
      minLength: 3,
      confirmText: 'Reabrir',
    });
    if (!reason) return;
    const res = await this.mut.post(`/categories/${c.id}/reopen`, { reason }, { success: 'Categoría reabierta' });
    if (res) this.reload();
  }

  openTatami(c: Category): void {
    this.tat = {
      tatami_id: c.tatami_id ?? this.ctx.tournament()?.tatamis[0]?.id ?? null,
      queue_position: c.queue_position,
    };
    this.tatamiCat.set(c);
  }

  async saveTatami(c: Category): Promise<void> {
    const res = await this.mut.patch<Category>(
      `/categories/${c.id}`,
      { version: c.version, tatami_id: this.tat.tatami_id, queue_position: this.tat.queue_position || null },
      { success: 'Tatami asignado', onConflict: () => this.reload() },
    );
    if (res) {
      this.tatamiCat.set(null);
      this.reload();
    }
  }

  async generate(c: Category): Promise<void> {
    // Con acreditación: ofrece excluir a los ausentes antes de sortear.
    const res = await this.brackets.generate(c.id, {}, { success: 'Llave generada' });
    if (res) this.router.navigate(['/categorias', c.id, 'llave']);
  }

  // --- Generar todas las llaves pendientes (sin salir de la tabla) ---
  readonly generatingAll = signal(false);
  /** Categorías abiertas con al menos dos inscritos y todavía sin llave. */
  readonly pendingBrackets = computed(() =>
    this.ctx.categories().filter((c) => c.status === 'open' && c.entrant_count >= 2),
  );

  async generateAll(): Promise<void> {
    const list = this.pendingBrackets();
    if (!list.length || this.generatingAll()) return;
    const ok = await this.dialog.confirm({
      title: 'Generar todas las llaves',
      message: `Se generará la llave de ${plural(list.length, 'categoría', 'categorías')}: ${list
        .map((c) => `${c.name} (${c.entrant_count})`)
        .join(', ')}. Cada una queda como versión nueva; puedes regenerarla después.`,
      confirmText: `Generar ${list.length} ${pluralWord(list.length, 'llave', 'llaves')}`,
    });
    if (!ok) return;
    this.generatingAll.set(true);
    const done: string[] = [];
    const failed: string[] = [];
    for (const c of list) {
      let reason = 'cancelada';
      const res = await this.mut.post<Bracket>(
        `/categories/${c.id}/bracket`,
        {},
        {
          onError: (err) => {
            reason = err.fullMessage;
            return true;
          },
        },
      );
      if (res) done.push(c.name);
      else failed.push(`${c.name}: ${reason}`);
    }
    this.generatingAll.set(false);
    await this.ctx.loadCategories();
    const text = `${plural(done.length, 'llave generada', 'llaves generadas')}`;
    if (failed.length) this.toast.error(`${text}; ${plural(failed.length, 'falló', 'fallaron')}: ${failed.join('; ')}`);
    else this.toast.ok(text);
  }

  // --- Editar categoría (datos básicos; la sección «Reglas» se agrega aparte) ---
  readonly editCat = signal<Category | null>(null);
  readonly saving = signal(false);
  ec = this.editFields(null);

  private editFields(c: Category | null) {
    return {
      name: c?.name ?? '',
      sex: c?.sex ?? 'M',
      age_min: c?.age_min ?? null,
      age_max: c?.age_max ?? null,
      grade_min: c?.grade_min ?? null,
      grade_max: c?.grade_max ?? null,
      weight_class: c?.weight_class ?? '',
      duration_seconds: c?.duration_seconds ?? null,
      format: c?.format ?? null,
      third_place_rule: c?.third_place_rule ?? null,
      max_entrants: c?.max_entrants ?? null,
      weight_min_kg: c?.weight_min_kg ?? null,
      weight_max_kg: c?.weight_max_kg ?? null,
    };
  }

  /** Reglas de la categoría en edición (vacío = hereda del torneo). */
  ruleKumite: Record<string, any> = {};
  ruleKata: Record<string, any> = {};
  ruleComp: Record<string, any> = {};

  formatLocked(c: Category): boolean {
    return ['in_progress', 'finished'].includes(c.status);
  }

  openEdit(c: Category): void {
    this.ec = this.editFields(c);
    this.ruleKumite = { ...(c.kumite_rules ?? {}) };
    // Las columnas de kata (método, estructura, jueces) se editan junto con kata_rules.
    this.ruleKata = {
      ...editableKata(c.kata_rules),
      method: c.kata_method ?? undefined,
      structure: c.kata_structure ?? undefined,
      judges: c.kata_judges ?? undefined,
    };
    this.ruleComp = { ...(c.competition_rules ?? {}) };
    this.editCat.set(c);
  }

  async saveEdit(c: Category): Promise<void> {
    const f = this.ec;
    const num = (v: unknown) => (v === '' || v === null || v === undefined ? null : Number(v));
    const next: Record<string, unknown> = {
      name: f.name.trim(),
      sex: f.sex,
      age_min: num(f.age_min),
      age_max: num(f.age_max),
      grade_min: f.grade_min,
      grade_max: f.grade_max,
      weight_class: f.weight_class.trim() || null,
      duration_seconds: c.modality === 'kumite' ? num(f.duration_seconds) : c.duration_seconds,
      format: f.format,
      third_place_rule: f.third_place_rule,
      max_entrants: num(f.max_entrants),
      kumite_rules: cleanRules(this.ruleKumite),
      competition_rules: cleanRules(this.ruleComp),
    };
    if (c.modality === 'kumite') {
      next['weight_min_kg'] = num(f.weight_min_kg);
      next['weight_max_kg'] = num(f.weight_max_kg);
    } else {
      const { method, structure, judges, ...rest } = this.ruleKata;
      next['kata_method'] = method ?? null;
      next['kata_structure'] = structure ?? null;
      next['kata_judges'] = judges ?? null;
      next['kata_rules'] = kataPayload(rest);
    }
    // Solo se envía lo que cambió (lo estructural no se toca si la categoría ya empezó).
    const structural = ['format', 'third_place_rule', 'kata_method', 'kata_structure', 'kata_judges', 'kata_rules'];
    const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const body: Record<string, unknown> = { version: c.version };
    for (const [k, v] of Object.entries(next)) {
      if (structural.includes(k) && this.formatLocked(c)) continue;
      if (!same((c as unknown as Record<string, unknown>)[k], v)) body[k] = v;
    }
    if (Object.keys(body).length === 1) {
      this.editCat.set(null);
      return;
    }
    this.saving.set(true);
    const res = await this.mut.patch<Category>(`/categories/${c.id}`, body, {
      success: 'Categoría actualizada',
      onConflict: () => this.reload(),
    });
    this.saving.set(false);
    if (res) {
      this.editCat.set(null);
      this.reload();
    }
  }

  blankCategory() {
    return {
      code: '',
      name: '',
      modality: 'kumite' as 'kumite' | 'kata',
      sex: 'M',
      age_min: null as number | null,
      age_max: null as number | null,
      grade_min: null as number | null,
      grade_max: null as number | null,
      weight_class: '',
      format: null as string | null,
      duration_seconds: null as number | null,
      kata_method: null as string | null,
      kata_judges: null as number | null,
      is_team: false,
      max_entrants: null as number | null,
      team_bouts: 3,
      team_tie_rule: 'points' as 'points' | 'extra_bout',
    };
  }

  openCreate(): void {
    this.nc = this.blankCategory();
    this.createOpen.set(true);
  }

  async create(): Promise<void> {
    const { team_bouts, team_tie_rule, ...fields } = this.nc;
    const body = {
      ...fields,
      weight_class: fields.weight_class || null,
      max_entrants: fields.max_entrants || null,
      kumite_rules: fields.is_team && fields.modality === 'kumite' ? { team_bouts, team_tie_rule } : null,
    };
    const res = await this.mut.post<Category>(`/tournaments/${this.ctx.id()}/categories`, body, {
      success: 'Categoría creada',
    });
    if (res) {
      this.createOpen.set(false);
      this.reload();
    }
  }
}
