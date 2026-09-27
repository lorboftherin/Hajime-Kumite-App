import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subject, debounceTime } from 'rxjs';
import { ApiError } from '../../core/api-error';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { DialogService } from '../../core/dialog.service';
import { Dojo, Person } from '../../core/models';
import { MutationService } from '../../core/mutation.service';
import { Icon } from '../../shared/icon';
import { Modal } from '../../shared/modal';
import { MoreMenu } from '../../shared/more-menu';
import { PageHead } from '../../shared/page-head';
import { PersonForm } from '../../shared/person-form';
import { DatePipe } from '../../shared/pipes';

@Component({
  selector: 'app-person-list',
  imports: [FormsModule, RouterLink, Modal, PersonForm, DatePipe, PageHead, Icon, MoreMenu],
  template: `
    <div class="container">
      <app-page-head i18n-title="@@personas.personas" kanji="人" title="Personas">
        <div meta class="meta-line"
          ><span i18n="@@personas.competidores-entrenadores"
            >Competidores, entrenadores y oficiales</span
          ></div
        >
        @if (auth.isAdmin()) {
          <app-more
            i18n-label="@@personas.mas-acciones-personas"
            label="Más acciones de personas"
            [small]="false"
          >
            <button i18n="@@personas.revertir-fusion" class="menu-item" (click)="revert()"
              ><app-icon name="history" /> Revertir fusión…</button
            >
          </app-more>
        }
        <button i18n="@@personas.nueva-persona" class="btn primary" (click)="showNew.set(true)"
          ><app-icon name="plus" /> Nueva persona</button
        >
      </app-page-head>
      <div class="toolbar">
        <div class="search">
          <app-icon name="search" />
          <input
            i18n-aria-label="@@personas.buscar-persona"
            i18n-placeholder="@@personas.buscar-nombre-numero-documento"
            placeholder="Buscar por nombre o número de documento…"
            aria-label="Buscar persona"
            [ngModel]="q()"
            (ngModelChange)="onQ($event)"
          />
        </div>
        <select
          i18n-aria-label="@@personas.dojo"
          aria-label="Dojo"
          [ngModel]="dojo()"
          (ngModelChange)="dojo.set($event); load()"
        >
          <option i18n="@@personas.todos-dojos" [ngValue]="null">Todos los dojos</option>
          @for (d of dojos(); track d.id) {
            <option [ngValue]="d.id">{{ d.name }}</option>
          }
        </select>
        <span i18n="@@personas.resultados" class="count"
          >{{ persons().length }}{{ persons().length >= 100 ? '+' : '' }} resultados</span
        >
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th i18n="@@personas.apellidos-nombres">Apellidos y nombres</th>
              @if (auth.canViewDocuments()) {
                <th i18n="@@personas.nac">Nac.</th>
              }
              <th i18n="@@personas.sexo">Sexo</th>
              @if (auth.canViewDocuments()) {
                <th i18n="@@personas.documento">Documento</th>
              }
              <th i18n="@@personas.dojo-2">Dojo</th>
              <th i18n="@@personas.grado">Grado</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            @for (p of persons(); track p.id) {
              <tr>
                <td class="who"
                  ><a [routerLink]="['/personas', p.id]"
                    ><strong>{{ p.last_names }}</strong
                    >, {{ p.first_names }}</a
                  ></td
                >
                @if (auth.canViewDocuments()) {
                  <td class="nowrap">{{ p.birth_date | fdate }}</td>
                }
                <td>{{ p.sex }}</td>
                @if (auth.canViewDocuments()) {
                  <td class="small num">
                    @for (d of p.documents; track d.id) {
                      {{ d.doc_type }} {{ d.number }}
                    }
                  </td>
                }
                <td>{{ dojoName(p.current_dojo_id) }}</td>
                <td class="nowrap">{{ p.current_grade }}</td>
                <td>
                  @if (p.identity_incomplete) {
                    <span
                      i18n="@@personas.identidad-incompleta"
                      i18n-title="@@personas.faltan-datos-identidad"
                      class="badge yamabuki"
                      title="Faltan datos de identidad"
                      >Identidad incompleta</span
                    >
                  }
                  @if (p.anonymized_at) {
                    <span
                      i18n="@@personas.anonimizada"
                      i18n-title="@@personas.datos-personales-anonimizados"
                      class="badge nezumi"
                      title="Datos personales anonimizados"
                      >Anonimizada</span
                    >
                  }
                </td>
              </tr>
            } @empty {
              @if (forbidden()) {
                <tr
                  ><td colspan="7" class="empty"
                    ><p><strong i18n="@@personas.sin-acceso">Sin acceso.</strong></p
                    >{{ forbidden() }}</td
                  ></tr
                >
              } @else {
                <tr
                  ><td colspan="7" class="empty"
                    ><p><strong i18n="@@personas.sin-resultados">Sin resultados.</strong></p
                    ><ng-container i18n="@@personas.prueba-otro-nombre-crea-persona"
                      >Prueba con otro nombre o crea una persona nueva.</ng-container
                    ></td
                  ></tr
                >
              }
            }
          </tbody>
        </table>
      </div>
      <p i18n="@@personas.muestran-hasta-100-resultados" class="hint"
        >Se muestran hasta 100 resultados.</p
      >
    </div>

    @if (showNew()) {
      <app-modal
        i18n-title="@@personas.nueva-persona-2"
        title="Nueva persona"
        [wide]="true"
        (closed)="showNew.set(false)"
      >
        <app-person-form (created)="created($event)" (useExisting)="goTo($event)">
          <button i18n="@@personas.cancelar" type="button" class="btn" (click)="showNew.set(false)"
            >Cancelar</button
          >
        </app-person-form>
      </app-modal>
    }
  `,
  styles: `
    .who a {
      color: var(--sumi);
    }
    .who a:hover {
      color: var(--ai-ink);
    }
  `,
})
export class PersonListPage {
  private api = inject(ApiService);
  private router = inject(Router);
  private mut = inject(MutationService);
  private dialog = inject(DialogService);
  readonly auth = inject(AuthService);

  readonly persons = signal<Person[]>([]);
  /** Mensaje si la cuenta no puede listar personas (solo Admin y organizadores). */
  readonly forbidden = signal('');
  readonly dojos = signal<Dojo[]>([]);
  readonly q = signal('');
  readonly dojo = signal<number | null>(null);
  readonly showNew = signal(false);
  private dojoMap = computed(() => new Map(this.dojos().map((d) => [d.id, d.name])));
  private q$ = new Subject<void>();

  constructor() {
    // ?dojo=ID (desde la ficha del dojo) filtra por dojo.
    const dojoParam = Number(inject(ActivatedRoute).snapshot.queryParamMap.get('dojo'));
    if (dojoParam) this.dojo.set(dojoParam);
    this.api.get<Dojo[]>('/dojos').subscribe({ next: (d) => this.dojos.set(d), error: () => {} });
    this.q$.pipe(debounceTime(250)).subscribe(() => this.load());
    this.load();
  }

  onQ(v: string): void {
    this.q.set(v);
    this.q$.next();
  }

  load(): void {
    this.api
      .get<Person[]>('/persons', { q: this.q().trim() || null, dojo_id: this.dojo(), limit: 100 })
      .subscribe({
        next: (p) => {
          this.forbidden.set('');
          this.persons.set(p);
        },
        error: (e) => {
          const err = ApiError.from(e);
          if (err.status === 403) {
            this.persons.set([]);
            this.forbidden.set(
              $localize`:@@personas.solo-admin-organizadores-pueden:Solo el Admin y los organizadores pueden buscar personas.`,
            );
          }
        },
      });
  }

  dojoName(id: number | null): string {
    return id ? (this.dojoMap().get(id) ?? `#${id}`) : '';
  }

  created(p: Person): void {
    this.showNew.set(false);
    this.router.navigate(['/personas', p.id]);
  }

  goTo(id: number): void {
    this.showNew.set(false);
    this.router.navigate(['/personas', id]);
  }

  async revert(): Promise<void> {
    const id = await this.dialog.prompt({
      title: $localize`:@@personas.revertir-fusion-personas:Revertir fusión de personas`,
      message: $localize`:@@personas.ingresa-numero-fusion-muestra:Ingresa el número de la fusión (se muestra al fusionar y en Auditoría).`,
      label: $localize`:@@personas.n-fusion:N.º de fusión`,
      minLength: 1,
    });
    if (!id) return;
    const res = await this.mut.post(
      `/persons/merges/${Number(id)}/revert`,
      {},
      { success: $localize`:@@personas.fusion-revertida:Fusión revertida` },
    );
    if (res) this.load();
  }
}
