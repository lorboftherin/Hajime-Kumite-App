import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Subject, debounceTime, switchMap, of, catchError } from 'rxjs';
import { ApiService } from '../../../core/api.service';
import { DialogService } from '../../../core/dialog.service';
import { GRADES, fmtDate } from '../../../core/format';
import { Person, Registration, Suggestion, WithdrawResult } from '../../../core/models';
import { MutationService } from '../../../core/mutation.service';
import { ToastService } from '../../../core/toast.service';
import { StatusBadge } from '../../../shared/badge';
import { Modal } from '../../../shared/modal';
import { PersonForm } from '../../../shared/person-form';
import { TournamentContext } from '../tournament-context';

@Component({
  selector: 'app-registrations-tab',
  imports: [FormsModule, RouterLink, StatusBadge, Modal, PersonForm],
  template: `
    <div class="card">
      <div class="row">
        <input class="grow" placeholder="Filtrar por nombre, dojo o categoría…" [ngModel]="filter()" (ngModelChange)="filter.set($event)" />
        <select [ngModel]="catFilter()" (ngModelChange)="catFilter.set($event)">
          <option [ngValue]="0">Todas las categorías</option>
          @for (c of ctx.categories(); track c.id) {
            @if (c.entrant_count > 0) {
              <option [ngValue]="c.id">{{ c.name }} ({{ c.entrant_count }})</option>
            }
          }
        </select>
        <label class="field inline small"><input type="checkbox" [ngModel]="showWithdrawn()" (ngModelChange)="showWithdrawn.set($event)" /> Mostrar retiradas</label>
        <button class="btn primary" (click)="openRegister()">+ Inscribir</button>
      </div>
    </div>

    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>Competidor</th>
            <th>Dojo</th>
            <th>Categoría</th>
            <th>Grado</th>
            <th class="center">Edad</th>
            <th>Peso</th>
            <th>Estado</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          @for (r of filtered(); track r.id) {
            <tr [class.struck]="r.status === 'withdrawn'">
              <td>
                @if (r.person_id) {
                  <a [routerLink]="['/personas', r.person_id]">{{ r.person_name }}</a>
                } @else {
                  {{ r.person_name }}
                }
              </td>
              <td>{{ r.dojo_name }}</td>
              <td>
                {{ catName(r.category_id) }}
                @if (r.original_category_id !== r.category_id) {
                  <div class="muted small">orig.: {{ catName(r.original_category_id) }}</div>
                }
              </td>
              <td>{{ r.grade }}</td>
              <td class="center">{{ r.age_at_reference }}</td>
              <td>{{ r.weight_class }}</td>
              <td>
                <app-status [status]="r.status" type="registration" />
                @if (r.withdrawn_reason) {
                  <div class="muted small">{{ r.withdrawn_reason }}</div>
                }
              </td>
              <td class="right">
                @if (r.status === 'active') {
                  <button class="btn sm ghost" (click)="withdraw(r)">Retirar</button>
                }
              </td>
            </tr>
          } @empty {
            <tr><td colspan="8" class="empty">Sin inscripciones.</td></tr>
          }
        </tbody>
      </table>
    </div>
    <p class="muted small">{{ filtered().length }} inscripciones mostradas.</p>

    @if (regOpen()) {
      <app-modal title="Inscribir competidor" [wide]="true" (closed)="regOpen.set(false)">
        @if (!person()) {
          @if (!newPerson()) {
            <div class="row">
              <input class="grow" placeholder="Buscar persona por nombre o documento…" [ngModel]="search()" (ngModelChange)="onSearch($event)" autofocus />
              <button class="btn" (click)="newPerson.set(true)">+ Nueva persona</button>
            </div>
            <ul class="list-plain results">
              @for (p of results(); track p.id) {
                <li>
                  <button class="linklike" (click)="selectPerson(p)">
                    <strong>{{ p.last_names }}, {{ p.first_names }}</strong>
                    <span class="muted small">
                      {{ p.sex }} · {{ fdate(p.birth_date) || 'sin fecha de nac.' }} · {{ p.current_grade || 'sin grado' }}
                      @if (p.documents.length) { · {{ p.documents[0].doc_type }} {{ p.documents[0].number }} }
                    </span>
                  </button>
                </li>
              } @empty {
                @if (search().length >= 2 && !searching()) {
                  <li class="muted">Sin resultados. Puedes crear una persona nueva.</li>
                }
              }
            </ul>
          } @else {
            <h3>Nueva persona</h3>
            <app-person-form [initialName]="search()" (created)="selectPerson($event)" (useExisting)="selectPersonById($event)">
              <button type="button" class="btn" (click)="newPerson.set(false)">Volver a buscar</button>
            </app-person-form>
          }
        } @else {
          @let p = person()!;
          <div class="alert info row">
            <div class="grow">
              <strong>{{ p.first_names }} {{ p.last_names }}</strong>
              <span class="small"> · {{ p.sex }} · {{ fdate(p.birth_date) }} · {{ p.current_grade || 'sin grado' }}</span>
            </div>
            <button class="btn sm" (click)="person.set(null)">Cambiar</button>
          </div>
          <h3>Categorías sugeridas</h3>
          @if (suggestions().length) {
            <div class="stack">
              @for (s of suggestions(); track s.category_id) {
                <label class="field inline"><input type="checkbox" [checked]="chosen().has(s.category_id)" (change)="toggleCat(s.category_id)" /> {{ s.name }} <span class="badge">{{ s.modality }}</span></label>
              }
            </div>
          } @else {
            <p class="muted small">No hay categorías sugeridas por edad/sexo/grado. Puedes elegir otra (se pedirá confirmación).</p>
          }
          <div class="grid-2 mt">
            <label class="field">
              <span>Otra categoría (manual)</span>
              <select [ngModel]="0" (ngModelChange)="addOther($event)">
                <option [ngValue]="0">— Agregar otra categoría —</option>
                @for (c of openCategories(); track c.id) {
                  <option [ngValue]="c.id">{{ c.name }}</option>
                }
              </select>
            </label>
            <label class="field"><span>Categoría de peso declarada</span><input [(ngModel)]="weight" placeholder="Ej.: -60" /></label>
            <label class="field">
              <span>Grado (si difiere del vigente)</span>
              <select [(ngModel)]="grade">
                <option [ngValue]="null">Vigente</option>
                @for (g of grades; track g) {
                  <option [value]="g">{{ g }}</option>
                }
              </select>
            </label>
          </div>
          @if (extraChosen().length) {
            <div class="small mt">
              Manuales:
              @for (c of extraChosen(); track c) {
                <span class="badge info">{{ catName(c) }} <button class="x" (click)="toggleCat(c)">✕</button></span>
              }
            </div>
          }
          <div class="form-actions">
            <button class="btn" (click)="regOpen.set(false)">Cerrar</button>
            <button class="btn primary" [disabled]="!chosen().size || busy()" (click)="register()">Inscribir en {{ chosen().size }} categoría(s)</button>
          </div>
        }
      </app-modal>
    }
  `,
  styles: `
    .results {
      max-height: 45vh;
      overflow-y: auto;
      margin-top: 0.5rem;
    }
    .linklike {
      all: unset;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      width: 100%;
      &:hover strong {
        color: var(--ao);
      }
    }
    .x {
      border: 0;
      background: none;
      cursor: pointer;
      color: inherit;
      padding: 0 0 0 0.2rem;
    }
  `,
})
export class RegistrationsTab {
  readonly ctx = inject(TournamentContext);
  private api = inject(ApiService);
  private mut = inject(MutationService);
  private dialog = inject(DialogService);
  private toast = inject(ToastService);

  readonly grades = GRADES;
  readonly fdate = fmtDate;
  readonly regs = signal<Registration[]>([]);
  readonly filter = signal('');
  readonly catFilter = signal(0);
  readonly showWithdrawn = signal(false);

  readonly regOpen = signal(false);
  readonly search = signal('');
  readonly searching = signal(false);
  readonly results = signal<Person[]>([]);
  readonly newPerson = signal(false);
  readonly person = signal<Person | null>(null);
  readonly suggestions = signal<Suggestion[]>([]);
  readonly chosen = signal(new Set<number>());
  readonly busy = signal(false);
  weight = '';
  grade: string | null = null;

  private search$ = new Subject<string>();

  readonly filtered = computed(() => {
    const q = this.filter().trim().toLowerCase();
    const cat = this.catFilter();
    const byId = this.ctx.categoryById();
    return this.regs().filter(
      (r) =>
        (this.showWithdrawn() || r.status === 'active') &&
        (!cat || r.category_id === cat) &&
        (!q ||
          r.person_name.toLowerCase().includes(q) ||
          r.dojo_name.toLowerCase().includes(q) ||
          (byId.get(r.category_id)?.name.toLowerCase().includes(q) ?? false)),
    );
  });
  readonly openCategories = computed(() =>
    this.ctx.categories().filter((c) => !['merged', 'cancelled', 'finished'].includes(c.status)),
  );
  readonly extraChosen = computed(() => {
    const sug = new Set(this.suggestions().map((s) => s.category_id));
    return [...this.chosen()].filter((c) => !sug.has(c));
  });

  constructor() {
    this.load();
    this.search$
      .pipe(
        debounceTime(250),
        switchMap((q) => {
          if (q.trim().length < 2) return of([] as Person[]);
          this.searching.set(true);
          return this.api.get<Person[]>('/persons', { q, limit: 20 }).pipe(catchError(() => of([] as Person[])));
        }),
      )
      .subscribe((r) => {
        this.results.set(r);
        this.searching.set(false);
      });
  }

  load(): void {
    this.api.get<Registration[]>(`/tournaments/${this.ctx.id()}/registrations`).subscribe({
      next: (r) => this.regs.set(r),
      error: () => {},
    });
  }

  catName(id: number): string {
    return this.ctx.categoryById().get(id)?.name ?? `#${id}`;
  }

  openRegister(): void {
    this.person.set(null);
    this.newPerson.set(false);
    this.search.set('');
    this.results.set([]);
    this.regOpen.set(true);
  }

  onSearch(q: string): void {
    this.search.set(q);
    this.search$.next(q);
  }

  selectPersonById(id: number): void {
    this.api.get<Person>(`/persons/${id}`).subscribe({ next: (p) => this.selectPerson(p), error: () => {} });
  }

  selectPerson(p: Person): void {
    this.person.set(p);
    this.newPerson.set(false);
    this.weight = '';
    this.grade = null;
    this.suggestions.set([]);
    this.chosen.set(new Set());
    this.api.get<Suggestion[]>(`/tournaments/${this.ctx.id()}/suggestions`, { person_id: p.id }).subscribe({
      next: (s) => {
        this.suggestions.set(s);
        this.chosen.set(new Set(s.map((x) => x.category_id)));
      },
      error: () => {},
    });
  }

  toggleCat(id: number): void {
    const s = new Set(this.chosen());
    if (s.has(id)) s.delete(id);
    else s.add(id);
    this.chosen.set(s);
  }

  addOther(id: number): void {
    if (id) this.chosen.set(new Set([...this.chosen(), id]));
  }

  async register(): Promise<void> {
    const p = this.person();
    if (!p) return;
    this.busy.set(true);
    let ok = 0;
    for (const cid of this.chosen()) {
      const r = await this.mut.post<Registration>(`/tournaments/${this.ctx.id()}/registrations`, {
        person_id: p.id,
        category_id: cid,
        weight_class: this.weight || null,
        grade: this.grade,
      });
      if (r) ok++;
    }
    this.busy.set(false);
    if (ok) {
      this.toast.ok(`${ok} inscripción(es) creada(s)`);
      this.load();
      this.ctx.loadCategories();
      this.person.set(null);
      this.search.set('');
      this.results.set([]);
    }
  }

  async withdraw(r: Registration): Promise<void> {
    const reason = await this.dialog.prompt({
      title: 'Retirar inscripción',
      message: `${r.person_name} — ${this.catName(r.category_id)}`,
      label: 'Motivo del retiro',
      minLength: 3,
      confirmText: 'Retirar',
    });
    if (!reason) return;
    const res = await this.mut.post<WithdrawResult>(`/registrations/${r.id}/withdraw`, { reason }, { success: 'Inscripción retirada' });
    if (!res) return;
    this.load();
    this.ctx.loadCategories();
    if (res.options.length) {
      const opts = res.options.map((o) =>
        o === 'regenerate' ? 'Regenerar la llave (no hay combates iniciados)' : 'Dar walkover al rival en sus combates pendientes',
      );
      this.dialog.alert(
        'La categoría ya tiene llave',
        `Combates pendientes afectados: ${res.pending_match_ids.length}. El organizador decide:`,
        opts,
      );
    }
  }
}
