import { Component, OnInit, inject, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Category } from '../../core/models';
import { MutationService } from '../../core/mutation.service';
import { Modal } from '../../shared/modal';

/** Dividir una categoría en dos (por peso, grado o sorteo). Reversible. */
@Component({
  selector: 'app-category-split',
  imports: [FormsModule, Modal],
  template: `
    <app-modal i18n-title="@@torneo.dividir.titulo" title="Dividir · {{ category().name }}" (closed)="closed.emit()">
      <p i18n="@@torneo.dividir.categoria-conserva-primera-mitad" class="small muted">
        La categoría conserva la primera mitad de los {{ category().entrant_count }} inscritos y se
        crea otra con la segunda. Se puede deshacer mientras no haya combates. Una llave ya generada
        se descarta.
      </p>
      <div class="stack">
        <label class="field">
          <span i18n="@@torneo.dividir.criterio">Criterio</span>
          <select [(ngModel)]="criterion">
            <option i18n="@@torneo.dividir.peso-declarado-mas-livianos" value="weight">Por peso declarado (los más livianos en la primera)</option>
            <option i18n="@@torneo.dividir.grado-menor-grado-primera" value="grade">Por grado (los de menor grado en la primera)</option>
            <option i18n="@@torneo.dividir.sorteo-separando-dojos" value="draw">Por sorteo (separando dojos)</option>
          </select>
        </label>
        <div class="grid-2">
          <label class="field"
            ><span i18n="@@torneo.dividir.nombre-primera">Nombre de la primera</span><input [(ngModel)]="nameA"
          /></label>
          <label class="field"
            ><span i18n="@@torneo.dividir.nombre-segunda">Nombre de la segunda</span><input [(ngModel)]="nameB"
          /></label>
        </div>
        <label class="field"
          ><span i18n="@@torneo.dividir.motivo">Motivo</span><input i18n-placeholder="@@torneo.dividir.ej-supera-cupo" [(ngModel)]="reason" placeholder="Ej.: supera el cupo"
        /></label>
      </div>
      <div class="form-actions">
        <button i18n="@@torneo.dividir.cancelar" class="btn" (click)="closed.emit()">Cancelar</button>
        <button i18n="@@torneo.dividir.dividir" class="btn primary" (click)="split()">Dividir</button>
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
      { success: $localize`:@@torneo.dividir.categoria-dividida:Categoría dividida` },
    );
    if (res) this.done.emit(res);
  }
}
