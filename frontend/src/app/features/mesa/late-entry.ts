import { Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiError } from '../../core/api-error';
import { ApiService } from '../../core/api.service';
import { GRADES } from '../../core/format';
import { Category, Dojo } from '../../core/models';
import { MutationService } from '../../core/mutation.service';
import { ToastService } from '../../core/toast.service';
import { Modal } from '../../shared/modal';
import { PlanCategory, sortByCode, suggestFor } from './tatami-plan';

interface LateEntryResult {
  person_id: number;
  name: string;
  results: Array<{
    code: string;
    name: string;
    mode: 'bye' | 'generated' | 'regenerated' | 'waiting' | 'registered_only';
    reprint: boolean;
    message?: string;
  }>;
}

/**
 * «+ Competidor»: alguien llega sin estar inscrito y el torneo ya corre. La mesa
 * lo registra con lo mínimo (nombre, sexo, edad, grado, sede), la app sugiere sus
 * categorías y lo mete en la llave en el mismo paso, sin salir de la mesa.
 */
@Component({
  selector: 'app-late-entry',
  imports: [FormsModule, Modal],
  template: `
    <app-modal
      i18n-title="@@mesa.tardio.titulo"
      title="Agregar competidor que llegó tarde"
      [wide]="true"
      (closed)="closed.emit()"
    >
      <form (ngSubmit)="save()" class="stack">
        <div class="grid-2">
          <label class="field"
            ><span i18n="@@mesa.tardio.nombres">Nombres</span
            ><input name="first" [(ngModel)]="first" required autocomplete="off"
          /></label>
          <label class="field"
            ><span i18n="@@mesa.tardio.apellidos">Apellidos</span
            ><input name="last" [(ngModel)]="last" required autocomplete="off"
          /></label>
        </div>
        <div class="grid-3">
          <fieldset class="field">
            <legend i18n="@@mesa.tardio.sexo">Sexo</legend>
            <div class="seg">
              <button
                type="button"
                class="btn"
                [class.primary]="sex() === 'M'"
                (click)="sex.set('M')"
                i18n="@@mesa.tardio.masculino"
                >Masculino</button
              >
              <button
                type="button"
                class="btn"
                [class.primary]="sex() === 'F'"
                (click)="sex.set('F')"
                i18n="@@mesa.tardio.femenino"
                >Femenino</button
              >
            </div>
          </fieldset>
          <label class="field"
            ><span i18n="@@mesa.tardio.edad">Edad</span
            ><input
              name="age"
              type="number"
              min="0"
              max="99"
              inputmode="numeric"
              [ngModel]="age()"
              (ngModelChange)="age.set($event === '' || $event === null ? null : +$event)"
          /></label>
          <label class="field"
            ><span i18n="@@mesa.tardio.grado">Grado</span
            ><select name="grade" [ngModel]="grade()" (ngModelChange)="grade.set($event)">
              <option i18n="@@mesa.tardio.sin-grado" [ngValue]="null">Sin grado</option>
              @for (g of grades; track g) {
                <option [ngValue]="g">{{ g }}</option>
              }
            </select></label
          >
        </div>
        <label class="field"
          ><span i18n="@@mesa.tardio.sede">Sede o dojo</span
          ><select name="dojo" [(ngModel)]="dojoId">
            <option i18n="@@mesa.tardio.independiente" [ngValue]="null">Independiente</option>
            @for (d of dojos(); track d.id) {
              <option [ngValue]="d.id">{{ d.name }}</option>
            }
          </select></label
        >

        <fieldset class="field">
          <legend i18n="@@mesa.tardio.categorias">Categorías</legend>
          @if (!sex() || age() === null) {
            <p i18n="@@mesa.tardio.elige-sexo-edad" class="small muted"
              >Elige sexo y edad para ver las categorías que le corresponden.</p
            >
          }
          <div class="cats">
            @for (c of shown(); track c.id) {
              <label class="cat" [class.on]="chosen().has(c.id)">
                <input type="checkbox" [checked]="chosen().has(c.id)" (change)="toggle(c.id)" />
                <span class="catcode">{{ c.code }}</span>
                <span class="grow">{{ c.name }}</span>
              </label>
            }
          </div>
          <label class="small"
            ><input
              type="checkbox"
              name="all"
              [ngModel]="showAll()"
              (ngModelChange)="showAll.set($event)"
            />
            <ng-container i18n="@@mesa.tardio.ver-todas"
              >Ver todas las categorías</ng-container
            ></label
          >
        </fieldset>

        <div class="form-actions">
          <button type="button" class="btn" (click)="closed.emit()" i18n="@@mesa.tardio.cancelar"
            >Cancelar</button
          >
          <button
            type="submit"
            class="btn primary"
            [disabled]="busy() || !canSave()"
            i18n="@@mesa.tardio.agregar"
            >Agregar e incluir en la llave</button
          >
        </div>
      </form>
    </app-modal>
  `,
  styles: `
    .stack {
      display: grid;
      gap: 0.9rem;
    }
    .grid-3 {
      display: grid;
      gap: 0.75rem;
      grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    }
    fieldset {
      border: 0;
      padding: 0;
      margin: 0;
    }
    .seg {
      display: flex;
      gap: 0.4rem;
      .btn {
        flex: 1;
      }
    }
    .cats {
      display: grid;
      gap: 0.4rem;
      max-height: 16rem;
      overflow: auto;
    }
    .cat {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      padding: 0.55rem 0.7rem;
      border: 1px solid var(--kasumi);
      border-radius: var(--radius);
      cursor: pointer;
      &.on {
        border-color: var(--ai);
        background: var(--ai-soft);
      }
      .catcode {
        font-size: 1.05rem;
      }
    }
    .grow {
      flex: 1;
      min-width: 0;
    }
  `,
})
export class LateEntryDialog implements OnInit {
  readonly tournamentId = input.required<number>();
  readonly tatamiId = input.required<number>();
  readonly closed = output<void>();
  readonly done = output<void>();

  private api = inject(ApiService);
  private mut = inject(MutationService);
  private toast = inject(ToastService);

  readonly grades = GRADES.slice(0, 10);
  first = '';
  last = '';
  dojoId: number | null = null;
  readonly sex = signal<'M' | 'F' | ''>('');
  readonly age = signal<number | null>(null);
  readonly grade = signal<string | null>(null);
  readonly dojos = signal<Dojo[]>([]);
  readonly cats = signal<Category[]>([]);
  readonly picked = signal<Set<number> | null>(null);
  readonly busy = signal(false);
  readonly showAll = signal(false);

  readonly suggested = computed(() =>
    this.sex() && this.age() !== null
      ? sortByCode(
          suggestFor(
            this.cats() as unknown as PlanCategory[],
            this.sex(),
            this.age(),
            this.grade(),
          ),
        )
      : [],
  );
  readonly shown = computed(() => {
    if (this.showAll()) {
      return sortByCode(
        (this.cats() as unknown as PlanCategory[]).filter(
          (c) => !['merged', 'cancelled', 'finished'].includes(c.status) && !c.is_team,
        ),
      );
    }
    return this.suggested();
  });
  /** Por defecto, todas las sugeridas (kata y kumite de su edad y grado). */
  readonly chosen = computed(() => this.picked() ?? new Set(this.suggested().map((c) => c.id)));

  async ngOnInit(): Promise<void> {
    try {
      const [dojos, cats] = await Promise.all([
        firstValueFrom(this.api.get<Dojo[]>('/dojos')),
        firstValueFrom(this.api.get<Category[]>(`/tournaments/${this.tournamentId()}/categories`)),
      ]);
      this.dojos.set([...dojos].sort((a, b) => a.name.localeCompare(b.name)));
      this.cats.set(cats);
    } catch (e) {
      this.toast.error(ApiError.from(e).fullMessage);
    }
  }

  toggle(id: number): void {
    const s = new Set(this.chosen());
    if (s.has(id)) s.delete(id);
    else s.add(id);
    this.picked.set(s);
  }

  canSave(): boolean {
    return !!(this.first.trim() && this.last.trim() && this.sex() && this.chosen().size);
  }

  async save(): Promise<void> {
    if (!this.canSave() || this.busy()) return;
    this.busy.set(true);
    try {
      const res = await this.mut.post<LateEntryResult>(`/tatamis/${this.tatamiId()}/late-entry`, {
        first_names: this.first.trim(),
        last_names: this.last.trim(),
        sex: this.sex(),
        age: this.age(),
        grade: this.grade(),
        dojo_id: this.dojoId,
        category_ids: [...this.chosen()],
      });
      if (!res) return;
      const lines = res.results.map((r) => {
        switch (r.mode) {
          case 'bye':
            return $localize`:@@mesa.tardio.res-bye:${r.code}:code: · entra en un bye libre (reimprime la llave)`;
          case 'regenerated':
            return $localize`:@@mesa.tardio.res-regen:${r.code}:code: · llave sorteada de nuevo (reimprime la llave)`;
          case 'generated':
            return $localize`:@@mesa.tardio.res-gen:${r.code}:code: · ya hay llave (imprímela)`;
          case 'waiting':
            return $localize`:@@mesa.tardio.res-solo:${r.code}:code: · inscrito; falta un rival para la llave`;
          default:
            return $localize`:@@mesa.tardio.res-solo-inscrito:${r.code}:code: · inscrito, pero la llave ya empezó sin bye libre`;
        }
      });
      this.toast.ok(
        $localize`:@@mesa.tardio.listo:${res.name}:name: agregado. ` + lines.join(' · '),
      );
      this.done.emit();
    } finally {
      this.busy.set(false);
    }
  }
}
