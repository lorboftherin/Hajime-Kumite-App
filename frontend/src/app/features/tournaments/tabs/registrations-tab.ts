import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Subject, debounceTime, switchMap, of, catchError } from 'rxjs';
import { ApiService } from '../../../core/api.service';
import { AuthService } from '../../../core/auth.service';
import { DialogService } from '../../../core/dialog.service';
import { GRADES, fmtDate } from '../../../core/format';
import {
  Dojo,
  Person,
  Registration,
  Suggestion,
  TeamMember,
  WithdrawResult,
} from '../../../core/models';
import { MutationService } from '../../../core/mutation.service';
import { ToastService } from '../../../core/toast.service';
import { StatusBadge } from '../../../shared/badge';
import { Icon } from '../../../shared/icon';
import { Modal } from '../../../shared/modal';
import { PersonForm } from '../../../shared/person-form';
import { registrationSummary } from '../organizer-logic';
import { TournamentContext } from '../tournament-context';

/** Resultado del walkover masivo (POST /registrations/{rid}/walkover). */
interface WalkoverResult {
  registration_id: number;
  walkover_matches: string[];
  waiting_matches: string[];
}

@Component({
  selector: 'app-registrations-tab',
  imports: [FormsModule, RouterLink, StatusBadge, Modal, PersonForm, Icon],
  template: `
    <div class="toolbar">
      <div class="search">
        <app-icon name="search" />
        <input
          i18n-aria-label="@@torneo.inscripciones.filtrar-inscripciones"
          i18n-placeholder="@@torneo.inscripciones.filtrar-nombre-dojo-categoria"
          placeholder="Filtrar por nombre, dojo o categoría…"
          aria-label="Filtrar inscripciones"
          [ngModel]="filter()"
          (ngModelChange)="filter.set($event)"
        />
      </div>
      <select
        i18n-aria-label="@@torneo.inscripciones.categoria"
        aria-label="Categoría"
        [ngModel]="catFilter()"
        (ngModelChange)="catFilter.set($event)"
      >
        <option i18n="@@torneo.inscripciones.todas-categorias" [ngValue]="0"
          >Todas las categorías</option
        >
        @for (c of ctx.categories(); track c.id) {
          @if (c.entrant_count > 0) {
            <option [ngValue]="c.id">{{ c.name }} ({{ c.entrant_count }})</option>
          }
        }
      </select>
      <label i18n="@@torneo.inscripciones.mostrar-retiradas" class="field inline small"
        ><input
          type="checkbox"
          [ngModel]="showWithdrawn()"
          (ngModelChange)="showWithdrawn.set($event)"
        />
        Mostrar retiradas</label
      >
      <span i18n="@@torneo.inscripciones.n-inscripciones" class="count">{filtered().length, plural,
        =1 {1 inscripción}
        other {{{ filtered().length }} inscripciones}
      }</span>
      @if (teamCategories().length) {
        <button
          i18n="@@torneo.inscripciones.equipo"
          i18n-title="@@torneo.inscripciones.inscribir-equipo-categoria"
          class="btn"
          (click)="openTeam()"
          title="Inscribir un equipo en una categoría por equipos"
          ><app-icon name="plus" /> Equipo</button
        >
      }
      <button i18n="@@torneo.inscripciones.inscribir" class="btn primary" (click)="openRegister()"
        ><app-icon name="plus" /> Inscribir</button
      >
    </div>

    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th i18n="@@torneo.inscripciones.competidor">Competidor</th>
            <th i18n="@@torneo.inscripciones.dojo">Dojo</th>
            <th i18n="@@torneo.inscripciones.categoria-2">Categoría</th>
            <th i18n="@@torneo.inscripciones.grado">Grado</th>
            <th i18n="@@torneo.inscripciones.edad" class="center">Edad</th>
            <th i18n="@@torneo.inscripciones.peso">Peso</th>
            <th i18n="@@torneo.inscripciones.estado">Estado</th>
            <th><span i18n="@@torneo.inscripciones.acciones" class="sr-only">Acciones</span></th>
          </tr>
        </thead>
        <tbody>
          @for (r of filtered(); track r.id) {
            <tr [class.struck]="r.status === 'withdrawn'">
              <td class="who">
                @if (r.seed) {
                  <span
                    i18n="@@torneo.inscripciones.cs"
                    i18n-title="@@torneo.inscripciones.cabeza-serie-n"
                    class="badge ai"
                    title="Cabeza de serie {{ r.seed }}"
                    >CS {{ r.seed }}</span
                  >
                }
                @if (r.person_id) {
                  <a [routerLink]="['/personas', r.person_id]">{{ r.person_name }}</a>
                } @else {
                  <span class="team-name">{{ r.person_name }}</span>
                  <span i18n="@@torneo.inscripciones.equipo-2" class="badge plain">equipo</span>
                  @if (r.team_members?.length) {
                    <div class="members small">
                      @for (m of r.team_members; track m.person_id; let last = $last) {
                        <a
                          [routerLink]="['/personas', m.person_id]"
                          [class.sub]="m.role === 'substitute'"
                          >{{ m.name }}</a
                        >
                        @if (m.role === 'substitute') {
                          <span i18n="@@torneo.inscripciones.sup" class="muted"> (sup.)</span>
                        }
                        @if (!last) {
                          <span class="muted">, </span>
                        }
                      }
                    </div>
                  }
                }
              </td>
              <td>{{ r.dojo_name }}</td>
              <td>
                {{ catName(r.category_id) }}
                @if (r.original_category_id !== r.category_id) {
                  <div i18n="@@torneo.inscripciones.orig" class="muted small"
                    >orig.: {{ catName(r.original_category_id) }}</div
                  >
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
                    <button
                      i18n="@@torneo.inscripciones.editar"
                      class="btn sm ghost"
                      (click)="openTeam(r)"
                      >Editar</button
                    >
                  } @else {
                    <button
                      i18n="@@torneo.inscripciones.editar"
                      class="btn sm ghost"
                      (click)="openEdit(r)"
                      >Editar</button
                    >
                  }
                  <button
                    i18n="@@torneo.inscripciones.retirar"
                    class="btn sm ghost"
                    (click)="withdraw(r)"
                    >Retirar</button
                  >
                } @else if (r.status === 'withdrawn' && hasBracket(r.category_id)) {
                  <button
                    i18n="@@torneo.inscripciones.resolver-llave"
                    i18n-title="@@torneo.inscripciones.regenerar-llave-dar-walkover"
                    class="btn sm ghost"
                    (click)="afterWithdraw(r)"
                    title="Regenerar la llave o dar walkover en sus combates pendientes"
                    >Resolver llave</button
                  >
                }
              </td>
            </tr>
          } @empty {
            <tr
              ><td colspan="8" class="empty"
                ><p
                  ><strong i18n="@@torneo.inscripciones.sin-inscripciones"
                    >Sin inscripciones.</strong
                  ></p
                ><ng-container i18n="@@torneo.inscripciones.inscribe-competidores-importalos"
                  >Inscribe competidores o impórtalos desde Excel.</ng-container
                ></td
              ></tr
            >
          }
        </tbody>
      </table>
    </div>

    @if (regOpen()) {
      <app-modal
        i18n-title="@@torneo.inscripciones.inscribir-competidor"
        title="Inscribir competidor"
        [wide]="true"
        (closed)="regOpen.set(false)"
      >
        @if (!person()) {
          @if (!newPerson()) {
            <div class="row">
              <input
                i18n-placeholder="@@torneo.inscripciones.buscar-persona-nombre-documento"
                class="grow"
                placeholder="Buscar persona por nombre o documento…"
                [ngModel]="search()"
                (ngModelChange)="onSearch($event)"
                autofocus
              />
              <button
                i18n="@@torneo.inscripciones.nueva-persona"
                class="btn"
                (click)="newPerson.set(true)"
                ><app-icon name="plus" /> Nueva persona</button
              >
            </div>
            <ul class="list-plain results">
              @for (p of results(); track p.id) {
                <li>
                  <button class="linklike" (click)="selectPerson(p)">
                    <strong>{{ p.last_names }}, {{ p.first_names }}</strong>
                    <span class="muted small">
                      {{ p.sex }}
                      @if (auth.canViewDocuments()) {
                        · {{ fdate(p.birth_date) || txtSinFechaNac }}
                      }
                      · {{ p.current_grade || txtSinGrado }}
                      @if (auth.canViewDocuments() && p.documents.length) {
                        · {{ p.documents[0].doc_type }} {{ p.documents[0].number }}
                      }
                    </span>
                  </button>
                </li>
              } @empty {
                @if (search().length >= 2 && !searching()) {
                  <li i18n="@@torneo.inscripciones.sin-resultados-puedes-crear" class="muted"
                    >Sin resultados. Puedes crear una persona nueva.</li
                  >
                }
              }
            </ul>
          } @else {
            <h3 i18n="@@torneo.inscripciones.nueva-persona-2">Nueva persona</h3>
            <app-person-form
              [initialName]="search()"
              (created)="selectPerson($event)"
              (useExisting)="selectPersonById($event)"
            >
              <button
                i18n="@@torneo.inscripciones.volver-buscar"
                type="button"
                class="btn"
                (click)="newPerson.set(false)"
                >Volver a buscar</button
              >
            </app-person-form>
          }
        } @else {
          @let p = person()!;
          <div class="alert info row chosen-person">
            <div class="grow">
              <strong>{{ p.first_names }} {{ p.last_names }}</strong>
              <span class="small">
                · {{ p.sex }}
                @if (auth.canViewDocuments()) {
                  · {{ fdate(p.birth_date) }}
                }
                · {{ p.current_grade || txtSinGrado }}</span
              >
            </div>
            <button i18n="@@torneo.inscripciones.cambiar" class="btn sm" (click)="person.set(null)"
              >Cambiar</button
            >
          </div>
          <h3 i18n="@@torneo.inscripciones.categorias-sugeridas">Categorías sugeridas</h3>
          @if (suggestions().length) {
            <div class="stack">
              @for (s of suggestions(); track s.category_id) {
                <label class="field inline"
                  ><input
                    type="checkbox"
                    [checked]="chosen().has(s.category_id)"
                    (change)="toggleCat(s.category_id)"
                  />
                  {{ s.name }} <span class="badge plain">{{ s.modality }}</span></label
                >
              }
            </div>
          } @else {
            <p i18n="@@torneo.inscripciones.no-hay-categorias-sugeridas-edad" class="muted small"
              >No hay categorías sugeridas por edad/sexo/grado. Puedes elegir otra (se pedirá
              confirmación).</p
            >
          }
          <div class="grid-2 mt">
            <label class="field">
              <span i18n="@@torneo.inscripciones.otra-categoria-manual"
                >Otra categoría (manual)</span
              >
              <select [ngModel]="0" (ngModelChange)="addOther($event)">
                <option i18n="@@torneo.inscripciones.agregar-otra-categoria" [ngValue]="0"
                  >— Agregar otra categoría —</option
                >
                @for (c of openCategories(); track c.id) {
                  <option [ngValue]="c.id">{{ c.name }}</option>
                }
              </select>
            </label>
            <label class="field"
              ><span i18n="@@torneo.inscripciones.categoria-peso-declarada"
                >Categoría de peso declarada</span
              ><input
                i18n-placeholder="@@torneo.inscripciones.ej-60"
                [(ngModel)]="weight"
                placeholder="Ej.: -60"
            /></label>
            <label class="field">
              <span i18n="@@torneo.inscripciones.grado-si-difiere-vigente"
                >Grado (si difiere del vigente)</span
              >
              <select [(ngModel)]="grade">
                <option i18n="@@torneo.inscripciones.vigente" [ngValue]="null">Vigente</option>
                @for (g of grades; track g) {
                  <option [value]="g">{{ g }}</option>
                }
              </select>
            </label>
          </div>
          @if (extraChosen().length) {
            <div class="small mt"
              ><ng-container i18n="@@torneo.inscripciones.manuales"> Manuales: </ng-container>
              @for (c of extraChosen(); track c) {
                <span class="badge ai"
                  >{{ catName(c) }}
                  <button
                    class="x"
                    (click)="toggleCat(c)"
                    [attr.aria-label]="ariaQuitar(catName(c))"
                    ><app-icon name="close" /></button
                ></span>
              }
            </div>
          }
          <div class="form-actions">
            <button i18n="@@torneo.inscripciones.cerrar" class="btn" (click)="regOpen.set(false)"
              >Cerrar</button
            >
            <button
              i18n="@@torneo.inscripciones.inscribir-2"
              class="btn primary"
              [disabled]="!chosen().size || busy()"
              (click)="register()"
              >{chosen().size, plural,
                =1 {Inscribir en 1 categoría}
                other {Inscribir en {{ chosen().size }} categorías}
              }</button
            >
          </div>
        }
      </app-modal>
    }

    @if (editReg(); as r) {
      <app-modal
        i18n-title="@@torneo.inscripciones.editar-inscripcion-de"
        title="Editar inscripción · {{ r.person_name }}"
        (closed)="editReg.set(null)"
      >
        <p i18n="@@torneo.inscripciones.cambiar-categoria-con-llave" class="hint"
          >Si la categoría ya tiene llave, la persona sale de esa llave y pasa a la de destino (si
          hay un lugar libre). Ese cambio, y las advertencias de edad, grado o peso, piden un
          motivo.</p
        >
        <form (ngSubmit)="saveEdit(r)">
          <div class="grid-2">
            <label class="field" style="grid-column: 1 / -1">
              <span i18n="@@torneo.inscripciones.categoria-2">Categoría</span>
              <select name="cat" [(ngModel)]="edit.category_id">
                @for (c of editCategories(r); track c.id) {
                  <option [ngValue]="c.id">{{ c.name }}</option>
                }
              </select>
            </label>
            <label class="field"
              ><span i18n="@@torneo.inscripciones.categoria-peso-declarada"
                >Categoría de peso declarada</span
              ><input
                i18n-placeholder="@@torneo.inscripciones.ej-60"
                name="w"
                [(ngModel)]="edit.weight_class"
                placeholder="Ej.: -60"
            /></label>
            <label class="field">
              <span i18n="@@torneo.inscripciones.grado">Grado</span>
              <select name="g" [(ngModel)]="edit.grade">
                <option i18n="@@torneo.inscripciones.sin-grado" [ngValue]="null">Sin grado</option>
                @for (g of grades; track g) {
                  <option [value]="g">{{ g }}</option>
                }
              </select>
            </label>
            <label class="field">
              <span i18n="@@torneo.inscripciones.cabeza-serie">Cabeza de serie</span>
              <input
                i18n-placeholder="@@torneo.inscripciones.sin-sembrar"
                name="seed"
                type="number"
                min="1"
                [(ngModel)]="edit.seed"
                placeholder="Sin sembrar"
              />
              <span i18n="@@torneo.inscripciones.1-primer-cabeza-serie-separan" class="hint"
                >1 = primer cabeza de serie; se separan en la llave.</span
              >
            </label>
          </div>
          <div class="form-actions">
            <button
              i18n="@@torneo.inscripciones.cancelar"
              type="button"
              class="btn"
              (click)="editReg.set(null)"
              >Cancelar</button
            >
            <button
              i18n="@@torneo.inscripciones.guardar-cambios"
              class="btn primary"
              [disabled]="busy()"
              >Guardar cambios</button
            >
          </div>
        </form>
      </app-modal>
    }

    @if (teamOpen()) {
      <app-modal
        [title]="editingTeam() ? txtEditarEquipo : txtInscribirEquipo"
        [wide]="true"
        (closed)="teamOpen.set(false)"
      >
        <p i18n="@@torneo.inscripciones.equipo-existe-solo-este-torneo" class="hint">
          El equipo existe solo en este torneo. Titulares y suplentes pueden cambiar; la alineación
          de cada enfrentamiento se elige en la mesa.
        </p>
        <div class="grid-3">
          <label class="field">
            <span i18n="@@torneo.inscripciones.categoria-equipos">Categoría por equipos *</span>
            <select
              [ngModel]="teamCat()"
              (ngModelChange)="teamCat.set($event)"
              [disabled]="!!editingTeam()"
            >
              <option i18n="@@torneo.inscripciones.elegir" [ngValue]="0">— Elegir —</option>
              @for (c of teamCategories(); track c.id) {
                <option [ngValue]="c.id">{{ c.name }}</option>
              }
            </select>
          </label>
          <label class="field">
            <span i18n="@@torneo.inscripciones.dojo-2">Dojo *</span>
            <select [ngModel]="teamDojo()" (ngModelChange)="onTeamDojo($event)">
              <option i18n="@@torneo.inscripciones.elegir" [ngValue]="0">— Elegir —</option>
              @for (d of dojos(); track d.id) {
                <option [ngValue]="d.id">{{ d.name }}</option>
              }
            </select>
          </label>
          <label class="field"
            ><span i18n="@@torneo.inscripciones.nombre-equipo">Nombre del equipo *</span
            ><input
              i18n-placeholder="@@torneo.inscripciones.ej-kaze"
              [(ngModel)]="teamName"
              placeholder="Ej.: Kaze A"
          /></label>
        </div>

        <div class="team-cols mt">
          <div>
            <h3 i18n="@@torneo.inscripciones.personas-dojo">Personas del dojo</h3>
            @if (!teamDojo()) {
              <p i18n="@@torneo.inscripciones.elige-dojo-para-ver-competidores" class="muted small"
                >Elige el dojo para ver a sus competidores.</p
              >
            }
            <ul class="list-plain pick">
              @for (p of dojoPeople(); track p.id) {
                <li>
                  <label class="field inline">
                    <input type="checkbox" [checked]="isMember(p.id)" (change)="toggleMember(p)" />
                    {{ p.last_names }}, {{ p.first_names }}
                    <span class="muted small"
                      >{{ p.sex }} · {{ p.current_grade || txtSinGrado }}</span
                    >
                  </label>
                </li>
              } @empty {
                @if (teamDojo()) {
                  <li i18n="@@torneo.inscripciones.dojo-no-tiene-personas" class="muted small"
                    >El dojo no tiene personas registradas.</li
                  >
                }
              }
            </ul>
            <input
              i18n-placeholder="@@torneo.inscripciones.agregar-alguien-otro-dojo"
              class="mt team-search"
              placeholder="Agregar a alguien de otro dojo…"
              [ngModel]="search()"
              (ngModelChange)="onSearch($event)"
            />
            <ul class="list-plain pick">
              @for (p of results(); track p.id) {
                @if (!isMember(p.id)) {
                  <li>
                    <button class="linklike" (click)="toggleMember(p)">
                      <strong>{{ p.last_names }}, {{ p.first_names }}</strong>
                      <span class="muted small"
                        >{{ p.sex }} · {{ p.current_grade || txtSinGrado }}</span
                      >
                    </button>
                  </li>
                }
              }
            </ul>
          </div>
          <div>
            <h3 i18n="@@torneo.inscripciones.integrantes">Integrantes ({{ members().length }})</h3>
            <ol class="list-plain members-edit">
              @for (m of members(); track m.person_id; let i = $index) {
                <li>
                  <span class="grow">{{ m.name }}</span>
                  <select
                    [ngModel]="m.role"
                    (ngModelChange)="setRole(i, $event)"
                    [attr.aria-label]="ariaRolDe(m.name)"
                  >
                    <option i18n="@@torneo.inscripciones.titular" value="starter">Titular</option>
                    <option i18n="@@torneo.inscripciones.suplente" value="substitute"
                      >Suplente</option
                    >
                  </select>
                  <button
                    class="btn sm ghost"
                    (click)="removeMember(i)"
                    [attr.aria-label]="ariaQuitarA(m.name)"
                    ><app-icon name="close"
                  /></button>
                </li>
              } @empty {
                <li i18n="@@torneo.inscripciones.marca-integrantes-lista" class="muted small"
                  >Marca a los integrantes en la lista de la izquierda.</li
                >
              }
            </ol>
          </div>
        </div>
        <div class="form-actions">
          <button i18n="@@torneo.inscripciones.cancelar" class="btn" (click)="teamOpen.set(false)"
            >Cancelar</button
          >
          <button
            class="btn primary"
            [disabled]="
              !teamCat() || !teamDojo() || !teamName.trim() || !members().length || busy()
            "
            (click)="saveTeam()"
          >
            <ng-container i18n="@@torneo.inscripciones.guardar-inscribir-equipo">
              @if (editingTeam()) {
                Guardar cambios
              } @else {
                Inscribir equipo
              }
            </ng-container>
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
  readonly txtSinFechaNac = $localize`:@@torneo.inscripciones.sin-fecha-nac:sin fecha de nac.`;
  readonly txtSinGrado = $localize`:@@torneo.inscripciones.sin-grado-texto:sin grado`;
  readonly txtEditarEquipo = $localize`:@@torneo.inscripciones.editar-equipo:Editar equipo`;
  readonly txtInscribirEquipo = $localize`:@@torneo.inscripciones.inscribir-equipo:Inscribir equipo`;
  ariaQuitar = (nombre: string) =>
    $localize`:@@torneo.inscripciones.quitar-nombre:Quitar ${nombre}:nombre:`;
  ariaQuitarA = (nombre: string) =>
    $localize`:@@torneo.inscripciones.quitar-a:Quitar a ${nombre}:nombre:`;
  ariaRolDe = (nombre: string) =>
    $localize`:@@torneo.inscripciones.rol-de:Rol de ${nombre}:nombre:`;
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
    this.ctx
      .categories()
      .filter((c) => !c.is_team && !['merged', 'cancelled', 'finished'].includes(c.status)),
  );
  readonly teamCategories = computed(() =>
    this.ctx
      .categories()
      .filter((c) => c.is_team && !['merged', 'cancelled', 'finished'].includes(c.status)),
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
          return this.api
            .get<Person[]>('/persons', { q, limit: 20 })
            .pipe(catchError(() => of([] as Person[])));
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
    this.api
      .get<Person>(`/persons/${id}`)
      .subscribe({ next: (p) => this.selectPerson(p), error: () => {} });
  }

  selectPerson(p: Person): void {
    this.person.set(p);
    this.newPerson.set(false);
    this.weight = '';
    this.grade = null;
    this.suggestions.set([]);
    this.chosen.set(new Set());
    this.api
      .get<Suggestion[]>(`/tournaments/${this.ctx.id()}/suggestions`, { person_id: p.id })
      .subscribe({
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
    const ok: string[] = [];
    const failed: Array<{ name: string; reason: string }> = [];
    for (const cid of this.chosen()) {
      const name = this.catName(cid);
      let reason = 'cancelado';
      // Un error por categoría no interrumpe las demás: se junta todo en un solo resumen al final.
      const r = await this.mut.post<Registration>(
        `/tournaments/${this.ctx.id()}/registrations`,
        {
          person_id: p.id,
          category_id: cid,
          weight_class: this.weight || null,
          grade: this.grade,
        },
        {
          onError: (err) => {
            reason = err.fullMessage;
            return true;
          },
        },
      );
      if (r) ok.push(name);
      else failed.push({ name, reason });
    }
    this.busy.set(false);
    const text = registrationSummary(ok, failed);
    if (failed.length) this.toast.error(text);
    else if (ok.length) this.toast.ok(text);
    if (ok.length) {
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
    this.teamCat.set(
      r?.category_id ?? (this.teamCategories().length === 1 ? this.teamCategories()[0].id : 0),
    );
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
      this.members.update((ms) => [
        ...ms,
        { person_id: p.id, name: `${p.first_names} ${p.last_names}`, role: 'starter' },
      ]);
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
          {
            version: editing.team_version,
            name: this.teamName.trim(),
            dojo_id: this.teamDojo(),
            members,
          },
          {
            success: $localize`:@@torneo.inscripciones.equipo-actualizado:Equipo actualizado`,
            onConflict: () => this.load(),
          },
        )
      : await this.mut.post<Registration>(
          `/tournaments/${this.ctx.id()}/teams`,
          {
            category_id: this.teamCat(),
            dojo_id: this.teamDojo(),
            name: this.teamName.trim(),
            members,
          },
          { success: $localize`:@@torneo.inscripciones.equipo-inscrito:Equipo inscrito` },
        );
    this.busy.set(false);
    if (!res) return;
    this.teamOpen.set(false);
    this.load();
    this.ctx.loadCategories();
  }

  // --- Editar inscripción ---
  readonly editReg = signal<Registration | null>(null);
  edit = {
    category_id: 0,
    weight_class: '',
    grade: null as string | null,
    seed: null as number | null,
  };

  hasBracket(cid: number): boolean {
    const c = this.ctx.categoryById().get(cid);
    return !!c && ['ready', 'in_progress'].includes(c.status);
  }

  /** Categorías a las que puede pasar: misma modalidad de equipo, abiertas o con llave sin
   * terminar (el servidor advierte y, con confirmación, lo saca de una llave y lo pone en la otra),
   * más la actual. */
  editCategories(r: Registration) {
    const cur = this.ctx.categoryById().get(r.category_id);
    return this.ctx
      .categories()
      .filter(
        (c) =>
          c.id === r.category_id ||
          (c.is_team === !!cur?.is_team &&
            ['open', 'empty', 'ready', 'in_progress'].includes(c.status)),
      );
  }

  openEdit(r: Registration): void {
    this.edit = {
      category_id: r.category_id,
      weight_class: r.weight_class ?? '',
      grade: r.grade,
      seed: r.seed,
    };
    this.editReg.set(r);
  }

  async saveEdit(r: Registration): Promise<void> {
    const body: Record<string, unknown> = { version: r.version };
    if (this.edit.category_id !== r.category_id) body['category_id'] = this.edit.category_id;
    if ((this.edit.weight_class || null) !== r.weight_class)
      body['weight_class'] = this.edit.weight_class || null;
    if (this.edit.grade !== r.grade) body['grade'] = this.edit.grade;
    const seed = this.edit.seed ? Number(this.edit.seed) : null;
    if (seed !== r.seed) body['seed'] = seed;
    if (Object.keys(body).length === 1) {
      this.editReg.set(null);
      return;
    }
    this.busy.set(true);
    const res = await this.mut.patch<Registration>(`/registrations/${r.id}`, body, {
      success: $localize`:@@torneo.inscripciones.inscripcion-actualizada:Inscripción actualizada`,
      onConflict: () => this.load(),
    });
    this.busy.set(false);
    if (!res) return;
    this.editReg.set(null);
    this.load();
    this.ctx.loadCategories();
  }

  async withdraw(r: Registration): Promise<void> {
    const reason = await this.dialog.prompt({
      title: $localize`:@@torneo.inscripciones.retirar-inscripcion:Retirar inscripción`,
      message: `${r.person_name} — ${this.catName(r.category_id)}`,
      label: $localize`:@@torneo.inscripciones.motivo-retiro:Motivo del retiro`,
      minLength: 3,
      confirmText: $localize`:@@torneo.inscripciones.retirar-2:Retirar`,
    });
    if (!reason) return;
    const res = await this.mut.post<WithdrawResult>(
      `/registrations/${r.id}/withdraw`,
      { reason },
      { success: $localize`:@@torneo.inscripciones.inscripcion-retirada:Inscripción retirada` },
    );
    if (!res) return;
    this.load();
    this.ctx.loadCategories();
    if (res.options.length) await this.resolveBracket(r, res.options, res.pending_match_ids.length);
  }

  /** Retirada con llave ya generada: regenerar la llave o dar walkover (lo que permita el servidor). */
  async afterWithdraw(r: Registration): Promise<void> {
    const c = this.ctx.categoryById().get(r.category_id);
    const options = c?.status === 'ready' ? ['regenerate', 'walkover'] : ['walkover'];
    await this.resolveBracket(r, options, null);
  }

  private async resolveBracket(
    r: Registration,
    options: string[],
    pending: number | null,
  ): Promise<void> {
    const cat = this.catName(r.category_id);
    const choice = await this.dialog.choose({
      title: $localize`:@@torneo.inscripciones.categoria-ya-tiene-llave:La categoría ya tiene llave`,
      message:
        pending === null
          ? $localize`:@@torneo.inscripciones.esta-retirado-hacemos-llave:${r.person_name}:person_name: está retirado de ${cat}:cat:. ¿Qué hacemos con la llave?`
          : pending === 1
            ? $localize`:@@torneo.inscripciones.deja-1-combate:${r.person_name}:nombre: deja 1 combate pendiente en ${cat}:categoria:. ¿Qué hacemos con la llave?`
            : $localize`:@@torneo.inscripciones.deja-combates:${r.person_name}:nombre: deja ${pending}:n: combates pendientes en ${cat}:categoria:. ¿Qué hacemos con la llave?`,
      choices: [
        ...(options.includes('regenerate')
          ? [
              {
                value: 'regenerate',
                label: $localize`:@@torneo.inscripciones.regenerar-llave:Regenerar la llave`,
                hint: $localize`:@@torneo.inscripciones.nuevo-sorteo-sin-esta:Nuevo sorteo sin esta inscripción. Solo si aún no empezó ningún combate.`,
                primary: true,
              },
            ]
          : []),
        {
          value: 'walkover',
          label: $localize`:@@torneo.inscripciones.dar-walkover-combates-pendientes:Dar walkover en sus combates pendientes`,
          hint: $localize`:@@torneo.inscripciones.rival-gana-cada-combate:Su rival gana cada combate pendiente por walkover; la llave sigue igual.`,
          primary: !options.includes('regenerate'),
        },
      ],
      cancelText: $localize`:@@torneo.inscripciones.decidir-despues:Decidir después`,
    });
    if (choice === 'regenerate') {
      const res = await this.mut.post(
        `/categories/${r.category_id}/bracket`,
        {
          reason: $localize`:@@torneo.inscripciones.retiro:Retiro de ${r.person_name}:person_name:`,
        },
        {
          success: $localize`:@@torneo.inscripciones.llave-regenerada-sin-inscripcion:Llave regenerada sin la inscripción retirada`,
        },
      );
      if (res) this.ctx.loadCategories();
    } else if (choice === 'walkover') {
      const res = await this.mut.post<WalkoverResult>(`/registrations/${r.id}/walkover`, {
        reason: r.withdrawn_reason ? `Retiro: ${r.withdrawn_reason}` : null,
      });
      if (!res) return;
      const done = res.walkover_matches.length;
      const waiting = res.waiting_matches.length;
      const text = done
        ? done === 1
          ? $localize`:@@torneo.inscripciones.walkover-1-combate:Walkover registrado en 1 combate (${res.walkover_matches.join(', ')}:combates:)`
          : $localize`:@@torneo.inscripciones.walkover-combates:Walkover registrado en ${done}:n: combates (${res.walkover_matches.join(', ')}:combates:)`
        : $localize`:@@torneo.inscripciones.no-habia-combates-listos-para:No había combates listos para dar walkover`;
      this.toast.ok(
        waiting
          ? waiting === 1
            ? $localize`:@@torneo.inscripciones.1-combate-espera:${text}:texto:. 1 combate espera rival: vuelve a «Resolver llave» cuando se defina.`
            : $localize`:@@torneo.inscripciones.combates-esperan-rival:${text}:texto:. ${waiting}:n: combates esperan rival: vuelve a «Resolver llave» cuando se defina.`
          : text,
      );
      this.ctx.loadCategories();
    }
  }
}
