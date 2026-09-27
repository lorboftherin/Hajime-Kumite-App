import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { fmtDate, fmtDateTime, SEX_LABEL } from '../../core/format';
import { Category, Dojo, DojoRegistration, OpenTournament, Person } from '../../core/models';
import { MutationService } from '../../core/mutation.service';
import { PushService } from '../../core/push.service';
import { ToastService } from '../../core/toast.service';
import { StatusBadge } from '../../shared/badge';
import { Icon } from '../../shared/icon';
import { Modal } from '../../shared/modal';
import { PageHead } from '../../shared/page-head';
import { PersonForm } from '../../shared/person-form';
import { PushButton, PushHint } from '../../shared/push-button';

type Tab = 'competidores' | 'inscribir' | 'estado';

interface Pick {
  selected: boolean;
  category_id: number | null;
  weight_class: string;
  /** Categorías sugeridas para la persona en el torneo elegido (ids). */
  suggested: number[];
}

/**
 * Portal del sensei (rol «admin de dojo»): sus competidores, la inscripción en línea en
 * torneos abiertos y el estado de lo enviado. Documento y fecha de nacimiento solo los ven
 * el dojo y el organizador.
 */
@Component({
  selector: 'app-dojo-portal',
  imports: [FormsModule, PageHead, Icon, Modal, PersonForm, StatusBadge, PushButton, PushHint],
  template: `
    <div class="container">
      <app-page-head kanji="門" [title]="dojo()?.name ?? textoMisCompetidores">
        <div meta class="meta-line"
          ><span i18n="@@portal-dojo.mis-competidores-e-inscripcion"
            >Mis competidores e inscripción en línea</span
          ></div
        >
        @if (dojos().length > 1) {
          <select
            i18n-aria-label="@@portal-dojo.elegir-dojo"
            [ngModel]="dojoId()"
            (ngModelChange)="dojoId.set($event)"
            aria-label="Elegir dojo"
          >
            @for (d of dojos(); track d.id) {
              <option [ngValue]="d.id">{{ d.name }}</option>
            }
          </select>
        }
        @if (tab() === 'competidores' && dojoId(); as did) {
          <app-push-button
            [on]="pushDojos().has(did)"
            [busy]="pushBusy()"
            i18n-label="@@portal-dojo.todo-dojo"
            label="todo el dojo"
            (toggled)="togglePush({ dojo_id: did }, $event)"
          />
          <button
            i18n="@@portal-dojo.nuevo-competidor"
            class="btn primary"
            (click)="showNew.set(true)"
          >
            <app-icon name="plus" /> Nuevo competidor
          </button>
        }
      </app-page-head>

      @if (!dojos().length && !loading()) {
        <div class="card empty">
          <p
            ><strong i18n="@@portal-dojo.no-administras-ningun-dojo"
              >No administras ningún dojo.</strong
            ></p
          ><ng-container i18n="@@portal-dojo.abre-enlace-invitacion-te-envio">
            Abre el enlace de invitación que te envió el organizador del torneo para vincular tu
            cuenta a tu dojo.
          </ng-container></div
        >
      } @else {
        <div
          i18n-aria-label="@@portal-dojo.secciones"
          class="seg"
          role="tablist"
          aria-label="Secciones"
        >
          <button
            i18n="@@portal-dojo.competidores"
            role="tab"
            [class.on]="tab() === 'competidores'"
            [attr.aria-selected]="tab() === 'competidores'"
            (click)="tab.set('competidores')"
          >
            Competidores
          </button>
          <button
            i18n="@@portal-dojo.inscribir-torneo"
            role="tab"
            [class.on]="tab() === 'inscribir'"
            [attr.aria-selected]="tab() === 'inscribir'"
            (click)="tab.set('inscribir')"
          >
            Inscribir en torneo
          </button>
          <button
            i18n="@@portal-dojo.mis-inscripciones"
            role="tab"
            [class.on]="tab() === 'estado'"
            [attr.aria-selected]="tab() === 'estado'"
            (click)="tab.set('estado'); loadRegs()"
          >
            Mis inscripciones
          </button>
        </div>

        @switch (tab()) {
          @case ('competidores') {
            <app-push-hint [always]="false" />
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr>
                    <th i18n="@@portal-dojo.competidor">Competidor</th>
                    <th i18n="@@portal-dojo.sexo">Sexo</th>
                    <th i18n="@@portal-dojo.nacimiento">Nacimiento</th>
                    <th i18n="@@portal-dojo.documento">Documento</th>
                    <th i18n="@@portal-dojo.grado">Grado</th>
                    <th><span i18n="@@portal-dojo.acciones" class="sr-only">Acciones</span></th>
                  </tr>
                </thead>
                <tbody>
                  @for (p of people(); track p.id) {
                    <tr>
                      <td>
                        <strong>{{ p.last_names }}, {{ p.first_names }}</strong>
                      </td>
                      <td>{{ sexLabel(p.sex) }}</td>
                      <td class="nowrap">{{ p.birth_date ? date(p.birth_date) : '—' }}</td>
                      <td class="nowrap">
                        @for (d of p.documents; track d.id) {
                          {{ d.doc_type }} {{ d.number }}
                        } @empty {
                          <span class="muted">—</span>
                        }
                      </td>
                      <td>{{ p.current_grade ?? '—' }}</td>
                      <td class="right nowrap">
                        <app-push-button
                          [compact]="true"
                          [on]="pushPersons().has(p.id)"
                          [busy]="pushBusy()"
                          [label]="p.first_names + ' ' + p.last_names"
                          (toggled)="togglePush({ person_id: p.id }, $event)"
                        />
                        <button i18n="@@portal-dojo.editar" class="btn sm" (click)="openEdit(p)"
                          >Editar</button
                        >
                      </td>
                    </tr>
                  } @empty {
                    <tr>
                      <td colspan="6" class="empty">
                        <p
                          ><strong i18n="@@portal-dojo.dojo-aun-no-tiene-competidores"
                            >Tu dojo aún no tiene competidores.</strong
                          ></p
                        ><ng-container i18n="@@portal-dojo.agrega-primero-nuevo-competidor">
                          Agrega el primero con «Nuevo competidor».
                        </ng-container></td
                      >
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
          @case ('inscribir') {
            @if (!openTournaments().length) {
              <div i18n="@@portal-dojo.no-hay-torneos-inscripcion-linea" class="card empty"
                >No hay torneos con la inscripción en línea abierta.</div
              >
            } @else {
              <label class="field tsel">
                <span i18n="@@portal-dojo.torneo">Torneo</span>
                <select [ngModel]="tournamentId()" (ngModelChange)="selectTournament($event)">
                  <option i18n="@@portal-dojo.elige-torneo" [ngValue]="null"
                    >— Elige un torneo —</option
                  >
                  @for (t of openTournaments(); track t.id) {
                    <option [ngValue]="t.id">
                      {{ t.name }} · {{ date(t.start_date) }} · {{ t.organization_name }}
                    </option>
                  }
                </select>
              </label>
              @if (tournament(); as t) {
                <p class="small muted">
                  {{ t.venue }}
                  @if (t.venue && t.city) {
                    ,
                  }
                  {{ t.city }}
                  @if (t.self_registration_closes_at) {
                    <ng-container i18n="@@portal-dojo.cierra">
                      · Cierra el {{ dateTime(t.self_registration_closes_at) }}
                    </ng-container>
                  }
                  <ng-container i18n="@@portal-dojo.inscripciones-quedan-pendientes">
                    · Las inscripciones quedan pendientes hasta que el organizador las apruebe.
                  </ng-container></p
                >
                <div class="table-wrap">
                  <table class="table">
                    <thead>
                      <tr>
                        <th
                          ><span i18n="@@portal-dojo.inscribir" class="sr-only">Inscribir</span></th
                        >
                        <th i18n="@@portal-dojo.competidor">Competidor</th>
                        <th i18n="@@portal-dojo.categoria">Categoría</th>
                        <th i18n="@@portal-dojo.peso">Peso</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (p of people(); track p.id) {
                        @let pk = pick(p.id);
                        <tr>
                          <td>
                            <input
                              type="checkbox"
                              [(ngModel)]="pk.selected"
                              (ngModelChange)="onSelect(p.id)"
                              [attr.aria-label]="ariaInscribir(p.first_names + ' ' + p.last_names)"
                            />
                          </td>
                          <td>
                            {{ p.last_names }}, {{ p.first_names }}
                            <span class="muted small">{{ p.current_grade ?? '' }}</span>
                          </td>
                          <td>
                            <select
                              [(ngModel)]="pk.category_id"
                              (ngModelChange)="touch()"
                              [disabled]="!pk.selected"
                              [attr.aria-label]="ariaCategoria(p.first_names)"
                            >
                              <option i18n="@@portal-dojo.categoria-2" [ngValue]="null"
                                >— Categoría —</option
                              >
                              @if (pk.suggested.length) {
                                <optgroup i18n-label="@@portal-dojo.sugeridas" label="Sugeridas">
                                  @for (c of suggestedCats(pk); track c.id) {
                                    <option [ngValue]="c.id">{{ c.name }}</option>
                                  }
                                </optgroup>
                              }
                              <optgroup i18n-label="@@portal-dojo.todas" label="Todas">
                                @for (c of categories(); track c.id) {
                                  <option [ngValue]="c.id">{{ c.name }}</option>
                                }
                              </optgroup>
                            </select>
                          </td>
                          <td>
                            <input
                              class="weight"
                              [(ngModel)]="pk.weight_class"
                              [disabled]="!pk.selected"
                              placeholder="-45"
                              [attr.aria-label]="ariaPeso(p.first_names)"
                            />
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
                <div class="form-actions">
                  <button
                    i18n="@@portal-dojo.enviar"
                    class="btn primary"
                    (click)="submit()"
                    [disabled]="!ready().length || busy()"
                    >{ready().length, plural,
                      =1 {Enviar 1 inscripción}
                      other {Enviar {{ ready().length }} inscripciones}
                    }</button
                  >
                </div>
              }
            }
          }
          @case ('estado') {
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr>
                    <th i18n="@@portal-dojo.torneo">Torneo</th>
                    <th i18n="@@portal-dojo.competidor">Competidor</th>
                    <th i18n="@@portal-dojo.categoria">Categoría</th>
                    <th i18n="@@portal-dojo.estado">Estado</th>
                    <th><span i18n="@@portal-dojo.acciones" class="sr-only">Acciones</span></th>
                  </tr>
                </thead>
                <tbody>
                  @for (r of regs(); track r.id) {
                    <tr>
                      <td>{{ r.tournament_name }}</td>
                      <td>{{ r.person_name }}</td>
                      <td>{{ r.category_name }}</td>
                      <td>
                        <app-status [status]="r.status" type="registration" />
                        @if (r.rejection_reason) {
                          <div class="small muted">{{ r.rejection_reason }}</div>
                        }
                      </td>
                      <td class="right">
                        @if (r.status === 'pending') {
                          <button
                            i18n="@@portal-dojo.retirar"
                            class="btn sm ghost"
                            (click)="cancel(r)"
                            >Retirar</button
                          >
                        }
                      </td>
                    </tr>
                  } @empty {
                    <tr>
                      <td
                        i18n="@@portal-dojo.aun-no-hay-inscripciones-dojo"
                        colspan="5"
                        class="muted small"
                        >Aún no hay inscripciones de tu dojo.</td
                      >
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        }
      }
    </div>

    @if (showNew() && dojoId()) {
      <app-modal
        i18n-title="@@portal-dojo.nuevo-competidor-2"
        title="Nuevo competidor"
        [wide]="true"
        (closed)="showNew.set(false)"
      >
        <app-person-form
          [postPath]="'/dojo-portal/dojos/' + dojoId() + '/competitors'"
          [fixedDojoId]="dojoId()"
          [privateFields]="true"
          (created)="onCreated()"
        >
          <button
            i18n="@@portal-dojo.cancelar"
            type="button"
            class="btn"
            (click)="showNew.set(false)"
            >Cancelar</button
          >
        </app-person-form>
      </app-modal>
    }

    @if (edit(); as e) {
      <app-modal
        i18n-title="@@portal-dojo.editar-competidor"
        title="Editar competidor"
        (closed)="edit.set(null)"
      >
        <form class="stack" (ngSubmit)="saveEdit(e)">
          <div class="grid-2">
            <label class="field"
              ><span i18n="@@portal-dojo.nombres">Nombres *</span
              ><input name="fn" [(ngModel)]="e.first_names" required
            /></label>
            <label class="field"
              ><span i18n="@@portal-dojo.apellidos">Apellidos *</span
              ><input name="ln" [(ngModel)]="e.last_names" required
            /></label>
            <label class="field"
              ><span i18n="@@portal-dojo.fecha-nacimiento">Fecha de nacimiento</span
              ><input type="date" name="bd" [(ngModel)]="e.birth_date"
            /></label>
            <label class="field">
              <span i18n="@@portal-dojo.sexo">Sexo</span>
              <select name="sx" [(ngModel)]="e.sex">
                <option i18n="@@portal-dojo.masculino" value="M">Masculino</option>
                <option i18n="@@portal-dojo.femenino" value="F">Femenino</option>
              </select>
            </label>
            <label class="field">
              <span i18n="@@portal-dojo.documento">Documento</span>
              <div class="row nowrap">
                <select name="dt" [(ngModel)]="e.doc_type" style="width: 7rem">
                  <option i18n="@@portal-dojo.dni" value="DNI">DNI</option>
                  <option i18n="@@portal-dojo.ce" value="CE">CE</option>
                  <option i18n="@@portal-dojo.pasaporte" value="PASSPORT">Pasaporte</option>
                  <option i18n="@@portal-dojo.otro" value="OTHER">Otro</option>
                </select>
                <input class="grow" name="dn" [(ngModel)]="e.doc_number" />
              </div>
            </label>
          </div>
          <div class="form-actions">
            <button i18n="@@portal-dojo.cancelar" type="button" class="btn" (click)="edit.set(null)"
              >Cancelar</button
            >
            <button
              i18n="@@portal-dojo.guardar"
              class="btn primary"
              [disabled]="!e.first_names.trim() || !e.last_names.trim() || busy()"
            >
              Guardar
            </button>
          </div>
        </form>
      </app-modal>
    }
  `,
  styles: `
    .seg {
      display: inline-flex;
      gap: 2px;
      padding: 3px;
      margin-bottom: 1.25rem;
      border: 1px solid var(--kasumi);
      border-radius: var(--radius-sm);
      background: var(--washi);
      button {
        all: unset;
        padding: 0.45rem 0.9rem;
        border-radius: 6px;
        cursor: pointer;
        color: var(--nezumi-ink);
        font-weight: 500;
        &.on {
          background: var(--kinu-2);
          color: var(--sumi);
          box-shadow: 0 0 0 1px var(--kasumi);
        }
        &:focus-visible {
          outline: 2px solid var(--ai);
        }
      }
    }
    .tsel {
      max-width: 40rem;
    }
    .weight {
      width: 6rem;
    }
    @media (max-width: 767px) {
      .seg {
        display: flex;
        button {
          flex: 1;
          text-align: center;
          padding: 0.45rem 0.4rem;
        }
      }
    }
  `,
})
export class DojoPortalPage {
  readonly textoMisCompetidores = $localize`:@@portal-dojo.mis-competidores:Mis competidores`;
  ariaInscribir = (nombre: string) =>
    $localize`:@@portal-dojo.inscribir-a:Inscribir a ${nombre}:nombre:`;
  ariaCategoria = (nombre: string) =>
    $localize`:@@portal-dojo.categoria-de:Categoría de ${nombre}:nombre:`;
  ariaPeso = (nombre: string) => $localize`:@@portal-dojo.peso-de:Peso de ${nombre}:nombre:`;
  private api = inject(ApiService);
  private mut = inject(MutationService);

  readonly dojos = signal<Dojo[]>([]);
  readonly dojoId = signal<number | null>(null);
  readonly dojo = computed(() => this.dojos().find((d) => d.id === this.dojoId()) ?? null);
  readonly loading = signal(true);
  readonly tab = signal<Tab>('competidores');
  readonly people = signal<Person[]>([]);
  readonly openTournaments = signal<OpenTournament[]>([]);
  readonly tournamentId = signal<number | null>(null);
  readonly tournament = computed(
    () => this.openTournaments().find((t) => t.id === this.tournamentId()) ?? null,
  );
  readonly categories = signal<Category[]>([]);
  readonly picks = signal<Map<number, Pick>>(new Map());
  readonly regs = signal<DojoRegistration[]>([]);
  readonly busy = signal(false);
  readonly showNew = signal(false);
  readonly edit = signal<{
    id: number;
    version: number;
    first_names: string;
    last_names: string;
    birth_date: string;
    sex: string;
    doc_type: string;
    doc_number: string;
  } | null>(null);
  /** Filas marcadas y con categoría: lo que se enviará. */
  readonly ready = computed(() => {
    this.picks(); // dependencia
    return this.people()
      .map((p) => ({ p, pk: this.pick(p.id) }))
      .filter(({ pk }) => pk.selected && pk.category_id !== null);
  });

  private push = inject(PushService);
  private toast = inject(ToastService);
  /** Alumnos y dojos con aviso en este dispositivo («te toca», resultados, medallas). */
  readonly pushPersons = signal<Set<number>>(new Set());
  readonly pushDojos = signal<Set<number>>(new Set());
  readonly pushBusy = signal(false);

  private setPush(s: { person_ids: number[]; dojo_ids: number[] }): void {
    this.pushPersons.set(new Set(s.person_ids));
    this.pushDojos.set(new Set(s.dojo_ids));
  }

  async togglePush(target: { person_id?: number; dojo_id?: number }, on: boolean): Promise<void> {
    this.pushBusy.set(true);
    try {
      const s = await this.push.followAccount(target, on);
      if (!s) return;
      this.setPush(s);
      this.toast.ok(
        on
          ? target.dojo_id
            ? $localize`:@@portal-dojo.te-avisaremos-todos-competidores:Te avisaremos de todos los competidores del dojo`
            : $localize`:@@portal-dojo.te-avisaremos-combates:Te avisaremos de sus combates`
          : $localize`:@@portal-dojo.aviso-quitado:Aviso quitado`,
      );
    } catch {
      this.toast.error($localize`:@@portal-dojo.no-pudo-guardar-aviso:No se pudo guardar el aviso`);
    } finally {
      this.pushBusy.set(false);
    }
  }

  constructor() {
    effect(() => {
      if (!this.push.subscription()) return;
      untracked(() => void this.push.state().then((s) => this.setPush(s)));
    });
    this.api.get<Dojo[]>('/dojo-portal/dojos').subscribe({
      next: (d) => {
        this.dojos.set(d);
        if (d.length) this.dojoId.set(d[0].id);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
    this.api
      .get<OpenTournament[]>('/dojo-portal/tournaments')
      .subscribe({ next: (t) => this.openTournaments.set(t), error: () => {} });
    effect(() => {
      const id = this.dojoId();
      if (id) {
        void this.loadPeople(id);
        if (this.tab() === 'estado') void this.loadRegs();
      }
    });
  }

  sexLabel(s: string): string {
    return SEX_LABEL[s] ?? s;
  }
  date(v: string): string {
    return fmtDate(v);
  }
  dateTime(v: string): string {
    return fmtDateTime(v);
  }

  async loadPeople(dojoId: number): Promise<void> {
    this.people.set(
      await firstValueFrom(
        this.api.get<Person[]>(`/dojo-portal/dojos/${dojoId}/competitors`),
      ).catch(() => []),
    );
  }

  async loadRegs(): Promise<void> {
    const id = this.dojoId();
    if (!id) return;
    this.regs.set(
      await firstValueFrom(
        this.api.get<DojoRegistration[]>(`/dojo-portal/dojos/${id}/registrations`),
      ).catch(() => []),
    );
  }

  pick(personId: number): Pick {
    const m = this.picks();
    let pk = m.get(personId);
    if (!pk) {
      pk = { selected: false, category_id: null, weight_class: '', suggested: [] };
      m.set(personId, pk);
    }
    return pk;
  }

  /** Las filas se editan en su objeto: se avisa al contador de «Enviar». */
  touch(): void {
    this.picks.set(new Map(this.picks()));
  }

  suggestedCats(pk: Pick): Category[] {
    const set = new Set(pk.suggested);
    return this.categories().filter((c) => set.has(c.id));
  }

  async selectTournament(tid: number | null): Promise<void> {
    this.tournamentId.set(tid);
    this.picks.set(new Map());
    this.categories.set([]);
    const d = this.dojoId();
    if (!tid || !d) return;
    this.categories.set(
      await firstValueFrom(
        this.api.get<Category[]>(`/dojo-portal/dojos/${d}/tournaments/${tid}/categories`),
      ).catch(() => []),
    );
  }

  /** Al marcar a alguien se piden sus categorías sugeridas (mismas que ve el organizador). */
  async onSelect(personId: number): Promise<void> {
    const pk = this.pick(personId);
    this.picks.set(new Map(this.picks()));
    const d = this.dojoId();
    const t = this.tournamentId();
    if (!pk.selected || !d || !t || pk.suggested.length) return;
    const sug = await firstValueFrom(
      this.api.get<Array<{ category_id: number }>>(
        `/dojo-portal/dojos/${d}/tournaments/${t}/suggestions`,
        { person_id: personId },
      ),
    ).catch(() => []);
    pk.suggested = sug.map((x) => x.category_id);
    if (pk.category_id === null && pk.suggested.length === 1) pk.category_id = pk.suggested[0];
    this.picks.set(new Map(this.picks()));
  }

  async submit(): Promise<void> {
    const d = this.dojoId();
    const t = this.tournamentId();
    if (!d || !t) return;
    const items = this.ready().map(({ p, pk }) => ({
      person_id: p.id,
      category_id: pk.category_id,
      weight_class: pk.weight_class.trim() || null,
    }));
    this.busy.set(true);
    const out = await this.mut.post<DojoRegistration[]>(
      `/dojo-portal/dojos/${d}/tournaments/${t}/registrations`,
      { items },
      {
        success: $localize`:@@portal-dojo.inscripciones-enviadas-quedan:Inscripciones enviadas: quedan pendientes de aprobación`,
      },
    );
    this.busy.set(false);
    if (out) {
      this.picks.set(new Map());
      this.tab.set('estado');
      await this.loadRegs();
    }
  }

  async cancel(r: DojoRegistration): Promise<void> {
    const d = this.dojoId();
    if (!d) return;
    const out = await this.mut.post<DojoRegistration>(
      `/dojo-portal/dojos/${d}/registrations/${r.id}/cancel`,
      {},
      { success: $localize`:@@portal-dojo.solicitud-retirada:Solicitud retirada` },
    );
    if (out) await this.loadRegs();
  }

  async onCreated(): Promise<void> {
    this.showNew.set(false);
    const d = this.dojoId();
    if (d) await this.loadPeople(d);
  }

  openEdit(p: Person): void {
    const doc = p.documents[0];
    this.edit.set({
      id: p.id,
      version: p.version,
      first_names: p.first_names,
      last_names: p.last_names,
      birth_date: p.birth_date ?? '',
      sex: p.sex,
      doc_type: doc?.doc_type ?? 'DNI',
      doc_number: doc?.number ?? '',
    });
  }

  async saveEdit(e: NonNullable<ReturnType<typeof this.edit>>): Promise<void> {
    const d = this.dojoId();
    if (!d) return;
    const body: Record<string, unknown> = {
      version: e.version,
      first_names: e.first_names.trim(),
      last_names: e.last_names.trim(),
      birth_date: e.birth_date || null,
      sex: e.sex,
    };
    if (e.doc_number.trim())
      body['document'] = { doc_type: e.doc_type, number: e.doc_number.trim() };
    this.busy.set(true);
    const out = await this.mut.patch<Person>(`/dojo-portal/dojos/${d}/competitors/${e.id}`, body, {
      success: $localize`:@@portal-dojo.competidor-actualizado:Competidor actualizado`,
      onConflict: () => void this.loadPeople(d),
    });
    this.busy.set(false);
    if (out) {
      this.edit.set(null);
      await this.loadPeople(d);
    }
  }
}
