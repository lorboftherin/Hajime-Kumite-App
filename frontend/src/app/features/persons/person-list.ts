import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Subject, debounceTime } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { DialogService } from '../../core/dialog.service';
import { Dojo, Person } from '../../core/models';
import { MutationService } from '../../core/mutation.service';
import { Modal } from '../../shared/modal';
import { PersonForm } from '../../shared/person-form';
import { DatePipe } from '../../shared/pipes';

@Component({
  selector: 'app-person-list',
  imports: [FormsModule, RouterLink, Modal, PersonForm, DatePipe],
  template: `
    <div class="container">
      <div class="page-header">
        <h1>Personas</h1>
        <div class="row">
          @if (auth.isAdmin()) {
            <button class="btn" (click)="revert()">Revertir fusión…</button>
          }
          <button class="btn primary" (click)="showNew.set(true)">+ Nueva persona</button>
        </div>
      </div>
      <div class="card row">
        <input class="grow" placeholder="Buscar por nombre o número de documento…" [ngModel]="q()" (ngModelChange)="onQ($event)" />
        <select [ngModel]="dojo()" (ngModelChange)="dojo.set($event); load()">
          <option [ngValue]="null">Todos los dojos</option>
          @for (d of dojos(); track d.id) {
            <option [ngValue]="d.id">{{ d.name }}</option>
          }
        </select>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Apellidos y nombres</th>
              @if (auth.canViewDocuments()) {
                <th>Nac.</th>
              }
              <th>Sexo</th>
              @if (auth.canViewDocuments()) {
                <th>Documento</th>
              }
              <th>Dojo</th>
              <th>Grado</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            @for (p of persons(); track p.id) {
              <tr>
                <td><a [routerLink]="['/personas', p.id]"><strong>{{ p.last_names }}</strong>, {{ p.first_names }}</a></td>
                @if (auth.canViewDocuments()) {
                  <td class="nowrap">{{ p.birth_date | fdate }}</td>
                }
                <td>{{ p.sex }}</td>
                @if (auth.canViewDocuments()) {
                  <td class="small mono">
                    @for (d of p.documents; track d.id) {
                      {{ d.doc_type }} {{ d.number }}
                    }
                  </td>
                }
                <td>{{ dojoName(p.current_dojo_id) }}</td>
                <td>{{ p.current_grade }}</td>
                <td>
                  @if (p.identity_incomplete) {
                    <span class="badge warn" title="Faltan datos de identidad">Identidad incompleta</span>
                  }
                  @if (p.anonymized_at) {
                    <span class="badge" title="Datos personales anonimizados">Anonimizada</span>
                  }
                </td>
              </tr>
            } @empty {
              <tr><td colspan="7" class="empty">Sin resultados.</td></tr>
            }
          </tbody>
        </table>
      </div>
      <p class="muted small">Se muestran hasta 100 resultados.</p>
    </div>

    @if (showNew()) {
      <app-modal title="Nueva persona" [wide]="true" (closed)="showNew.set(false)">
        <app-person-form (created)="created($event)" (useExisting)="goTo($event)">
          <button type="button" class="btn" (click)="showNew.set(false)">Cancelar</button>
        </app-person-form>
      </app-modal>
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
  readonly dojos = signal<Dojo[]>([]);
  readonly q = signal('');
  readonly dojo = signal<number | null>(null);
  readonly showNew = signal(false);
  private dojoMap = computed(() => new Map(this.dojos().map((d) => [d.id, d.name])));
  private q$ = new Subject<void>();

  constructor() {
    this.api.get<Dojo[]>('/dojos').subscribe({ next: (d) => this.dojos.set(d), error: () => {} });
    this.q$.pipe(debounceTime(250)).subscribe(() => this.load());
    this.load();
  }

  onQ(v: string): void {
    this.q.set(v);
    this.q$.next();
  }

  load(): void {
    this.api.get<Person[]>('/persons', { q: this.q().trim() || null, dojo_id: this.dojo(), limit: 100 }).subscribe({
      next: (p) => this.persons.set(p),
      error: () => {},
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
      title: 'Revertir fusión de personas',
      message: 'Ingresa el número de la fusión (se muestra al fusionar y en Auditoría).',
      label: 'N.º de fusión',
      minLength: 1,
    });
    if (!id) return;
    const res = await this.mut.post(`/persons/merges/${Number(id)}/revert`, {}, { success: 'Fusión revertida' });
    if (res) this.load();
  }
}
