import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { DialogService } from '../../../core/dialog.service';
import { ADVICE_LABEL, CATEGORY_STATUS, FORMAT_LABEL, GRADES, MODALITY_LABEL, SEX_LABEL } from '../../../core/format';
import { Bracket, Category } from '../../../core/models';
import { MutationService } from '../../../core/mutation.service';
import { StatusBadge } from '../../../shared/badge';
import { Modal } from '../../../shared/modal';
import { LabelPipe } from '../../../shared/pipes';
import { TournamentContext } from '../tournament-context';

@Component({
  selector: 'app-categories-tab',
  imports: [FormsModule, RouterLink, StatusBadge, Modal, LabelPipe],
  template: `
    <div class="card filters">
      <div class="row">
        <input class="grow" placeholder="Buscar por nombre o código…" [ngModel]="q()" (ngModelChange)="q.set($event)" />
        <select [ngModel]="status()" (ngModelChange)="status.set($event)">
          <option value="">Todos los estados</option>
          @for (s of statusKeys; track s) {
            <option [value]="s">{{ statusLabel[s] }}</option>
          }
        </select>
        <select [ngModel]="modality()" (ngModelChange)="modality.set($event)">
          <option value="">Kumite y kata</option>
          <option value="kumite">Kumite</option>
          <option value="kata">Kata</option>
        </select>
        <label class="field inline small"><input type="checkbox" [ngModel]="hideEmpty()" (ngModelChange)="hideEmpty.set($event)" /> Ocultar vacías</label>
      </div>
      <div class="row mt">
        <button class="btn primary sm" (click)="openCreate()">+ Categoría manual</button>
        <button class="btn sm" [disabled]="selected().size < 2" (click)="openMerge()">Fusionar seleccionadas ({{ selected().size }})</button>
        <button class="btn sm" (click)="reload()">↻ Recargar</button>
        <span class="muted small grow right">{{ filtered().length }} de {{ ctx.categories().length }} categorías</span>
      </div>
    </div>

    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th></th>
            <th>Categoría</th>
            <th>Modalidad</th>
            <th class="center">Inscritos</th>
            <th>Estado</th>
            <th>Tatami / cola</th>
            <th>Sugerencias</th>
            <th class="right">Acciones</th>
          </tr>
        </thead>
        <tbody>
          @for (c of filtered(); track c.id) {
            <tr [class.selected]="selected().has(c.id)">
              <td><input type="checkbox" [checked]="selected().has(c.id)" (change)="toggle(c.id)" [attr.aria-label]="'Seleccionar ' + c.name" /></td>
              <td>
                <div><strong>{{ c.name }}</strong> @if (c.is_manual) {<span class="badge info">manual</span>}</div>
                <div class="muted small mono">{{ c.code }}</div>
                @if (c.merged_into_id) {
                  <div class="small">→ fusionada en {{ catName(c.merged_into_id) }}</div>
                }
                @if (c.cancel_reason) {
                  <div class="small error-text">Cancelada: {{ c.cancel_reason }}</div>
                }
              </td>
              <td>{{ c.modality | label: modalityLabel }} · {{ c.sex | label: sexLabel }}</td>
              <td class="center"><strong>{{ c.entrant_count }}</strong></td>
              <td><app-status [status]="c.status" /></td>
              <td class="nowrap">
                @if (c.tatami_id) {
                  {{ tatamiName(c.tatami_id) }} · #{{ c.queue_position ?? '—' }}
                } @else {
                  <span class="muted">—</span>
                }
              </td>
              <td class="small">
                @if (c.advice.length && c.status !== 'empty') {
                  <span class="advice">Opciones: {{ adviceText(c.advice) }}</span>
                }
              </td>
              <td class="right actions">
                @if (hasBracket(c)) {
                  <a class="btn sm" [routerLink]="['/categorias', c.id, 'llave']">Llave</a>
                } @else if (c.status === 'open' && c.entrant_count > 0) {
                  <button class="btn sm primary" (click)="generate(c)">Generar llave</button>
                }
                <button class="btn sm" (click)="openTatami(c)">Tatami</button>
                @if (mergeTargets().has(c.id)) {
                  <button class="btn sm" (click)="unmerge(c)" title="Deshacer fusiones hacia esta categoría">Separar</button>
                }
                @if (c.status === 'finished') {
                  <button class="btn sm" (click)="reopen(c)" title="Reabrir una categoría finalizada (con motivo)">Reabrir categoría</button>
                }
                @if (c.status !== 'cancelled' && c.status !== 'merged') {
                  <button class="btn sm ghost" (click)="cancel(c)">Cancelar</button>
                }
              </td>
            </tr>
          } @empty {
            <tr><td colspan="8" class="empty">No hay categorías con esos filtros.</td></tr>
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
                <option value="kata_rounds">Rondas de kata</option>
              </select>
            </label>
            @if (nc.modality === 'kumite') {
              <label class="field"><span>Duración (seg)</span><input type="number" name="dur" [(ngModel)]="nc.duration_seconds" /></label>
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
    .filters {
      padding: 0.75rem;
    }
    .actions {
      white-space: nowrap;
      .btn {
        margin-left: 0.25rem;
      }
    }
    .advice {
      color: var(--warn);
    }
  `,
})
export class CategoriesTab {
  readonly ctx = inject(TournamentContext);
  private mut = inject(MutationService);
  private dialog = inject(DialogService);
  private router = inject(Router);

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
    const res = await this.mut.post<Bracket>(`/categories/${c.id}/bracket`, {}, { success: 'Llave generada' });
    if (res) this.router.navigate(['/categorias', c.id, 'llave']);
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
    };
  }

  openCreate(): void {
    this.nc = this.blankCategory();
    this.createOpen.set(true);
  }

  async create(): Promise<void> {
    const body = { ...this.nc, weight_class: this.nc.weight_class || null, is_team: false };
    const res = await this.mut.post<Category>(`/tournaments/${this.ctx.id()}/categories`, body, {
      success: 'Categoría creada',
    });
    if (res) {
      this.createOpen.set(false);
      this.reload();
    }
  }
}
