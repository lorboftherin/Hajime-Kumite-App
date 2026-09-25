import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiError } from '../../core/api-error';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { DialogService } from '../../core/dialog.service';
import { GRADES, fmtDate, todayLima } from '../../core/format';
import { ConsentIn, Dojo, Duplicate, Person, RoleIn, RoleOut, Tournament } from '../../core/models';
import { MutationService } from '../../core/mutation.service';
import { Icon } from '../../shared/icon';
import { InkTabs } from '../../shared/ink-tabs';
import { Modal } from '../../shared/modal';
import { MoreMenu } from '../../shared/more-menu';
import { PageHead } from '../../shared/page-head';
import { DatePipe } from '../../shared/pipes';
import { PersonHistoryView } from './person-history';

interface MergeResult {
  id: number;
  kept_person_id: number;
  merged_person_id: number;
  moved: Record<string, unknown>;
}

@Component({
  selector: 'app-person-detail',
  imports: [FormsModule, RouterLink, Modal, DatePipe, PersonHistoryView, PageHead, Icon, MoreMenu, InkTabs],
  template: `
    <div class="container">
      @if (person(); as p) {
        <app-page-head kanji="人" [title]="p.first_names + ' ' + p.last_names">
          <a back class="back-link" routerLink="/personas"><app-icon name="back" /> Personas</a>
          <div meta class="meta-line">
            <span class="num">#{{ p.id }}</span>
            @if (p.current_grade) {
              <span>{{ p.current_grade }}</span>
            }
            @if (p.current_dojo_id) {
              <span>{{ dojoName(p.current_dojo_id) }}</span>
            }
            @if (p.identity_incomplete) {
              <span class="badge yamabuki">Identidad incompleta</span>
            }
            @if (p.merged_into_id) {
              <span class="badge nezumi">Fusionada en <a [routerLink]="['/personas', p.merged_into_id]">#{{ p.merged_into_id }}</a></span>
            }
            @if (p.anonymized_at) {
              <span class="badge nezumi" title="Datos personales anonimizados">Anonimizada</span>
            }
          </div>
          <button class="btn" (click)="gradeOpen.set(true)"><app-icon name="plus" /> Registrar grado</button>
          <app-more text="Más" label="Más acciones de la persona" [small]="false">
            <button class="menu-item" (click)="openDojo()">Cambiar dojo</button>
            <button class="menu-item" (click)="openConsent()">Agregar consentimiento</button>
            @if (auth.isAdmin()) {
              <hr />
              <button class="menu-item" (click)="openMerge()">Fusionar duplicado…</button>
              @if (!p.anonymized_at) {
                <button class="menu-item danger" (click)="anonymize()">Anonimizar datos…</button>
              }
            }
          </app-more>
        </app-page-head>

        @if (mergeResult(); as mr) {
          <div class="alert ok row">
            <span class="grow">Fusión #{{ mr.id }} realizada: la persona #{{ mr.merged_person_id }} se unió a esta ficha.</span>
            <button class="btn sm" (click)="revert(mr.id)">Revertir fusión</button>
          </div>
        }

        <nav class="tabs" inkTabs aria-label="Secciones de la persona">
          <a [routerLink]="[]" [queryParams]="{ tab: null }" [class.active]="tab() !== 'historial'">Ficha</a>
          <a [routerLink]="[]" [queryParams]="{ tab: 'historial' }" [class.active]="tab() === 'historial'">Historial deportivo</a>
        </nav>

        @if (tab() === 'historial') {
          <app-person-history [personId]="p.id" />
        } @else {
        <div class="ficha">
          <div class="card">
            <h3>Datos personales</h3>
            <form (ngSubmit)="save()" class="stack">
              <div class="grid-2">
                <label class="field"><span>Nombres</span><input name="fn" [(ngModel)]="edit.first_names" /></label>
                <label class="field"><span>Apellidos</span><input name="ln" [(ngModel)]="edit.last_names" /></label>
                @if (canViewDocs()) {
                  <label class="field"><span>Nacimiento</span><input type="date" name="bd" [(ngModel)]="edit.birth_date" /></label>
                }
                <label class="field">
                  <span>Sexo</span>
                  <select name="sx" [(ngModel)]="edit.sex">
                    <option value="M">Masculino</option>
                    <option value="F">Femenino</option>
                  </select>
                </label>
                @if (canViewDocs()) {
                  <label class="field">
                    <span>Tipo de documento</span>
                    <select name="dt" [(ngModel)]="edit.doc_type">
                      <option value="DNI">DNI</option>
                      <option value="CE">CE</option>
                      <option value="PASSPORT">Pasaporte</option>
                      <option value="OTHER">Otro</option>
                    </select>
                  </label>
                  <label class="field"><span>Número</span><input name="dn" [(ngModel)]="edit.doc_number" /></label>
                }
              </div>
              @if (!canViewDocs()) {
                <p class="hint">Fecha de nacimiento y documentos solo visibles para Admin y organizadores.</p>
              }
              <div class="form-actions"><button class="btn primary">Guardar cambios</button></div>
            </form>
          </div>
          <div class="card">
            <h3>Situación deportiva</h3>
            <dl class="dl">
              <dt>Dojo vigente</dt>
              <dd>
                @if (p.current_dojo_id) {
                  <a [routerLink]="['/dojos', p.current_dojo_id]">{{ dojoName(p.current_dojo_id) }}</a>
                } @else {
                  —
                }
              </dd>
              <dt>Grado vigente</dt>
              <dd>{{ p.current_grade || '—' }}</dd>
              @if (canViewDocs()) {
                <dt>Documentos</dt>
                <dd>
                  @for (d of p.documents; track d.id) {
                    <div class="mono">{{ d.doc_type }} {{ d.number }}</div>
                  } @empty {
                    —
                  }
                </dd>
                <dt>Nacimiento</dt>
                <dd>{{ p.birth_date | fdate }}</dd>
              }
            </dl>
          </div>
          <div class="card">
            <h3>Consentimientos de datos</h3>
            <div class="scroll-x">
            <table class="table small flush">
              <thead><tr><th>Fecha</th><th>Otorgado por</th><th>Relación</th><th>Medio</th><th>Alcance</th></tr></thead>
              <tbody>
                @for (c of p.consents ?? []; track c.id) {
                  <tr>
                    <td class="nowrap">{{ fdate(c.given_on) }}</td>
                    <td>{{ c.given_by }}</td>
                    <td>{{ c.relationship_to_person }}</td>
                    <td>{{ c.medium }}</td>
                    <td>{{ c.scope }}</td>
                  </tr>
                } @empty {
                  <tr><td colspan="5" class="muted">Sin consentimiento registrado.</td></tr>
                }
              </tbody>
            </table>
            </div>
            <div class="form-actions"><button class="btn sm" (click)="openConsent()"><app-icon name="plus" /> Agregar consentimiento</button></div>
          </div>
          @if (auth.isAdmin()) {
            <div class="card">
              <h3>Roles (permisos)</h3>
              <table class="table small flush">
                <thead><tr><th>Rol</th><th>Ámbito</th><th></th></tr></thead>
                <tbody>
                  @for (r of roles(); track r.id) {
                    <tr>
                      <td>{{ roleLabel[r.role] || r.role }}</td>
                      <td>{{ scopeText(r) }}</td>
                      <td class="right"><button class="btn sm ghost" (click)="removeRole(r)">Quitar</button></td>
                    </tr>
                  } @empty {
                    <tr><td colspan="3" class="muted">Sin roles: solo puede ver.</td></tr>
                  }
                </tbody>
              </table>
              <form class="row mt" (ngSubmit)="addRole()">
                <select name="role" [(ngModel)]="newRole.role">
                  @for (r of roleKeys; track r) {
                    <option [value]="r">{{ roleLabel[r] }}</option>
                  }
                </select>
                <select name="scope" [(ngModel)]="newRole.scope_type" (ngModelChange)="newRole.scope_id = null; onScopeType($event)">
                  <option value="global">Global</option>
                  <option value="tournament">Por torneo</option>
                  <option value="dojo">Por dojo</option>
                  @if (newRole.role === 'table_operator') {
                    <option value="tatami">Por tatami</option>
                  }
                </select>
                @if (newRole.scope_type === 'tatami') {
                  <select name="sid" [(ngModel)]="newRole.scope_id" aria-label="Tatami">
                    <option [ngValue]="null">— Tatami —</option>
                    @for (t of tournaments(); track t.id) {
                      <optgroup [label]="t.name">
                        @for (tt of t.tatamis; track tt.id) {
                          <option [ngValue]="tt.id">{{ tt.name }}</option>
                        }
                      </optgroup>
                    }
                  </select>
                } @else if (newRole.scope_type === 'tournament') {
                  <select name="sid" [(ngModel)]="newRole.scope_id">
                    <option [ngValue]="null">— Torneo —</option>
                    @for (t of tournaments(); track t.id) {
                      <option [ngValue]="t.id">{{ t.name }}</option>
                    }
                  </select>
                } @else if (newRole.scope_type === 'dojo') {
                  <select name="sid" [(ngModel)]="newRole.scope_id">
                    <option [ngValue]="null">— Dojo —</option>
                    @for (d of dojos(); track d.id) {
                      <option [ngValue]="d.id">{{ d.name }}</option>
                    }
                  </select>
                }
                <button class="btn sm primary" [disabled]="newRole.scope_type !== 'global' && !newRole.scope_id">Agregar rol</button>
              </form>
            </div>
          }
        </div>
        }
      } @else if (error()) {
        <div class="alert danger">{{ error() }}</div>
      } @else {
        <div class="empty"><span class="spinner"></span></div>
      }
    </div>

    @if (gradeOpen()) {
      <app-modal title="Registrar grado" (closed)="gradeOpen.set(false)">
        <div class="grid-2">
          <label class="field">
            <span>Grado</span>
            <select [(ngModel)]="grade.grade">
              @for (g of grades; track g) {
                <option [value]="g">{{ g }}</option>
              }
            </select>
          </label>
          <label class="field"><span>Fecha de obtención</span><input type="date" [(ngModel)]="grade.awarded_on" /></label>
        </div>
        <div class="form-actions">
          <button class="btn" (click)="gradeOpen.set(false)">Cancelar</button>
          <button class="btn primary" (click)="addGrade()">Registrar</button>
        </div>
      </app-modal>
    }

    @if (consentOpen()) {
      <app-modal title="Agregar consentimiento de datos" (closed)="consentOpen.set(false)">
        <div class="grid-2">
          <label class="field"><span>Otorgado por</span><input [(ngModel)]="consent.given_by" placeholder="Nombre del padre/madre o titular" /></label>
          <label class="field">
            <span>Relación</span>
            <select [(ngModel)]="consent.relationship_to_person">
              <option value="titular">Titular</option>
              <option value="padre/madre">Padre / madre</option>
              <option value="tutor">Tutor</option>
            </select>
          </label>
          <label class="field"><span>Fecha</span><input type="date" [(ngModel)]="consent.given_on" /></label>
          <label class="field"><span>Medio</span><input [(ngModel)]="consent.medium" placeholder="declaración del dojo, formulario firmado…" /></label>
          <label class="field"><span>Alcance</span><input [(ngModel)]="consent.scope" placeholder="competencia" /></label>
        </div>
        <div class="form-actions">
          <button class="btn" (click)="consentOpen.set(false)">Cancelar</button>
          <button class="btn primary" [disabled]="!consent.given_by.trim() || !consent.given_on" (click)="addConsent()">Registrar</button>
        </div>
      </app-modal>
    }

    @if (dojoOpen()) {
      <app-modal title="Cambiar de dojo" (closed)="dojoOpen.set(false)">
        <div class="grid-2">
          <label class="field">
            <span>Dojo</span>
            <select [(ngModel)]="membership.dojo_id" (ngModelChange)="membership.branch_id = null">
              @for (d of dojos(); track d.id) {
                <option [ngValue]="d.id">{{ d.name }}</option>
              }
            </select>
          </label>
          <label class="field">
            <span>Sede</span>
            <select [(ngModel)]="membership.branch_id">
              <option [ngValue]="null">—</option>
              @for (b of branchesOf(membership.dojo_id); track b.id) {
                <option [ngValue]="b.id">{{ b.name }}</option>
              }
            </select>
          </label>
          <label class="field"><span>Desde</span><input type="date" [(ngModel)]="membership.start_date" /></label>
        </div>
        <p class="hint">El historial se conserva: las inscripciones anteriores mantienen el dojo de ese momento.</p>
        <div class="form-actions">
          <button class="btn" (click)="dojoOpen.set(false)">Cancelar</button>
          <button class="btn primary" [disabled]="!membership.dojo_id" (click)="changeDojo()">Guardar</button>
        </div>
      </app-modal>
    }

    @if (mergeOpen()) {
      <app-modal title="Fusionar persona duplicada" [wide]="true" (closed)="mergeOpen.set(false)">
        <p class="small muted">
          Se conserva esta ficha (#{{ person()?.id }}); la otra se marca como fusionada y sus inscripciones, grados y documentos pasan a esta. Se puede revertir.
        </p>
        <div class="row">
          <input class="grow" placeholder="Buscar otra persona…" [(ngModel)]="mergeQ" (keyup.enter)="searchMerge()" />
          <button class="btn" (click)="searchMerge()">Buscar</button>
        </div>
        @if (dupSuggestions().length) {
          <div class="small mt"><strong>Posibles duplicados detectados:</strong></div>
        }
        <ul class="list-plain">
          @for (d of dupSuggestions(); track d.person_id) {
            <li class="row">
              <label class="field inline grow"><input type="radio" name="m" [checked]="mergeId() === d.person_id" (change)="mergeId.set(d.person_id)" /> {{ d.full_name }} (#{{ d.person_id }}) · {{ d.reason }} · {{ fdate(d.birth_date) }}</label>
            </li>
          }
          @for (c of mergeCandidates(); track c.id) {
            <li class="row">
              <label class="field inline grow"><input type="radio" name="m" [checked]="mergeId() === c.id" (change)="mergeId.set(c.id)" /> {{ c.first_names }} {{ c.last_names }} (#{{ c.id }}) · {{ fdate(c.birth_date) }} · {{ c.current_grade }}</label>
            </li>
          }
        </ul>
        <label class="field mt"><span>Motivo</span><input [(ngModel)]="mergeReason" /></label>
        <div class="form-actions">
          <button class="btn" (click)="mergeOpen.set(false)">Cancelar</button>
          <button class="btn danger" [disabled]="!mergeId() || mergeReason.trim().length < 3" (click)="doMerge()">Fusionar en esta ficha</button>
        </div>
      </app-modal>
    }
  `,
  styles: `
    .ficha {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
      gap: 0 1.25rem;
      align-items: start;
    }
    @media (max-width: 767px) {
      .ficha {
        grid-template-columns: 1fr;
      }
    }
    .scroll-x {
      overflow-x: auto;
    }
    .dl {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 0.4rem 1rem;
      margin: 0;
      dt {
        color: var(--nezumi-ink);
        font-size: 0.85rem;
      }
      dd {
        margin: 0;
      }
    }
  `,
})
export class PersonDetailPage {
  private api = inject(ApiService);
  private mut = inject(MutationService);
  private dialog = inject(DialogService);
  readonly auth = inject(AuthService);

  readonly id = input.required<string>();
  /** ?tab=historial abre el historial deportivo. */
  readonly tab = input<string | undefined>();
  readonly grades = GRADES;
  readonly fdate = fmtDate;
  readonly person = signal<Person | null>(null);
  readonly dojos = signal<Dojo[]>([]);
  readonly error = signal('');
  readonly gradeOpen = signal(false);
  readonly dojoOpen = signal(false);
  readonly mergeOpen = signal(false);
  readonly mergeCandidates = signal<Person[]>([]);
  readonly dupSuggestions = signal<Duplicate[]>([]);
  readonly mergeId = signal<number | null>(null);
  readonly mergeResult = signal<MergeResult | null>(null);
  readonly consentOpen = signal(false);
  readonly roles = signal<RoleOut[]>([]);
  readonly tournaments = signal<Tournament[]>([]);
  readonly canViewDocs = computed(() => this.auth.canViewDocuments());
  readonly roleLabel: Record<string, string> = {
    organizer: 'Organizador',
    table_operator: 'Operador de mesa',
    dojo_admin: 'Administrador de dojo',
    referee: 'Árbitro',
    sensei: 'Sensei',
  };
  readonly roleKeys = Object.keys(this.roleLabel);
  mergeQ = '';
  mergeReason = '';
  consent: ConsentIn = this.blankConsent();
  newRole: RoleIn = { role: 'table_operator', scope_type: 'global', scope_id: null };

  edit = { first_names: '', last_names: '', birth_date: '', sex: 'M', doc_type: 'DNI', doc_number: '' };
  grade = { grade: '8 kyu', awarded_on: todayLima() };
  membership = { dojo_id: null as number | null, branch_id: null as number | null, start_date: todayLima() };

  private dojoMap = computed(() => new Map(this.dojos().map((d) => [d.id, d])));

  constructor() {
    this.api.get<Dojo[]>('/dojos').subscribe({ next: (d) => this.dojos.set(d), error: () => {} });
    effect(() => {
      const id = Number(this.id());
      if (id) this.load(id);
    });
  }

  async load(id = Number(this.id())): Promise<void> {
    try {
      const p = await firstValueFrom(this.api.get<Person>(`/persons/${id}`));
      this.edit = {
        first_names: p.first_names,
        last_names: p.last_names,
        birth_date: p.birth_date ?? '',
        sex: p.sex,
        doc_type: p.documents[0]?.doc_type ?? 'DNI',
        doc_number: p.documents[0]?.number ?? '',
      };
      this.person.set(p);
      this.error.set('');
      if (this.auth.isAdmin()) this.loadRoles(id);
    } catch (e) {
      this.error.set(ApiError.from(e).fullMessage);
    }
  }

  // --- Consentimientos ---
  private blankConsent(): ConsentIn {
    return { given_by: '', relationship_to_person: 'titular', given_on: todayLima(), medium: 'declaración del dojo', scope: 'competencia' };
  }

  openConsent(): void {
    this.consent = this.blankConsent();
    this.consentOpen.set(true);
  }

  async addConsent(): Promise<void> {
    const body = { ...this.consent, given_by: this.consent.given_by.trim() };
    const res = await this.mut.post(`/persons/${this.person()!.id}/consents`, body as unknown as Record<string, unknown>, {
      success: 'Consentimiento registrado',
    });
    if (res) {
      this.consentOpen.set(false);
      this.load();
    }
  }

  // --- Anonimización (solo Admin) ---
  async anonymize(): Promise<void> {
    const p = this.person()!;
    const reason = await this.dialog.prompt({
      title: 'Anonimizar persona',
      message: `Se borrarán de forma IRREVERSIBLE los datos personales de ${p.first_names} ${p.last_names} (#${p.id}): nombres, documentos, fecha de nacimiento y consentimientos. Los resultados deportivos se conservan sin identificar.`,
      label: 'Motivo (obligatorio)',
      minLength: 3,
      confirmText: 'Continuar',
    });
    if (!reason) return;
    const ok = await this.dialog.confirm({
      title: 'Confirmar anonimización',
      message: `Esta acción no se puede deshacer. ¿Anonimizar a #${p.id} ${p.first_names} ${p.last_names}?`,
      danger: true,
      confirmText: 'Anonimizar definitivamente',
    });
    if (!ok) return;
    const res = await this.mut.post<Person>(`/persons/${p.id}/anonymize`, { reason }, { success: 'Persona anonimizada' });
    if (res) this.load();
  }

  // --- Roles (solo Admin) ---
  private async loadRoles(id: number): Promise<void> {
    try {
      this.roles.set(await firstValueFrom(this.api.get<RoleOut[]>(`/persons/${id}/roles`)));
      if (this.roles().some((r) => r.scope_type === 'tatami' || r.scope_type === 'tournament')) this.onScopeType('tatami');
    } catch {
      this.roles.set([]);
    }
  }

  onScopeType(t: string): void {
    if ((t === 'tournament' || t === 'tatami') && !this.tournaments().length) {
      this.api.get<Tournament[]>('/tournaments').subscribe({ next: (l) => this.tournaments.set(l), error: () => {} });
    }
  }

  scopeText(r: RoleOut): string {
    if (r.scope_type === 'global') return 'Global';
    if (r.scope_type === 'tournament') return 'Torneo: ' + (this.tournaments().find((t) => t.id === r.scope_id)?.name ?? `#${r.scope_id}`);
    if (r.scope_type === 'dojo') return 'Dojo: ' + (this.dojoName(r.scope_id) || `#${r.scope_id}`);
    if (r.scope_type === 'tatami') {
      for (const t of this.tournaments()) {
        const tt = t.tatamis.find((x) => x.id === r.scope_id);
        if (tt) return `${tt.name} · ${t.name}`;
      }
      return `Tatami #${r.scope_id}`;
    }
    return `${r.scope_type} #${r.scope_id ?? ''}`;
  }

  async addRole(): Promise<void> {
    const body: RoleIn = { ...this.newRole, scope_id: this.newRole.scope_type === 'global' ? null : this.newRole.scope_id };
    const res = await this.mut.post<RoleOut>(`/persons/${this.person()!.id}/roles`, body as unknown as Record<string, unknown>, {
      success: 'Rol agregado',
    });
    if (res) {
      this.newRole = { role: this.newRole.role, scope_type: 'global', scope_id: null };
      this.loadRoles(this.person()!.id);
    }
  }

  async removeRole(r: RoleOut): Promise<void> {
    const ok = await this.dialog.confirm({
      title: 'Quitar rol',
      message: `Se quitará el rol "${this.roleLabel[r.role] ?? r.role}" (${this.scopeText(r)}).`,
      danger: true,
      confirmText: 'Quitar',
    });
    if (!ok) return;
    const res = await this.mut.run(() => this.api.delete<void>(`/roles/${r.id}`), { success: 'Rol quitado' });
    if (res !== undefined) this.loadRoles(this.person()!.id);
  }

  dojoName(id: number | null): string {
    return id ? (this.dojoMap().get(id)?.name ?? `#${id}`) : '';
  }

  branchesOf(id: number | null) {
    return id ? (this.dojoMap().get(id)?.branches ?? []) : [];
  }

  async save(): Promise<void> {
    const p = this.person()!;
    const e = this.edit;
    const body: Record<string, unknown> = {
      version: p.version,
      first_names: e.first_names.trim(),
      last_names: e.last_names.trim(),
      sex: e.sex,
    };
    if (this.canViewDocs()) {
      body['birth_date'] = e.birth_date || null;
      if (e.doc_number.trim()) body['document'] = { doc_type: e.doc_type, number: e.doc_number.trim() };
    }
    const res = await this.mut.patch<Person>(`/persons/${p.id}`, body, { success: 'Datos guardados', onConflict: () => this.load() });
    if (res) this.person.set(res);
  }

  async addGrade(): Promise<void> {
    const res = await this.mut.post(`/persons/${this.person()!.id}/grades`, { ...this.grade }, { success: 'Grado registrado' });
    if (res) {
      this.gradeOpen.set(false);
      this.load();
    }
  }

  openDojo(): void {
    this.membership = { dojo_id: this.person()?.current_dojo_id ?? this.dojos()[0]?.id ?? null, branch_id: null, start_date: todayLima() };
    this.dojoOpen.set(true);
  }

  async changeDojo(): Promise<void> {
    const res = await this.mut.post(`/persons/${this.person()!.id}/memberships`, { ...this.membership }, { success: 'Dojo actualizado' });
    if (res) {
      this.dojoOpen.set(false);
      this.load();
    }
  }

  openMerge(): void {
    const p = this.person()!;
    this.mergeQ = p.last_names;
    this.mergeReason = '';
    this.mergeId.set(null);
    this.mergeCandidates.set([]);
    this.mergeOpen.set(true);
    this.api
      .get<Duplicate[]>('/persons/duplicates', { first_names: p.first_names, last_names: p.last_names, birth_date: p.birth_date })
      .subscribe({ next: (d) => this.dupSuggestions.set(d.filter((x) => x.person_id !== p.id)), error: () => {} });
    this.searchMerge();
  }

  searchMerge(): void {
    const me = this.person()!.id;
    this.api.get<Person[]>('/persons', { q: this.mergeQ, limit: 20 }).subscribe({
      next: (r) => this.mergeCandidates.set(r.filter((x) => x.id !== me && !this.dupSuggestions().some((d) => d.person_id === x.id))),
      error: () => {},
    });
  }

  async doMerge(): Promise<void> {
    const ok = await this.dialog.confirm({
      title: 'Confirmar fusión',
      message: `La persona #${this.mergeId()} se fusionará en #${this.person()!.id}.`,
      danger: true,
      confirmText: 'Fusionar',
    });
    if (!ok) return;
    const res = await this.mut.post<MergeResult>(
      '/persons/merge',
      { keep_id: this.person()!.id, merge_id: this.mergeId(), reason: this.mergeReason.trim() },
      { success: 'Personas fusionadas' },
    );
    if (res) {
      this.mergeOpen.set(false);
      this.mergeResult.set(res);
      this.load();
    }
  }

  async revert(mergeId: number): Promise<void> {
    const ok = await this.dialog.confirm({ title: 'Revertir fusión', message: `Se revertirá la fusión #${mergeId}.`, confirmText: 'Revertir' });
    if (!ok) return;
    const res = await this.mut.post(`/persons/merges/${mergeId}/revert`, {}, { success: 'Fusión revertida' });
    if (res) {
      this.mergeResult.set(null);
      this.load();
    }
  }
}
