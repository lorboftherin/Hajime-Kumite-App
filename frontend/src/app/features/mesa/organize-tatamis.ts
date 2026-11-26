import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiError } from '../../core/api-error';
import { ApiService } from '../../core/api.service';
import { Category, Tournament } from '../../core/models';
import { MutationService } from '../../core/mutation.service';
import { ToastService } from '../../core/toast.service';
import { StatusBadge } from '../../shared/badge';
import { PageHead } from '../../shared/page-head';
import {
  NO_TATAMI,
  PlanCategory,
  PlanRule,
  applyRules,
  currentPlan,
  moveTo,
  moveWithin,
  sortByCode,
} from './tatami-plan';

/**
 * Organizar tatamis: el coordinador cambia el plan a último momento («hombres
 * al tatami 2, mujeres al 1, de 13 años para arriba al 2»). Lo hace la mesa o
 * el organizador: reglas rápidas, mover una categoría a otro tatami y
 * reordenar con flechas. Dentro de cada tatami el orden por defecto es por
 * código (A1, B1, A2, B2…). Nada se guarda hasta «Guardar».
 */
@Component({
  selector: 'app-organize-tatamis',
  imports: [FormsModule, RouterLink, PageHead, StatusBadge],
  template: `
    <div class="container">
      <app-page-head i18n-title="@@organizar.titulo" kanji="畳" title="Organizar tatamis">
        <div meta class="meta-line"
          >{{ tournament()?.name }} ·
          <ng-container i18n="@@organizar.sub"
            >Repartir categorías entre tatamis y ordenar sus colas</ng-container
          ></div
        >
        <a class="btn" routerLink="/mi-tatami" i18n="@@organizar.volver">← Volver a Mi tatami</a>
      </app-page-head>

      @if (error()) {
        <div class="alert danger">{{ error() }}</div>
      }

      <section class="card rules" aria-labelledby="rules-h">
        <h2 id="rules-h" i18n="@@organizar.reparto-rapido">Reparto rápido</h2>
        <p class="small muted" i18n="@@organizar.reparto-ayuda"
          >Cada regla manda las categorías que calzan a un tatami. La primera regla que calza
          decide. Las que no calzan con ninguna se quedan donde están.</p
        >
        @for (r of rules(); track $index; let i = $index) {
          <div class="rule">
            <select
              [ngModel]="r.sex"
              (ngModelChange)="setRule(i, { sex: $event })"
              aria-label="Sexo"
            >
              <option i18n="@@organizar.todos" value="">Todos</option>
              <option i18n="@@organizar.hombres" value="M">Hombres</option>
              <option i18n="@@organizar.mujeres" value="F">Mujeres</option>
            </select>
            <label class="age"
              ><span i18n="@@organizar.edad-desde">de</span
              ><input
                type="number"
                min="0"
                inputmode="numeric"
                [ngModel]="r.ageFrom"
                (ngModelChange)="setRule(i, { ageFrom: num($event) })"
                aria-label="Edad desde" /></label
            ><label class="age"
              ><span i18n="@@organizar.edad-hasta">a</span
              ><input
                type="number"
                min="0"
                inputmode="numeric"
                [ngModel]="r.ageTo"
                (ngModelChange)="setRule(i, { ageTo: num($event) })"
                aria-label="Edad hasta"
              /><span i18n="@@organizar.anios">años</span></label
            >
            <select
              [ngModel]="r.modality"
              (ngModelChange)="setRule(i, { modality: $event })"
              aria-label="Modalidad"
            >
              <option i18n="@@organizar.kata-y-kumite" value="">Kata y kumite</option>
              <option value="kata">Kata</option>
              <option value="kumite">Kumite</option>
            </select>
            <span aria-hidden="true">→</span>
            <select
              [ngModel]="r.tatamiId"
              (ngModelChange)="setRule(i, { tatamiId: $event })"
              aria-label="Tatami"
            >
              <option [ngValue]="null" i18n="@@organizar.elige-tatami">Elige tatami</option>
              @for (t of tatamis(); track t.id) {
                <option [ngValue]="t.id">{{ t.name || 'Tatami ' + t.number }}</option>
              }
            </select>
            <button class="btn ghost sm" (click)="removeRule(i)" i18n="@@organizar.quitar"
              >Quitar</button
            >
          </div>
        }
        <div class="row">
          <button class="btn" (click)="addRule()" i18n="@@organizar.agregar-regla"
            >+ Agregar regla</button
          >
          <button
            class="btn primary"
            [disabled]="!rules().length"
            (click)="apply()"
            i18n="@@organizar.aplicar-reglas"
            >Aplicar reglas</button
          >
          <button class="btn" (click)="sortAll()" i18n="@@organizar.ordenar-codigo"
            >Ordenar todo por código</button
          >
        </div>
      </section>

      <div class="cols">
        @for (col of columns(); track col.id) {
          <section class="card col" [attr.aria-label]="col.name">
            <h2>
              {{ col.name }}
              <span class="muted small">{{ col.cats.length }}</span>
            </h2>
            <ol class="list">
              @for (c of col.cats; track c.id; let first = $first; let last = $last) {
                <li [class.live]="c.status === 'in_progress'">
                  <span class="catcode">{{ c.code }}</span>
                  <span class="grow">
                    <span class="nm">{{ c.name }}</span>
                    <span
                      class="small muted"
                      i18n="@@organizar.n-inscritos"
                      >{c.entrant_count, plural,
                        =1 {1 inscrito}
                        other {{{ c.entrant_count }} inscritos}
                      }</span
                    >
                  </span>
                  @if (c.status === 'in_progress' || c.status === 'finished') {
                    <app-status [status]="c.status" type="category" />
                  }
                  <span class="ctl">
                    <button
                      class="btn sm"
                      [disabled]="first || col.id === noTatami"
                      (click)="up(col.id, c.id)"
                      aria-label="Subir"
                      >▲</button
                    >
                    <button
                      class="btn sm"
                      [disabled]="last || col.id === noTatami"
                      (click)="down(col.id, c.id)"
                      aria-label="Bajar"
                      >▼</button
                    >
                    <select
                      [ngModel]="col.id"
                      (ngModelChange)="move(c.id, $event)"
                      aria-label="Mover a"
                    >
                      @for (t of tatamis(); track t.id) {
                        <option [ngValue]="t.id">{{ t.name || 'Tatami ' + t.number }}</option>
                      }
                      <option [ngValue]="noTatami" i18n="@@organizar.sin-tatami">Sin tatami</option>
                    </select>
                  </span>
                </li>
              } @empty {
                <li class="empty muted small" i18n="@@organizar.vacio">Sin categorías</li>
              }
            </ol>
          </section>
        }
      </div>

      <div class="savebar">
        <label class="small"
          ><input type="checkbox" [ngModel]="showEmpty()" (ngModelChange)="showEmpty.set($event)" />
          <ng-container i18n="@@organizar.mostrar-vacias"
            >Mostrar categorías sin inscritos</ng-container
          ></label
        >
        <span class="grow"></span>
        @if (dirty()) {
          <button class="btn" (click)="reset()" i18n="@@organizar.descartar">Descartar</button>
        }
        <button
          class="btn primary"
          [disabled]="!dirty() || busy()"
          (click)="save()"
          i18n="@@organizar.guardar"
          >Guardar cambios</button
        >
      </div>
    </div>
  `,
  styles: `
    .rules {
      margin-bottom: 1rem;
      h2 {
        margin-top: 0;
      }
    }
    .rule {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.4rem;
      margin: 0.4rem 0;
      select,
      input {
        min-height: 40px;
      }
      .age {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        input {
          width: 4.2rem;
        }
      }
    }
    .row {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-top: 0.6rem;
    }
    .cols {
      display: grid;
      gap: 1rem;
      grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
      align-items: start;
    }
    .col h2 {
      margin-top: 0;
      display: flex;
      justify-content: space-between;
    }
    .list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 0.4rem;
      li {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        padding: 0.5rem 0.6rem;
        border: 1px solid var(--kasumi);
        border-radius: var(--radius);
        background: var(--kinu);
        &.live {
          border-color: var(--yamabuki);
        }
        &.empty {
          border-style: dashed;
          justify-content: center;
        }
      }
      .catcode {
        font-size: 1.15rem;
      }
      .grow {
        flex: 1;
        min-width: 0;
        display: grid;
      }
      .nm {
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        line-height: 1.25;
      }
      .ctl {
        display: inline-flex;
        gap: 0.25rem;
        select {
          max-width: 8.5rem;
        }
      }
    }
    .savebar {
      position: sticky;
      bottom: 0;
      display: flex;
      align-items: center;
      gap: 0.6rem;
      margin-top: 1rem;
      padding: 0.75rem 0 calc(0.75rem + var(--safe-bottom, 0px));
      background: var(--washi);
      border-top: 1px solid var(--kasumi);
      .grow {
        flex: 1;
      }
    }
  `,
})
export class OrganizeTatamisPage {
  readonly id = input.required<string>();
  private api = inject(ApiService);
  private mut = inject(MutationService);
  private toast = inject(ToastService);

  readonly noTatami = NO_TATAMI;
  readonly tournament = signal<Tournament | null>(null);
  readonly cats = signal<Category[]>([]);
  readonly plan = signal<Record<number, number[]>>({});
  private saved: Record<number, number[]> = {};
  readonly rules = signal<PlanRule[]>([]);
  readonly showEmpty = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');

  readonly tatamis = computed(() => this.tournament()?.tatamis ?? []);
  private readonly byId = computed(() => new Map(this.planCats().map((c) => [c.id, c])));
  /** Categorías que se pueden repartir (no fusionadas ni canceladas). */
  private readonly planCats = computed(
    () =>
      this.cats().filter((c) => !['merged', 'cancelled'].includes(c.status)) as unknown as Array<
        PlanCategory & Category
      >,
  );
  readonly columns = computed(() => {
    const map = this.byId();
    const cols = [
      ...this.tatamis().map((t) => ({ id: t.id, name: t.name || `Tatami ${t.number}` })),
      { id: NO_TATAMI, name: $localize`:@@organizar.sin-tatami-col:Sin tatami` },
    ];
    return cols.map((col) => ({
      ...col,
      cats: (this.plan()[col.id] ?? [])
        .map((id) => map.get(id))
        .filter((c): c is PlanCategory & Category => !!c)
        .filter((c) => this.showEmpty() || c.entrant_count > 0 || c.status !== 'empty'),
    }));
  });
  readonly dirty = computed(() => JSON.stringify(this.plan()) !== JSON.stringify(this.saved));

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => this.load(Number(id)));
    });
  }

  async load(tid: number): Promise<void> {
    try {
      const [t, cats] = await Promise.all([
        firstValueFrom(this.api.get<Tournament>(`/tournaments/${tid}`)),
        firstValueFrom(this.api.get<Category[]>(`/tournaments/${tid}/categories`)),
      ]);
      this.tournament.set(t);
      this.cats.set(cats);
      this.saved = currentPlan(
        this.planCats(),
        t.tatamis.map((x) => x.id),
      );
      this.plan.set(this.saved);
      if (!this.rules().length && t.tatamis.length > 1) {
        this.rules.set([
          { sex: 'M', ageFrom: null, ageTo: null, modality: '', tatamiId: null },
          { sex: 'F', ageFrom: null, ageTo: null, modality: '', tatamiId: null },
        ]);
      }
    } catch (e) {
      this.error.set(ApiError.from(e).fullMessage);
    }
  }

  num(v: unknown): number | null {
    return v === '' || v === null || v === undefined ? null : Number(v);
  }
  setRule(i: number, patch: Partial<PlanRule>): void {
    this.rules.update((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }
  addRule(): void {
    this.rules.update((rs) => [
      ...rs,
      { sex: '', ageFrom: null, ageTo: null, modality: '', tatamiId: null },
    ]);
  }
  removeRule(i: number): void {
    this.rules.update((rs) => rs.filter((_, j) => j !== i));
  }

  apply(): void {
    const valid = this.rules().filter((r) => r.tatamiId !== null);
    if (!valid.length) {
      this.toast.warn($localize`:@@organizar.falta-tatami:Elige el tatami de cada regla.`);
      return;
    }
    this.plan.set(
      applyRules(
        this.planCats(),
        valid,
        this.tatamis().map((t) => t.id),
      ),
    );
  }

  sortAll(): void {
    const map = this.byId();
    const out: Record<number, number[]> = {};
    for (const [k, ids] of Object.entries(this.plan())) {
      out[Number(k)] = sortByCode(ids.map((id) => map.get(id)!).filter(Boolean)).map((c) => c.id);
    }
    this.plan.set(out);
  }

  up(col: number, id: number): void {
    this.plan.update((p) => ({ ...p, [col]: moveWithin(p[col], id, -1) }));
  }
  down(col: number, id: number): void {
    this.plan.update((p) => ({ ...p, [col]: moveWithin(p[col], id, 1) }));
  }
  move(id: number, dest: number): void {
    this.plan.update((p) => moveTo(p, id, Number(dest), this.byId()));
  }
  reset(): void {
    this.plan.set(this.saved);
  }

  /** Reparto en una operación (advierte si una categoría en curso cambia de tatami) y luego el orden exacto de cada cola. */
  async save(): Promise<void> {
    const t = this.tournament();
    if (!t || this.busy()) return;
    this.busy.set(true);
    try {
      const plan = this.plan();
      const assignments = Object.entries(plan).flatMap(([k, ids]) =>
        ids.map((id) => ({
          category_id: id,
          tatami_id: Number(k) === NO_TATAMI ? null : Number(k),
        })),
      );
      const ok = await this.mut.put(`/tournaments/${t.id}/tatami-plan`, {
        assignments,
        order: 'keep',
      });
      if (!ok) return;
      for (const tat of this.tatamis()) {
        await firstValueFrom(
          this.api.put(`/tatamis/${tat.id}/queue`, { category_ids: plan[tat.id] ?? [] }),
        );
      }
      this.toast.ok(
        $localize`:@@organizar.guardado:Tatamis guardados. La mesa y la planilla ya usan este orden.`,
      );
      await this.load(t.id);
    } catch (e) {
      this.toast.error(ApiError.from(e).fullMessage);
    } finally {
      this.busy.set(false);
    }
  }
}
