import { Component, OnInit, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Category } from '../../core/models';
import { MutationService } from '../../core/mutation.service';
import { Modal } from '../../shared/modal';
import { RulesForm, cleanRules, editableKata, kataPayload } from '../../shared/rules-form';

/**
 * Formato y reglas de una categoría: cada campo vacío hereda del torneo
 * (docs/reglas-configurables.md). Guarda con PATCH /categories/{id}.
 */
@Component({
  selector: 'app-category-rules',
  imports: [FormsModule, Modal, RulesForm],
  template: `
    <app-modal [title]="'Reglas · ' + category().name" [wide]="true" (closed)="closed.emit()">
      <form (ngSubmit)="save()" class="stack">
        <fieldset>
          <legend>Formato y cupo</legend>
          <div class="grid-3">
            <label class="field">
              <span>Formato</span>
              <select name="fmt" [(ngModel)]="f.format">
                <option [ngValue]="null">Por defecto del torneo</option>
                <option value="single_elimination">Eliminación directa</option>
                <option value="round_robin">Round robin</option>
                <option value="groups_knockout">Grupos + eliminación</option>
                @if (category().modality === 'kata') {
                  <option value="kata_rounds">Rondas de kata</option>
                }
              </select>
            </label>
            <label class="field">
              <span>Terceros lugares</span>
              <select name="tp" [(ngModel)]="f.third_place_rule">
                <option [ngValue]="null">Por defecto del torneo</option>
                <option value="two_bronzes">Dos bronces</option>
                <option value="third_place_match">Combate por el 3.º</option>
                <option value="repechage">Repechaje</option>
              </select>
            </label>
            <label class="field">
              <span>Cupo (máx. inscritos)</span>
              <input
                type="number"
                min="2"
                name="max"
                [(ngModel)]="f.max_entrants"
                placeholder="Sin cupo"
              />
              <span class="hint">Al superarlo se advierte y se sugiere dividir.</span>
            </label>
            @if (category().modality === 'kumite') {
              <label class="field">
                <span>Duración (seg)</span>
                <input
                  type="number"
                  min="10"
                  name="dur"
                  [(ngModel)]="f.duration_seconds"
                  placeholder="Del torneo"
                />
              </label>
              <label class="field">
                <span>Categoría de peso</span>
                <input name="wc" [(ngModel)]="f.weight_class" placeholder="-60, +84, 45-50" />
              </label>
              <div class="grid-2">
                <label class="field">
                  <span>Desde (kg)</span>
                  <input
                    type="number"
                    step="0.1"
                    name="wmin"
                    [(ngModel)]="f.weight_min_kg"
                    placeholder="—"
                  />
                </label>
                <label class="field">
                  <span>Hasta (kg)</span>
                  <input
                    type="number"
                    step="0.1"
                    name="wmax"
                    [(ngModel)]="f.weight_max_kg"
                    placeholder="—"
                  />
                </label>
              </div>
            }
          </div>
        </fieldset>
        <app-rules-form
          mode="category"
          [modality]="category().modality"
          [isTeam]="category().is_team"
          [kumite]="kumite"
          [kata]="kata"
          [competition]="competition"
        />
        @if (locked()) {
          <p class="small warn-text">
            La categoría ya tiene combates: el formato y el kata no se pueden cambiar.
          </p>
        }
        <div class="form-actions">
          <button type="button" class="btn" (click)="closed.emit()">Cancelar</button>
          <button class="btn primary" [disabled]="saving()">Guardar</button>
        </div>
      </form>
    </app-modal>
  `,
})
export class CategoryRulesDialog implements OnInit {
  private mut = inject(MutationService);
  readonly category = input.required<Category>();
  readonly saved = output<Category>();
  readonly closed = output<void>();
  readonly saving = signal(false);
  readonly locked = signal(false);

  f = {
    format: null as string | null,
    third_place_rule: null as string | null,
    max_entrants: null as number | null,
    duration_seconds: null as number | null,
    weight_class: '' as string,
    weight_min_kg: null as number | null,
    weight_max_kg: null as number | null,
  };
  kumite: Record<string, any> = {};
  kata: Record<string, any> = {};
  competition: Record<string, any> = {};

  ngOnInit(): void {
    const c = this.category();
    this.locked.set(['in_progress', 'finished'].includes(c.status));
    this.f = {
      format: c.format,
      third_place_rule: c.third_place_rule,
      max_entrants: c.max_entrants ?? null,
      duration_seconds: c.duration_seconds,
      weight_class: c.weight_class ?? '',
      weight_min_kg: c.weight_min_kg ?? null,
      weight_max_kg: c.weight_max_kg ?? null,
    };
    this.kumite = { ...(c.kumite_rules ?? {}) };
    // Las columnas de kata (método, estructura, jueces) se editan junto con el resto.
    this.kata = {
      ...editableKata(c.kata_rules),
      method: c.kata_method ?? undefined,
      structure: c.kata_structure ?? undefined,
      judges: c.kata_judges ?? undefined,
    };
    this.competition = { ...(c.competition_rules ?? {}) };
  }

  async save(): Promise<void> {
    const c = this.category();
    const { method, structure, judges, ...kataRest } = this.kata;
    const body: Record<string, unknown> = {
      version: c.version,
      max_entrants: this.f.max_entrants || null,
      kumite_rules: cleanRules(this.kumite),
      competition_rules: cleanRules(this.competition),
    };
    if (c.modality === 'kumite') {
      body['duration_seconds'] = this.f.duration_seconds || null;
      body['weight_class'] = this.f.weight_class || null;
      body['weight_min_kg'] = this.f.weight_min_kg ?? null;
      body['weight_max_kg'] = this.f.weight_max_kg ?? null;
    }
    // Lo estructural solo se envía si cambió (el servidor lo bloquea con combates iniciados).
    const structural: Record<string, unknown> = {
      format: this.f.format,
      third_place_rule: this.f.third_place_rule,
    };
    if (c.modality === 'kata') {
      Object.assign(structural, {
        kata_method: method ?? null,
        kata_structure: structure ?? null,
        kata_judges: judges ?? null,
        kata_rules: kataPayload(kataRest),
      });
    }
    const current: Record<string, unknown> = {
      format: c.format,
      third_place_rule: c.third_place_rule,
      kata_method: c.kata_method,
      kata_structure: c.kata_structure,
      kata_judges: c.kata_judges,
      kata_rules: c.kata_rules ?? null,
    };
    for (const [k, v] of Object.entries(structural)) {
      if (JSON.stringify(v ?? null) !== JSON.stringify(current[k] ?? null)) body[k] = v;
    }
    this.saving.set(true);
    const res = await this.mut.patch<Category>(`/categories/${c.id}`, body, {
      success: 'Reglas de la categoría guardadas',
    });
    this.saving.set(false);
    if (res) this.saved.emit(res);
  }
}

/** Dividir una categoría en dos (por peso, grado o sorteo). Reversible. */
@Component({
  selector: 'app-category-split',
  imports: [FormsModule, Modal],
  template: `
    <app-modal [title]="'Dividir · ' + category().name" (closed)="closed.emit()">
      <p class="small muted">
        La categoría conserva la primera mitad de los {{ category().entrant_count }} inscritos y se
        crea otra con la segunda. Se puede deshacer mientras no haya combates. Una llave ya generada
        se descarta.
      </p>
      <div class="stack">
        <label class="field">
          <span>Criterio</span>
          <select [(ngModel)]="criterion">
            <option value="weight">Por peso declarado (los más livianos en la primera)</option>
            <option value="grade">Por grado (los de menor grado en la primera)</option>
            <option value="draw">Por sorteo (separando dojos)</option>
          </select>
        </label>
        <div class="grid-2">
          <label class="field"
            ><span>Nombre de la primera</span><input [(ngModel)]="nameA"
          /></label>
          <label class="field"
            ><span>Nombre de la segunda</span><input [(ngModel)]="nameB"
          /></label>
        </div>
        <label class="field"
          ><span>Motivo</span><input [(ngModel)]="reason" placeholder="Ej.: supera el cupo"
        /></label>
      </div>
      <div class="form-actions">
        <button class="btn" (click)="closed.emit()">Cancelar</button>
        <button class="btn primary" (click)="split()">Dividir</button>
      </div>
    </app-modal>
  `,
})
export class CategorySplitDialog implements OnInit {
  private mut = inject(MutationService);
  readonly category = input.required<Category>();
  readonly done = output<Category>();
  readonly closed = output<void>();

  criterion: 'weight' | 'grade' | 'draw' = 'draw';
  nameA = '';
  nameB = '';
  reason = '';

  ngOnInit(): void {
    const c = this.category();
    this.criterion = c.modality === 'kumite' && c.weight_class ? 'weight' : 'draw';
    this.nameA = `${c.name} (A)`;
    this.nameB = `${c.name} (B)`;
  }

  async split(): Promise<void> {
    const c = this.category();
    const res = await this.mut.post<Category>(
      `/categories/${c.id}/split`,
      {
        criterion: this.criterion,
        names: [this.nameA || `${c.name} (A)`, this.nameB || `${c.name} (B)`],
        reason: this.reason,
      },
      { success: 'Categoría dividida' },
    );
    if (res) this.done.emit(res);
  }
}
