import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Subject, catchError, debounceTime, of, switchMap } from 'rxjs';
import { ApiService } from '../../../core/api.service';
import { Bracket, Person, RefereeAssignment, RefereeOverview } from '../../../core/models';
import { MutationService } from '../../../core/mutation.service';
import { Icon } from '../../../shared/icon';
import { TournamentContext } from '../tournament-context';
import { etiquetas } from '../../../core/i18n/etiquetas';

const TARGET_LABEL: Record<string, string> = etiquetas(() => ({
  tatami: 'Tatami',
  category: $localize`:@@torneo.arbitros.categoria-3:Categoría`,
  match: $localize`:@@torneo.arbitros.combate-3:Combate`,
}));

/**
 * Árbitros del torneo (sección 20): registro y asignación opcionales a un
 * tatami, una categoría o un combate. Nunca impiden operar; en kata, la mesa
 * propone a los asignados para registrar quién dio cada bandera o nota.
 */
@Component({
  selector: 'app-referees-tab',
  imports: [FormsModule, RouterLink, Icon],
  template: `
    <p i18n="@@torneo.arbitros.opcional-registrar-arbitros" class="hint intro">
      Opcional: registrar árbitros nunca impide operar el torneo. Un árbitro no necesita dojo. Si se
      asignan a un tatami, categoría o combate, la mesa de kata los propone para anotar quién dio
      cada bandera o nota.
    </p>
    <div class="cols">
      <section class="card">
        <h3 i18n="@@torneo.arbitros.arbitros-torneo"
          >Árbitros del torneo
          <span class="muted small">{{ data()?.referees?.length ?? 0 }}</span></h3
        >
        <ul class="list-plain refs">
          @for (r of data()?.referees ?? []; track r.person_id) {
            <li>
              <a [routerLink]="['/personas', r.person_id]">{{ r.name }}</a>
              <span
                i18n="@@torneo.arbitros.n-asignaciones"
                class="muted small"
                >{r.assignments, plural,
                  =0 {sin asignar}
                  =1 {1 asignación}
                  other {{{ r.assignments }} asignaciones}
                }</span
              >
            </li>
          } @empty {
            <li i18n="@@torneo.arbitros.todavia-no-hay-arbitros" class="muted small"
              >Todavía no hay árbitros registrados.</li
            >
          }
        </ul>
        <h4 i18n="@@torneo.arbitros.registrar-arbitro">Registrar árbitro</h4>
        <input
          i18n-aria-label="@@torneo.arbitros.buscar-persona"
          i18n-placeholder="@@torneo.arbitros.buscar-persona-nombre"
          placeholder="Buscar persona por nombre…"
          [ngModel]="q()"
          (ngModelChange)="onSearch($event)"
          aria-label="Buscar persona"
        />
        <ul class="list-plain results">
          @for (p of results(); track p.id) {
            <li>
              <span class="grow">{{ p.first_names }} {{ p.last_names }}</span>
              <button i18n="@@torneo.arbitros.registrar" class="btn sm" (click)="registerRef(p.id)"
                >Registrar</button
              >
            </li>
          }
        </ul>
        <details class="new">
          <summary i18n="@@torneo.arbitros.no-esta-lista-crear-persona"
            >No está en la lista: crear persona</summary
          >
          <div class="grid-3">
            <label class="field"
              ><span i18n="@@torneo.arbitros.nombres">Nombres</span
              ><input [(ngModel)]="np.first_names"
            /></label>
            <label class="field"
              ><span i18n="@@torneo.arbitros.apellidos">Apellidos</span
              ><input [(ngModel)]="np.last_names"
            /></label>
            <label class="field">
              <span i18n="@@torneo.arbitros.sexo">Sexo</span>
              <select [(ngModel)]="np.sex">
                <option i18n="@@torneo.arbitros.masculino" value="M">Masculino</option>
                <option i18n="@@torneo.arbitros.femenino" value="F">Femenino</option>
              </select>
            </label>
          </div>
          <div class="form-actions">
            <button
              i18n="@@torneo.arbitros.crear-registrar"
              class="btn primary sm"
              [disabled]="!np.first_names.trim() || !np.last_names.trim()"
              (click)="createAndRegister()"
            >
              Crear y registrar
            </button>
          </div>
        </details>
      </section>

      <section class="card">
        <h3 i18n="@@torneo.arbitros.asignaciones">Asignaciones</h3>
        <div class="table-wrap">
          <table class="table">
            <thead
              ><tr
                ><th i18n="@@torneo.arbitros.arbitro">Árbitro</th
                ><th i18n="@@torneo.arbitros.asignado">Asignado a</th
                ><th i18n="@@torneo.arbitros.puesto">Puesto</th><th></th></tr
            ></thead>
            <tbody>
              @for (a of data()?.assignments ?? []; track a.id) {
                <tr>
                  <td>{{ a.name }}</td>
                  <td>
                    @if (a.target_type !== 'tatami') {
                      <span class="muted small">{{ targetLabel[a.target_type] }}</span>
                    }
                    {{ a.target }}
                  </td>
                  <td>{{ a.position || '—' }}</td>
                  <td class="right"
                    ><button
                      i18n="@@torneo.arbitros.quitar"
                      class="btn sm ghost"
                      (click)="remove(a)"
                      >Quitar</button
                    ></td
                  >
                </tr>
              } @empty {
                <tr
                  ><td i18n="@@torneo.arbitros.sin-asignaciones" colspan="4" class="empty"
                    >Sin asignaciones.</td
                  ></tr
                >
              }
            </tbody>
          </table>
        </div>
        <h4 i18n="@@torneo.arbitros.nueva-asignacion">Nueva asignación</h4>
        <div class="grid-2">
          <label class="field">
            <span i18n="@@torneo.arbitros.arbitro">Árbitro</span>
            <select [(ngModel)]="form.person_id">
              <option i18n="@@torneo.arbitros.elegir" [ngValue]="null">— Elegir —</option>
              @for (r of data()?.referees ?? []; track r.person_id) {
                <option [ngValue]="r.person_id">{{ r.name }}</option>
              }
            </select>
          </label>
          <label class="field">
            <span i18n="@@torneo.arbitros.puesto-opcional">Puesto (opcional)</span>
            <input
              i18n-placeholder="@@torneo.arbitros.arbitro-central-juez-1"
              [(ngModel)]="form.position"
              list="positions"
              placeholder="Árbitro central, Juez 1…"
            />
            <datalist id="positions">
              @for (p of positions; track p) {
                <option [value]="p"></option>
              }
            </datalist>
          </label>
          <label class="field">
            <span i18n="@@torneo.arbitros.asignar">Asignar a</span>
            <select [ngModel]="targetType()" (ngModelChange)="setTargetType($event)">
              <option i18n="@@torneo.arbitros.tatami" value="tatami">Un tatami</option>
              <option i18n="@@torneo.arbitros.categoria" value="category">Una categoría</option>
              <option i18n="@@torneo.arbitros.combate" value="match">Un combate</option>
            </select>
          </label>
          @if (targetType() === 'tatami') {
            <label class="field">
              <span i18n="@@torneo.arbitros.tatami-2">Tatami</span>
              <select [(ngModel)]="form.target_id">
                <option i18n="@@torneo.arbitros.elegir" [ngValue]="null">— Elegir —</option>
                @for (t of ctx.tournament()?.tatamis ?? []; track t.id) {
                  <option [ngValue]="t.id">{{ t.name }}</option>
                }
              </select>
            </label>
          } @else {
            <label class="field">
              <span i18n="@@torneo.arbitros.categoria-2">Categoría</span>
              <select [ngModel]="catId()" (ngModelChange)="setCategory($event)">
                <option i18n="@@torneo.arbitros.elegir" [ngValue]="null">— Elegir —</option>
                @for (c of categories(); track c.id) {
                  <option [ngValue]="c.id">{{ c.name }}</option>
                }
              </select>
            </label>
            @if (targetType() === 'match') {
              <label class="field">
                <span i18n="@@torneo.arbitros.combate-2">Combate</span>
                <select [(ngModel)]="form.target_id" [disabled]="!matches().length">
                  <option i18n="@@torneo.arbitros.sin-llave-elegir" [ngValue]="null">
                    @if (catId() && !matches().length) {
                      La categoría no tiene llave
                    } @else {
                      — Elegir —
                    }
                  </option>
                  @for (m of matches(); track m.id) {
                    <option [ngValue]="m.id">{{ m.code }}</option>
                  }
                </select>
              </label>
            }
          }
        </div>
        <div class="form-actions">
          <button
            i18n="@@torneo.arbitros.asignar-2"
            class="btn primary"
            [disabled]="!canAssign()"
            (click)="assign()"
            ><app-icon name="plus" /> Asignar</button
          >
        </div>
      </section>
    </div>
  `,
  styles: `
    .intro {
      max-width: 52rem;
      margin: 0 0 1rem;
    }
    .cols {
      display: grid;
      grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
      gap: 1.25rem;
      align-items: start;
      .card {
        margin: 0;
      }
    }
    @media (max-width: 900px) {
      .cols {
        grid-template-columns: 1fr;
      }
    }
    h3 {
      margin: 0 0 0.75rem;
    }
    h4 {
      margin: 1.25rem 0 0.5rem;
      font-size: var(--fs-14);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--sumi-2);
    }
    .refs li,
    .results li {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
    }
    .results {
      max-height: 14rem;
      overflow-y: auto;
    }
    input {
      width: 100%;
    }
    .new {
      margin-top: 0.75rem;
      summary {
        cursor: pointer;
        color: var(--sumi-2);
        font-size: var(--fs-14);
      }
      .grid-3 {
        margin-top: 0.5rem;
      }
    }
  `,
})
export class RefereesTab {
  readonly ctx = inject(TournamentContext);
  private api = inject(ApiService);
  private mut = inject(MutationService);
  readonly targetLabel = TARGET_LABEL;
  readonly positions = [
    $localize`:@@torneo.arbitros.arbitro-central:Árbitro central`,
    $localize`:@@torneo.arbitros.juez-1:Juez 1`,
    $localize`:@@torneo.arbitros.juez-2:Juez 2`,
    $localize`:@@torneo.arbitros.juez-3:Juez 3`,
    $localize`:@@torneo.arbitros.juez-4:Juez 4`,
    'Kansa',
    $localize`:@@torneo.arbitros.juez-principal:Juez principal`,
  ];

  readonly data = signal<RefereeOverview | null>(null);
  readonly q = signal('');
  readonly results = signal<Person[]>([]);
  readonly targetType = signal<'tatami' | 'category' | 'match'>('tatami');
  readonly catId = signal<number | null>(null);
  readonly matches = signal<Array<{ id: number; code: string }>>([]);
  readonly categories = computed(() =>
    this.ctx.categories().filter((c) => !['merged', 'cancelled', 'empty'].includes(c.status)),
  );
  form = { person_id: null as number | null, target_id: null as number | null, position: '' };
  np = { first_names: '', last_names: '', sex: 'M' };
  private search$ = new Subject<string>();

  constructor() {
    this.load();
    this.search$
      .pipe(
        debounceTime(250),
        switchMap((q) =>
          q.trim().length < 2
            ? of([] as Person[])
            : this.api
                .get<Person[]>('/persons', { q, limit: 15 })
                .pipe(catchError(() => of([] as Person[]))),
        ),
      )
      .subscribe((r) => this.results.set(r));
  }

  load(): void {
    this.api
      .get<RefereeOverview>(`/tournaments/${this.ctx.id()}/referees`)
      .subscribe({ next: (d) => this.data.set(d), error: () => {} });
  }

  onSearch(q: string): void {
    this.q.set(q);
    this.search$.next(q);
  }

  async registerRef(personId: number): Promise<void> {
    const res = await this.mut.post<RefereeOverview>(
      `/tournaments/${this.ctx.id()}/referees`,
      { person_id: personId },
      { success: $localize`:@@torneo.arbitros.arbitro-registrado:Árbitro registrado` },
    );
    if (res) {
      this.data.set(res);
      this.q.set('');
      this.results.set([]);
    }
  }

  async createAndRegister(): Promise<void> {
    const p = await this.mut.post<Person>('/persons', {
      first_names: this.np.first_names.trim(),
      last_names: this.np.last_names.trim(),
      sex: this.np.sex,
    });
    if (!p) return;
    this.np = { first_names: '', last_names: '', sex: 'M' };
    await this.registerRef(p.id);
  }

  setTargetType(t: 'tatami' | 'category' | 'match'): void {
    this.targetType.set(t);
    this.form.target_id = null;
    if (t !== 'match') this.matches.set([]);
    else if (this.catId()) this.setCategory(this.catId());
  }

  setCategory(cid: number | null): void {
    this.catId.set(cid);
    if (this.targetType() === 'category') {
      this.form.target_id = cid;
      return;
    }
    this.form.target_id = null;
    this.matches.set([]);
    if (!cid) return;
    this.api.get<Bracket>(`/categories/${cid}/bracket`).subscribe({
      next: (b) =>
        this.matches.set(
          b.matches
            .filter((m) => m.status !== 'bye' && m.status !== 'void')
            .map((m) => ({ id: m.id, code: m.code })),
        ),
      error: () => this.matches.set([]),
    });
  }

  canAssign(): boolean {
    return !!this.form.person_id && !!this.form.target_id;
  }

  async assign(): Promise<void> {
    const res = await this.mut.post<RefereeOverview>(
      `/tournaments/${this.ctx.id()}/referee-assignments`,
      {
        person_id: this.form.person_id,
        target_type: this.targetType(),
        target_id: this.form.target_id,
        position: this.form.position,
      },
      { success: $localize`:@@torneo.arbitros.arbitro-asignado:Árbitro asignado` },
    );
    if (res) {
      this.data.set(res);
      this.form = {
        ...this.form,
        target_id: this.targetType() === 'category' ? this.form.target_id : null,
        position: '',
      };
    }
  }

  async remove(a: RefereeAssignment): Promise<void> {
    const res = await this.mut.run<RefereeOverview>(
      () => this.api.delete<RefereeOverview>(`/referee-assignments/${a.id}`),
      {
        success: $localize`:@@torneo.arbitros.asignacion-quitada:Asignación quitada`,
      },
    );
    if (res) this.data.set(res);
  }
}
