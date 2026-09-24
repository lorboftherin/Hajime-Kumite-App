import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiError } from '../../core/api-error';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { DialogService } from '../../core/dialog.service';
import { GRADES, fmtDate, todayLima } from '../../core/format';
import { Dojo, Duplicate, Person } from '../../core/models';
import { MutationService } from '../../core/mutation.service';
import { Modal } from '../../shared/modal';
import { DatePipe } from '../../shared/pipes';

interface MergeResult {
  id: number;
  kept_person_id: number;
  merged_person_id: number;
  moved: Record<string, unknown>;
}

@Component({
  selector: 'app-person-detail',
  imports: [FormsModule, RouterLink, Modal, DatePipe],
  template: `
    <div class="container">
      <div class="small"><a routerLink="/personas">← Personas</a></div>
      @if (person(); as p) {
        <div class="page-header">
          <div>
            <h1>{{ p.first_names }} {{ p.last_names }}</h1>
            <div class="row small muted">
              <span>#{{ p.id }}</span>
              <span>v{{ p.version }}</span>
              @if (p.identity_incomplete) {
                <span class="badge warn">Identidad incompleta</span>
              }
              @if (p.merged_into_id) {
                <span class="badge danger">Fusionada en <a [routerLink]="['/personas', p.merged_into_id]">#{{ p.merged_into_id }}</a></span>
              }
            </div>
          </div>
          <div class="row">
            <button class="btn" (click)="gradeOpen.set(true)">+ Grado</button>
            <button class="btn" (click)="openDojo()">Cambiar dojo</button>
            @if (auth.isAdmin()) {
              <button class="btn" (click)="openMerge()">Fusionar duplicado…</button>
            }
          </div>
        </div>

        @if (mergeResult(); as mr) {
          <div class="alert ok row">
            <span class="grow">Fusión #{{ mr.id }} realizada: la persona #{{ mr.merged_person_id }} se unió a esta ficha.</span>
            <button class="btn sm" (click)="revert(mr.id)">Revertir fusión</button>
          </div>
        }

        <div class="grid-2">
          <div class="card">
            <h3>Datos personales</h3>
            <form (ngSubmit)="save()" class="stack">
              <div class="grid-2">
                <label class="field"><span>Nombres</span><input name="fn" [(ngModel)]="edit.first_names" /></label>
                <label class="field"><span>Apellidos</span><input name="ln" [(ngModel)]="edit.last_names" /></label>
                <label class="field"><span>Nacimiento</span><input type="date" name="bd" [(ngModel)]="edit.birth_date" /></label>
                <label class="field">
                  <span>Sexo</span>
                  <select name="sx" [(ngModel)]="edit.sex">
                    <option value="M">Masculino</option>
                    <option value="F">Femenino</option>
                  </select>
                </label>
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
              </div>
              <div class="form-actions"><button class="btn primary">Guardar cambios</button></div>
            </form>
          </div>
          <div class="card">
            <h3>Situación deportiva</h3>
            <dl class="dl">
              <dt>Dojo vigente</dt>
              <dd>{{ dojoName(p.current_dojo_id) || '—' }}</dd>
              <dt>Grado vigente</dt>
              <dd>{{ p.current_grade || '—' }}</dd>
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
            </dl>
          </div>
        </div>
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
    .dl {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 0.4rem 1rem;
      margin: 0;
      dt {
        color: var(--muted);
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
  mergeQ = '';
  mergeReason = '';

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
    } catch (e) {
      this.error.set(ApiError.from(e).fullMessage);
    }
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
      birth_date: e.birth_date || null,
      sex: e.sex,
    };
    if (e.doc_number.trim()) body['document'] = { doc_type: e.doc_type, number: e.doc_number.trim() };
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
