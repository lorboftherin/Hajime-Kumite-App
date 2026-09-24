import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { todayLima } from '../../core/format';
import { Template, Tournament } from '../../core/models';
import { MutationService } from '../../core/mutation.service';
import { StatusBadge } from '../../shared/badge';
import { Modal } from '../../shared/modal';
import { DatePipe } from '../../shared/pipes';

@Component({
  selector: 'app-tournament-list',
  imports: [FormsModule, RouterLink, StatusBadge, Modal, DatePipe],
  template: `
    <div class="container">
      <div class="page-header">
        <h1>Torneos</h1>
        <div class="row">
          <label class="field inline small"><input type="checkbox" [(ngModel)]="includeTest" (ngModelChange)="load()" /> Incluir torneos de prueba</label>
          <button class="btn primary" (click)="openNew()">+ Nuevo torneo</button>
        </div>
      </div>
      @if (loading()) {
        <div class="empty"><span class="spinner"></span></div>
      } @else if (!tournaments().length) {
        <div class="card empty">Aún no hay torneos. Crea el primero.</div>
      } @else {
        <div class="cards">
          @for (t of tournaments(); track t.id) {
            <a class="card tcard" [routerLink]="['/torneos', t.id]">
              <div class="row">
                <app-status [status]="t.status" type="tournament" />
                @if (t.is_test) {
                  <span class="badge warn">Prueba</span>
                }
              </div>
              <h3>{{ t.name }}</h3>
              <div class="muted small">
                {{ t.start_date | fdate }}@if (t.end_date && t.end_date !== t.start_date) { – {{ t.end_date | fdate }} }
              </div>
              <div class="small">{{ t.venue }}@if (t.venue && t.city) {, }{{ t.city }}</div>
              <div class="muted small">{{ t.tatamis.length }} tatami(s)</div>
            </a>
          }
        </div>
      }
    </div>

    @if (showNew()) {
      <app-modal title="Nuevo torneo" (closed)="showNew.set(false)">
        <form (ngSubmit)="create()" class="stack">
          <label class="field"><span>Nombre *</span><input name="name" [(ngModel)]="form.name" required minlength="3" /></label>
          <div class="grid-2">
            <label class="field"><span>Fecha de inicio *</span><input type="date" name="sd" [(ngModel)]="form.start_date" required /></label>
            <label class="field"><span>Fecha de fin</span><input type="date" name="ed" [(ngModel)]="form.end_date" /></label>
            <label class="field"><span>Local / sede</span><input name="venue" [(ngModel)]="form.venue" /></label>
            <label class="field"><span>Ciudad</span><input name="city" [(ngModel)]="form.city" /></label>
            <label class="field">
              <span>Plantilla de categorías</span>
              <select name="tpl" [(ngModel)]="form.template_id">
                <option [ngValue]="null">— Sin plantilla —</option>
                @for (tp of templates(); track tp.id) {
                  <option [ngValue]="tp.id">{{ tp.name }} ({{ tp.items.length }})</option>
                }
              </select>
            </label>
            <label class="field"><span>Número de tatamis</span><input type="number" min="1" max="12" name="tc" [(ngModel)]="form.tatami_count" /></label>
            <label class="field">
              <span>Formato por defecto</span>
              <select name="fmt" [(ngModel)]="form.default_format">
                <option value="single_elimination">Eliminación directa</option>
                <option value="round_robin">Round robin</option>
              </select>
            </label>
            <label class="field">
              <span>Terceros lugares</span>
              <select name="tp" [(ngModel)]="form.default_third_place_rule">
                <option value="two_bronzes">Dos bronces</option>
                <option value="third_place_match">Combate por el 3.º</option>
                <option value="repechage">Repechaje</option>
              </select>
            </label>
          </div>
          <label class="field inline"><input type="checkbox" name="test" [(ngModel)]="form.is_test" /> Torneo de prueba (no cuenta en historial ni medallero)</label>
          <div class="form-actions">
            <button type="button" class="btn" (click)="showNew.set(false)">Cancelar</button>
            <button class="btn primary" [disabled]="form.name.trim().length < 3 || !form.start_date || busy()">Crear torneo</button>
          </div>
        </form>
      </app-modal>
    }
  `,
  styles: `
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 1rem;
    }
    .tcard {
      color: inherit;
      display: flex;
      flex-direction: column;
      gap: 0.3rem;
      text-decoration: none !important;
      transition: box-shadow 0.15s, transform 0.15s;
      border-top: 4px solid var(--aka);
      h3 {
        margin: 0.25rem 0 0;
      }
    }
    .tcard:nth-child(even) {
      border-top-color: var(--ao);
    }
    .tcard:hover {
      box-shadow: var(--shadow-lg);
      transform: translateY(-2px);
    }
  `,
})
export class TournamentListPage {
  private api = inject(ApiService);
  private mut = inject(MutationService);
  private router = inject(Router);

  readonly tournaments = signal<Tournament[]>([]);
  readonly templates = signal<Template[]>([]);
  readonly loading = signal(true);
  readonly showNew = signal(false);
  readonly busy = signal(false);
  includeTest = true;
  form = this.blank();

  constructor() {
    this.load();
  }

  blank() {
    return {
      name: '',
      start_date: todayLima(),
      end_date: '',
      venue: '',
      city: 'Lima',
      is_test: false,
      template_id: null as number | null,
      tatami_count: 1,
      default_format: 'single_elimination',
      default_third_place_rule: 'two_bronzes',
    };
  }

  load(): void {
    this.loading.set(true);
    this.api.get<Tournament[]>('/tournaments', { include_test: this.includeTest }).subscribe({
      next: (t) => {
        this.tournaments.set(t);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  openNew(): void {
    this.form = this.blank();
    this.showNew.set(true);
    this.api.get<Template[]>('/templates').subscribe({
      next: (t) => {
        this.templates.set(t);
        if (t.length && this.form.template_id === null) this.form.template_id = t[0].id;
      },
      error: () => {},
    });
  }

  async create(): Promise<void> {
    this.busy.set(true);
    const body = { ...this.form, end_date: this.form.end_date || null, tatami_count: Number(this.form.tatami_count) || 1 };
    const t = await this.mut.post<Tournament>('/tournaments', body, { success: 'Torneo creado' });
    this.busy.set(false);
    if (t) {
      this.showNew.set(false);
      this.router.navigate(['/torneos', t.id]);
    }
  }
}
