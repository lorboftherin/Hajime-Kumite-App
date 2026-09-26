import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Subject, debounceTime, switchMap, of, catchError } from 'rxjs';
import { ApiService } from '../../../core/api.service';
import { AuthService } from '../../../core/auth.service';
import { DialogService } from '../../../core/dialog.service';
import { GRADES, fmtDate } from '../../../core/format';
import { Dojo, Person, Registration, Suggestion, TeamMember, WithdrawResult } from '../../../core/models';
import { MutationService } from '../../../core/mutation.service';
import { ToastService } from '../../../core/toast.service';
import { StatusBadge } from '../../../shared/badge';
import { Icon } from '../../../shared/icon';
import { Modal } from '../../../shared/modal';
import { PersonForm } from '../../../shared/person-form';
import { TournamentContext } from '../tournament-context';

@Component({
  selector: 'app-registrations-tab',
  imports: [FormsModule, RouterLink, StatusBadge, Modal, PersonForm, Icon],
  template: `
    <div class="toolbar">
      <div class="search">
        <app-icon name="search" />
        <input placeholder="Filtrar por nombre, dojo o categoría…" aria-label="Filtrar inscripciones" [ngModel]="filter()" (ngModelChange)="filter.set($event)" />
      </div>
      <select aria-label="Categoría" [ngModel]="catFilter()" (ngModelChange)="catFilter.set($event)">
        <option [ngValue]="0">Todas las categorías</option>
        @for (c of ctx.categories(); track c.id) {
          @if (c.entrant_count > 0) {
            <option [ngValue]="c.id">{{ c.name }} ({{ c.entrant_count }})</option>
          }
        }
      </select>
      <label class="field inline small"><input type="checkbox" [ngModel]="showWithdrawn()" (ngModelChange)="showWithdrawn.set($event)" /> Mostrar retiradas</label>
      <span class="count">{{ filtered().length }} {{ filtered().length === 1 ? 'inscripción' : 'inscripciones' }}</span>
      @if (teamCategories().length) {
        <button class="btn" (click)="openTeam()" title="Inscribir un equipo en una categoría por equipos"><app-icon name="plus" /> Equipo</button>
      }
      <button class="btn primary" (click)="openRegister()"><app-icon name="plus" /> Inscribir</button>
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
            <th><span class="sr-only">Acciones</span></th>
          </tr>
        </thead>
        <tbody>
          @for (r of filtered(); track r.id) {
            <tr [class.struck]="r.status === 'withdrawn'">
              <td class="who">
                @if (r.seed) {
                  <span class="badge ai" [title]="'Cabeza de serie ' + r.seed">CS {{ r.seed }}</span>
                }
                @if (r.person_id) {
                  <a [routerLink]="['/personas', r.person_id]">{{ r.person_name }}</a>
                } @else {
                  <span class="team-name">{{ r.person_name }}</span> <span class="badge plain">equipo</span>
                  @if (r.team_members?.length) {
                    <div class="members small">
                      @for (m of r.team_members; track m.person_id; let last = $last) {
                        <a [routerLink]="['/personas', m.person_id]" [class.sub]="m.role === 'substitute'">{{ m.name }}</a>@if (m.role === 'substitute') {<span class="muted"> (sup.)</span>}@if (!last) {<span class="muted">, </span>}
                      }
                    </div>
                  }
                }
              </td>
              <td>{{ r.dojo_name }}</td>
              <td>
                {{ catName(r.category_id) }}
                @if (r.original_category_id !== r.category_id) {
                  <div class="muted small">orig.: {{ catName(r.original_category_id) }}</div>
                }
              </td>
              <td class="nowrap">{{ r.grade }}</td>
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
                  @if (r.team_id) {
                    <button class="btn sm ghost" (click)="openTeam(r)">Editar</button>
                  }
                  <button class="btn sm ghost" (click)="editSeed(r)" title="Cabeza de serie: recibe los byes y queda separada en la llave">Serie</button>
                  <button class="btn sm ghost" (click)="withdraw(r)">Retirar</button>
                }
              </td>
            </tr>
          } @empty {
            <tr><td colspan="8" class="empty"><p><strong>Sin inscripciones.</strong></p>Inscribe competidores o impórtalos desde Excel.</td></tr>
          }
        </tbody>
      </table>
    </div>

    @if (regOpen()) {
      <app-modal title="Inscribir competidor" [wide]="true" (closed)="regOpen.set(false)">
        @if (!person()) {
          @if (!newPerson()) {
            <div class="row">
              <input class="grow" placeholder="Buscar persona por nombre o documento…" [ngModel]="search()" (ngModelChange)="onSearch($event)" autofocus />
              <button class="btn" (click)="newPerson.set(true)"><app-icon name="plus" /> Nueva persona</button>
            </div>
            <ul class="list-plain results">
              @for (p of results(); track p.id) {
                <li>
                  <button class="linklike" (click)="selectPerson(p)">
                    <strong>{{ p.last_names }}, {{ p.first_names }}</strong>
                    <span class="muted small">
                      {{ p.sex }}
                      @if (auth.canViewDocuments()) { · {{ fdate(p.birth_date) || 'sin fecha de nac.' }} }
                      · {{ p.current_grade || 'sin grado' }}
                      @if (auth.canViewDocuments() && p.documents.length) { · {{ p.documents[0].doc_type }} {{ p.documents[0].number }} }
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
          <div class="alert info row chosen-person">
            <div class="grow">
              <strong>{{ p.first_names }} {{ p.last_names }}</strong>
              <span class="small"> · {{ p.sex }}@if (auth.canViewDocuments()) { · {{ fdate(p.birth_date) }} } · {{ p.current_grade || 'sin grado' }}</span>
            </div>
            <button class="btn sm" (click)="person.set(null)">Cambiar</button>
          </div>
          <h3>Categorías sugeridas</h3>
          @if (suggestions().length) {
            <div class="stack">
              @for (s of suggestions(); track s.category_id) {
                <label class="field inline"><input type="checkbox" [checked]="chosen().has(s.category_id)" (change)="toggleCat(s.category_id)" /> {{ s.name }} <span class="badge plain">{{ s.modality }}</span></label>
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
                <span class="badge ai">{{ catName(c) }} <button class="x" (click)="toggleCat(c)" [attr.aria-label]="'Quitar ' + catName(c)"><app-icon name="close" /></button></span>
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

    @if (teamOpen()) {
      <app-modal [title]="editingTeam() ? 'Editar equipo' : 'Inscribir equipo'" [wide]="true" (closed)="teamOpen.set(false)">
        <p class="hint">
          El equipo existe solo en este torneo. Titulares y suplentes pueden cambiar; la alineación de cada
          enfrentamiento se elige en la mesa.
        </p>
        <div class="grid-3">
          <label class="field">
            <span>Categoría por equipos *</span>
            <select [ngModel]="teamCat()" (ngModelChange)="teamCat.set($event)" [disabled]="!!editingTeam()">
              <option [ngValue]="0">— Elegir —</option>
              @for (c of teamCategories(); track c.id) {
                <option [ngValue]="c.id">{{ c.name }}</option>
              }
            </select>
          </label>
          <label class="field">
            <span>Dojo *</span>
            <select [ngModel]="teamDojo()" (ngModelChange)="onTeamDojo($event)">
              <option [ngValue]="0">— Elegir —</option>
              @for (d of dojos(); track d.id) {
                <option [ngValue]="d.id">{{ d.name }}</option>
              }
            </select>
          </label>
          <label class="field"><span>Nombre del equipo *</span><input [(ngModel)]="teamName" placeholder="Ej.: Kaze A" /></label>
        </div>

        <div class="team-cols mt">
          <div>
            <h3>Personas del dojo</h3>
            @if (!teamDojo()) {
              <p class="muted small">Elige el dojo para ver a sus competidores.</p>
            }
            <ul class="list-plain pick">
              @for (p of dojoPeople(); track p.id) {
                <li>
                  <label class="field inline">
                    <input type="checkbox" [checked]="isMember(p.id)" (change)="toggleMember(p)" />
                    {{ p.last_names }}, {{ p.first_names }}
                    <span class="muted small">{{ p.sex }} · {{ p.current_grade || 'sin grado' }}</span>
                  </label>
                </li>
              } @empty {
                @if (teamDojo()) {
                  <li class="muted small">El dojo no tiene personas registradas.</li>
                }
              }
            </ul>
            <input class="mt team-search" placeholder="Agregar a alguien de otro dojo…" [ngModel]="search()" (ngModelChange)="onSearch($event)" />
            <ul class="list-plain pick">
              @for (p of results(); track p.id) {
                @if (!isMember(p.id)) {
                  <li>
                    <button class="linklike" (click)="toggleMember(p)">
                      <strong>{{ p.last_names }}, {{ p.first_names }}</strong>
                      <span class="muted small">{{ p.sex }} · {{ p.current_grade || 'sin grado' }}</span>
                    </button>
                  </li>
                }
              }
            </ul>
          </div>
          <div>
            <h3>Integrantes ({{ members().length }})</h3>
            <ol class="list-plain members-edit">
              @for (m of members(); track m.person_id; let i = $index) {
                <li>
                  <span class="grow">{{ m.name }}</span>
                  <select [ngModel]="m.role" (ngModelChange)="setRole(i, $event)" [attr.aria-label]="'Rol de ' + m.name">
                    <option value="starter">Titular</option>
                    <option value="substitute">Suplente</option>
                  </select>
                  <button class="btn sm ghost" (click)="removeMember(i)" [attr.aria-label]="'Quitar a ' + m.name"><app-icon name="close" /></button>
                </li>
              } @empty {
                <li class="muted small">Marca a los integrantes en la lista de la izquierda.</li>
              }
            </ol>
          </div>
        </div>
        <div class="form-actions">
          <button class="btn" (click)="teamOpen.set(false)">Cancelar</button>
          <button class="btn primary" [disabled]="!teamCat() || !teamDojo() || !teamName.trim() || !members().length || busy()" (click)="saveTeam()">
            {{ editingTeam() ? 'Guardar cambios' : 'Inscribir equipo' }}
          </button>
        </div>
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
      box-sizing: border-box;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      width: 100%;
      padding: 0.15rem 0.5rem;
      border-radius: var(--radius-sm);
      &:hover {
        background: var(--hover);
      }
      &:hover strong {
        color: var(--ai-ink);
      }
      &:focus-visible {
        outline: 2px solid var(--ai);
      }
    }
    .who a {
      color: var(--sumi);
      font-weight: 700;
    }
    .who a:hover {
      color: var(--ai-ink);
    }
    .chosen-person {
      margin-bottom: 1.25rem;
    }
    .team-name {
      font-weight: 700;
    }
    .members {
      margin-top: 0.15rem;
      a {
        color: var(--sumi-2);
      }
      a:hover {
        color: var(--ai-ink);
      }
    }
    .team-cols {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1.5rem;
      h3 {
        margin: 0 0 0.5rem;
      }
      .team-search {
        width: 100%;
      }
    }
    .pick {
      max-height: 32vh;
      overflow-y: auto;
    }
    .members-edit li {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.25rem 0;
      border-bottom: 1px solid var(--kasumi);
    }
    @media (max-width: 720px) {
      .team-cols {
        grid-template-columns: 1fr;
      }
    }
    .x {
      display: inline-flex;
      border: 0;
      background: none;
      cursor: pointer;
      color: var(--nezumi-ink);
      padding: 0 0 0 0.2rem;
      font-size: 0.9rem;
    }
  `,
})
export class RegistrationsTab {
  readonly ctx = inject(TournamentContext);
  readonly auth = inject(AuthService);
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
    this.ctx.categories().filter((c) => !c.is_team && !['merged', 'cancelled', 'finished'].includes(c.status)),
  );
  readonly teamCategories = computed(() =>
    this.ctx.categories().filter((c) => c.is_team && !['merged', 'cancelled', 'finished'].includes(c.status)),
  );

  // Equipos
  readonly teamOpen = signal(false);
  readonly editingTeam = signal<Registration | null>(null);
  readonly teamCat = signal(0);
  readonly teamDojo = signal(0);
  readonly dojos = signal<Dojo[]>([]);
  readonly dojoPeople = signal<Person[]>([]);
  readonly members = signal<TeamMember[]>([]);
  teamName = '';
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

  openTeam(r?: Registration): void {
    if (!this.dojos().length) {
      this.api.get<Dojo[]>('/dojos').subscribe({ next: (d) => this.dojos.set(d), error: () => {} });
    }
    this.editingTeam.set(r ?? null);
    this.teamCat.set(r?.category_id ?? (this.teamCategories().length === 1 ? this.teamCategories()[0].id : 0));
    this.teamName = r?.person_name ?? '';
    this.members.set(r?.team_members ? [...r.team_members] : []);
    this.search.set('');
    this.results.set([]);
    this.dojoPeople.set([]);
    this.teamDojo.set(0);
    if (r) this.onTeamDojo(r.dojo_id, false);
    this.teamOpen.set(true);
  }

  onTeamDojo(id: number, suggestName = true): void {
    this.teamDojo.set(id);
    this.dojoPeople.set([]);
    if (!id) return;
    if (suggestName && !this.teamName.trim()) {
      const d = this.dojos().find((x) => x.id === id);
      if (d) this.teamName = `${d.short_name || d.name} A`;
    }
    this.api.get<Person[]>('/persons', { dojo_id: id, limit: 100 }).subscribe({
      next: (p) => this.dojoPeople.set(p),
      error: () => {},
    });
  }

  isMember(pid: number): boolean {
    return this.members().some((m) => m.person_id === pid);
  }

  toggleMember(p: Person): void {
    if (this.isMember(p.id)) {
      this.members.update((ms) => ms.filter((m) => m.person_id !== p.id));
    } else {
      this.members.update((ms) => [...ms, { person_id: p.id, name: `${p.first_names} ${p.last_names}`, role: 'starter' }]);
    }
  }

  setRole(i: number, role: 'starter' | 'substitute'): void {
    this.members.update((ms) => ms.map((m, j) => (j === i ? { ...m, role } : m)));
  }

  removeMember(i: number): void {
    this.members.update((ms) => ms.filter((_, j) => j !== i));
  }

  async saveTeam(): Promise<void> {
    const members = this.members().map((m) => ({ person_id: m.person_id, role: m.role }));
    const editing = this.editingTeam();
    this.busy.set(true);
    const res = editing
      ? await this.mut.patch<Registration>(
          `/teams/${editing.team_id}`,
          { version: editing.team_version, name: this.teamName.trim(), dojo_id: this.teamDojo(), members },
          { success: 'Equipo actualizado', onConflict: () => this.load() },
        )
      : await this.mut.post<Registration>(
          `/tournaments/${this.ctx.id()}/teams`,
          { category_id: this.teamCat(), dojo_id: this.teamDojo(), name: this.teamName.trim(), members },
          { success: 'Equipo inscrito' },
        );
    this.busy.set(false);
    if (!res) return;
    this.teamOpen.set(false);
    this.load();
    this.ctx.loadCategories();
  }

  /** Cabeza de serie (1 = primera): se usa al generar la llave. Vacío la quita. */
  async editSeed(r: Registration): Promise<void> {
    const value = await this.dialog.prompt({
      title: 'Cabeza de serie',
      message: `${r.person_name} — ${this.catName(r.category_id)}. 1 = primera cabeza de serie; escribe 0 para quitarla. Se aplica al generar (o regenerar) la llave.`,
      label: 'Número',
      minLength: 1,
      initial: r.seed ? String(r.seed) : '',
      confirmText: 'Guardar',
    });
    if (value === null) return;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) {
      this.dialog.alert('Número inválido', 'Usa un número entero (0 para quitar).');
      return;
    }
    const res = await this.mut.patch<Registration>(
      `/registrations/${r.id}`,
      { version: r.version, seed: n || null },
      { success: n ? `Cabeza de serie ${n}` : 'Cabeza de serie quitada', onConflict: () => this.load() },
    );
    if (res) this.load();
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
