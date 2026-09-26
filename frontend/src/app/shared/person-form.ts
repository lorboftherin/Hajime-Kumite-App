import { Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { DialogService } from '../core/dialog.service';
import { GRADES, todayLima } from '../core/format';
import { Dojo, Duplicate, Person } from '../core/models';
import { MutationService } from '../core/mutation.service';

/**
 * Formulario de alta de persona (documento, dojo, grado, consentimiento).
 * Los posibles duplicados llegan como 409 WARNINGS y se aceptan con motivo;
 * un documento repetido (DUPLICATE_DOCUMENT) se bloquea y se ofrece usar la persona existente.
 */
@Component({
  selector: 'app-person-form',
  imports: [FormsModule],
  template: `
    <form (ngSubmit)="submit()" class="stack">
      <div class="grid-2">
        <label class="field"><span i18n="@@persona.form.nombres">Nombres *</span><input name="fn" [(ngModel)]="f.first_names" required /></label>
        <label class="field"><span i18n="@@persona.form.apellidos">Apellidos *</span><input name="ln" [(ngModel)]="f.last_names" required /></label>
        @if (showPrivate()) {
          <label class="field"><span i18n="@@persona.form.fecha-nacimiento">Fecha de nacimiento</span><input type="date" name="bd" [(ngModel)]="f.birth_date" /></label>
        }
        <label class="field">
          <span i18n="@@persona.form.sexo">Sexo *</span>
          <select name="sex" [(ngModel)]="f.sex">
            <option i18n="@@persona.form.masculino" value="M">Masculino</option>
            <option i18n="@@persona.form.femenino" value="F">Femenino</option>
          </select>
        </label>
        @if (showPrivate()) {
        <label class="field">
          <span i18n="@@persona.form.documento">Documento</span>
          <div class="row nowrap">
            <select name="dt" [(ngModel)]="f.doc_type" style="width: 7rem">
              <option i18n="@@persona.form.dni" value="DNI">DNI</option>
              <option i18n="@@persona.form.ce" value="CE">CE</option>
              <option i18n="@@persona.form.pasaporte" value="PASSPORT">Pasaporte</option>
              <option i18n="@@persona.form.otro" value="OTHER">Otro</option>
            </select>
            <input i18n-placeholder="@@persona.form.numero-opcional" class="grow" name="dn" [(ngModel)]="f.doc_number" placeholder="Número (opcional)" />
          </div>
        </label>
        }
        @if (fixedDojoId() === null) {
        <label class="field">
          <span i18n="@@persona.form.dojo">Dojo</span>
          <select name="dojo" [(ngModel)]="f.dojo_id" (ngModelChange)="f.branch_id = null; dojoSel.set($event)">
            <option i18n="@@persona.form.sin-dojo" [ngValue]="null">— Sin dojo —</option>
            @for (d of dojos(); track d.id) {
              <option [ngValue]="d.id">{{ d.name }}</option>
            }
          </select>
        </label>
        }
        @if (fixedDojoId() === null && branches().length) {
          <label class="field">
            <span i18n="@@persona.form.sede">Sede</span>
            <select name="branch" [(ngModel)]="f.branch_id">
              <option [ngValue]="null">—</option>
              @for (b of branches(); track b.id) {
                <option [ngValue]="b.id">{{ b.name }}</option>
              }
            </select>
          </label>
        }
        <label class="field">
          <span i18n="@@persona.form.grado">Grado</span>
          <select name="grade" [(ngModel)]="f.grade">
            <option [ngValue]="null">—</option>
            @for (g of grades; track g) {
              <option [value]="g">{{ g }}</option>
            }
          </select>
        </label>
      </div>
      <fieldset class="consent">
        <legend><label i18n="@@persona.form.registrar-consentimiento-datos" class="field inline"><input type="checkbox" name="hc" [(ngModel)]="f.has_consent" /> Registrar consentimiento de datos</label></legend>
        @if (f.has_consent) {
          <div class="grid-3">
            <label class="field"><span i18n="@@persona.form.otorgado">Otorgado por</span><input i18n-placeholder="@@persona.form.nombre-padre-madre-titular" name="gb" [(ngModel)]="f.consent_by" placeholder="Nombre del padre/madre o titular" /></label>
            <label class="field">
              <span i18n="@@persona.form.relacion">Relación</span>
              <select name="rel" [(ngModel)]="f.consent_rel">
                <option i18n="@@persona.form.titular" value="titular">Titular</option>
                <option i18n="@@persona.form.padre-madre" value="padre/madre">Padre / madre</option>
                <option i18n="@@persona.form.tutor" value="tutor">Tutor</option>
              </select>
            </label>
            <label class="field"><span i18n="@@persona.form.fecha">Fecha</span><input type="date" name="go" [(ngModel)]="f.consent_on" /></label>
          </div>
        }
      </fieldset>
      @if (docDuplicates().length) {
        <div class="alert danger"><ng-container i18n="@@persona.form.ya-existe-persona-ese-documento">
          Ya existe una persona con ese documento:
          </ng-container><ul>
            @for (d of docDuplicates(); track d.person_id) {
              <li>
                {{ d.full_name }} (#{{ d.person_id }})
                <button i18n="@@persona.form.usar-esta-persona" type="button" class="btn sm" (click)="useExisting.emit(d.person_id)">Usar esta persona</button>
              </li>
            }
          </ul>
        </div>
      }
      <div class="form-actions">
        <ng-content />
        <button i18n="@@persona.form.crear-persona" class="btn primary" [disabled]="!f.first_names.trim() || !f.last_names.trim() || busy()">Crear persona</button>
      </div>
    </form>
  `,
  styles: `
    .consent {
      border: 1px solid var(--kasumi);
      border-radius: var(--radius-sm);
      padding: 0.5rem 0.75rem;
      legend {
        padding: 0 0.25rem;
      }
    }
  `,
})
export class PersonForm implements OnInit {
  private api = inject(ApiService);
  readonly auth = inject(AuthService);
  private mut = inject(MutationService);
  private dialog = inject(DialogService);

  readonly initialName = input('');
  /** Ruta del alta (el portal del sensei usa la de su dojo). */
  readonly postPath = input('/persons');
  /** Dojo fijo (portal del sensei): no se muestra el selector. */
  readonly fixedDojoId = input<number | null>(null);
  /** Muestra fecha de nacimiento y documento aunque la cuenta no sea organizadora (el dojo sí los ve). */
  readonly privateFields = input(false);
  readonly showPrivate = computed(() => this.privateFields() || this.auth.canViewDocuments());
  readonly created = output<Person>();
  readonly useExisting = output<number>();

  readonly dojos = signal<Dojo[]>([]);
  readonly busy = signal(false);
  readonly docDuplicates = signal<Duplicate[]>([]);
  readonly grades = GRADES;
  readonly dojoSel = signal<number | null>(null);
  readonly branches = computed(() => this.dojos().find((d) => d.id === this.dojoSel())?.branches ?? []);

  f = {
    first_names: '',
    last_names: '',
    birth_date: '',
    sex: 'M',
    doc_type: 'DNI',
    doc_number: '',
    dojo_id: null as number | null,
    branch_id: null as number | null,
    grade: null as string | null,
    has_consent: true,
    consent_by: '',
    consent_rel: 'titular',
    consent_on: todayLima(),
  };

  constructor() {
    this.api.get<Dojo[]>('/dojos').subscribe({ next: (d) => this.dojos.set(d), error: () => {} });
  }

  ngOnInit(): void {
    const parts = this.initialName().trim().split(/\s+/).filter(Boolean);
    if (parts.length) {
      this.f.first_names = parts.slice(0, Math.max(1, parts.length - 2)).join(' ');
      this.f.last_names = parts.slice(Math.max(1, parts.length - 2)).join(' ');
    }
  }

  async submit(): Promise<void> {
    const f = this.f;
    this.docDuplicates.set([]);
    const body: Record<string, unknown> = {
      first_names: f.first_names.trim(),
      last_names: f.last_names.trim(),
      birth_date: f.birth_date || null,
      sex: f.sex,
      document: f.doc_number.trim() ? { doc_type: f.doc_type, number: f.doc_number.trim() } : null,
      dojo_id: this.fixedDojoId() ?? f.dojo_id,
      branch_id: this.fixedDojoId() === null ? f.branch_id : null,
      grade: f.grade,
      consent: f.has_consent
        ? {
            given_by: f.consent_by.trim() || `${f.first_names} ${f.last_names}`.trim(),
            relationship_to_person: f.consent_rel,
            given_on: f.consent_on || todayLima(),
          }
        : null,
    };
    this.busy.set(true);
    const p = await this.mut.post<Person>(this.postPath(), body, {
      success: $localize`:@@persona.form.persona-creada:Persona creada`,
      onError: (err) => {
        if (err.code === 'DUPLICATE_DOCUMENT') {
          this.docDuplicates.set((err.details['duplicates'] as Duplicate[]) ?? []);
          return true;
        }
        return false;
      },
    });
    this.busy.set(false);
    if (p) this.created.emit(p);
  }
}
