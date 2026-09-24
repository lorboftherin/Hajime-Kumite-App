import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../../core/api.service';
import { AuthService } from '../../../core/auth.service';
import { DialogService } from '../../../core/dialog.service';
import { CATEGORY_STATUS, FORMAT_LABEL, THIRD_PLACE_LABEL, TOURNAMENT_STATUS } from '../../../core/format';
import { Registration, Template, Tournament } from '../../../core/models';
import { MutationService } from '../../../core/mutation.service';
import { StatusBadge } from '../../../shared/badge';
import { Modal } from '../../../shared/modal';
import { DatePipe, LabelPipe } from '../../../shared/pipes';
import { TournamentContext } from '../tournament-context';

interface Transition {
  to: string;
  label: string;
  reopen?: boolean;
  danger?: boolean;
}

/** Acciones sugeridas por estado (solo presentación; el servidor valida la transición). */
const NEXT: Record<string, Transition[]> = {
  draft: [
    { to: 'registration_open', label: 'Abrir inscripciones' },
    { to: 'cancelled', label: 'Cancelar torneo', danger: true },
  ],
  registration_open: [
    { to: 'registration_closed', label: 'Cerrar inscripciones' },
    { to: 'cancelled', label: 'Cancelar torneo', danger: true },
  ],
  registration_closed: [
    { to: 'in_progress', label: 'Iniciar torneo' },
    { to: 'registration_open', label: 'Reabrir inscripciones' },
  ],
  in_progress: [{ to: 'finished', label: 'Finalizar torneo' }],
  finished: [{ to: 'in_progress', label: 'Reabrir torneo (auditado)', reopen: true }],
  cancelled: [],
};

@Component({
  selector: 'app-summary-tab',
  imports: [FormsModule, RouterLink, StatusBadge, Modal, DatePipe, LabelPipe],
  template: `
    @if (ctx.tournament(); as t) {
      <div class="grid-2">
        <div class="card">
          <h3>Estado</h3>
          <div class="row mb">
            <app-status [status]="t.status" type="tournament" />
            <span class="muted small">versión {{ t.version }}</span>
          </div>
          <div class="row">
            @for (tr of transitions(); track tr.to) {
              <button class="btn" [class.danger]="tr.danger" [class.primary]="!tr.danger" (click)="changeStatus(tr)">{{ tr.label }}</button>
            } @empty {
              <span class="muted">Sin acciones disponibles.</span>
            }
          </div>
          @if (t.status === 'finished' && !auth.isAdmin()) {
            <p class="hint">Solo el Admin Global puede reabrir un torneo finalizado.</p>
          }
        </div>
        <div class="card">
          <h3>Datos generales</h3>
          <dl class="dl">
            <dt>Fechas</dt><dd>{{ t.start_date | fdate }}@if (t.end_date) { – {{ t.end_date | fdate }} }</dd>
            <dt>Sede</dt><dd>{{ t.venue || '—' }}, {{ t.city || '—' }}</dd>
            <dt>Fecha de referencia de edad</dt><dd>{{ t.age_reference_date | fdate }}</dd>
            <dt>Formato por defecto</dt><dd>{{ t.default_format | label: formatLabel }}</dd>
            <dt>Terceros lugares</dt><dd>{{ t.default_third_place_rule | label: thirdLabel }}</dd>
            <dt>Tatamis</dt><dd>{{ t.tatamis.length }}</dd>
          </dl>
          <button class="btn sm" (click)="openEdit(t)">Editar datos</button>
        </div>
      </div>

      <div class="grid-2">
        <div class="card">
          <h3>Categorías ({{ ctx.categories().length }})</h3>
          <div class="row">
            @for (s of catStats(); track s.status) {
              <span class="stat"><app-status [status]="s.status" /> {{ s.count }}</span>
            }
          </div>
          <div class="row mt">
            <a class="btn sm" routerLink="../categorias">Ver categorías</a>
            <button class="btn sm" (click)="openGenerate()">Generar categorías desde plantilla</button>
          </div>
        </div>
        <div class="card">
          <h3>Inscripciones</h3>
          <div class="big">{{ activeRegs() }}</div>
          <div class="muted small">activas · {{ withdrawnRegs() }} retiradas</div>
          <div class="row mt">
            <a class="btn sm" routerLink="../inscripciones">Inscribir</a>
            <a class="btn sm" routerLink="../importar">Importar Excel</a>
          </div>
        </div>
      </div>
    }

    @if (edit(); as f) {
      <app-modal title="Editar torneo" (closed)="edit.set(null)">
        <form (ngSubmit)="saveEdit(f)" class="stack">
          <label class="field"><span>Nombre</span><input name="n" [(ngModel)]="f.name" /></label>
          <div class="grid-2">
            <label class="field"><span>Inicio</span><input type="date" name="s" [(ngModel)]="f.start_date" /></label>
            <label class="field"><span>Fin</span><input type="date" name="e" [(ngModel)]="f.end_date" /></label>
            <label class="field"><span>Sede</span><input name="v" [(ngModel)]="f.venue" /></label>
            <label class="field"><span>Ciudad</span><input name="c" [(ngModel)]="f.city" /></label>
            <label class="field"><span>Referencia de edad</span><input type="date" name="a" [(ngModel)]="f.age_reference_date" /></label>
            <label class="field">
              <span>Terceros lugares</span>
              <select name="tp" [(ngModel)]="f.default_third_place_rule">
                <option value="two_bronzes">Dos bronces</option>
                <option value="third_place_match">Combate por el 3.º</option>
                <option value="repechage">Repechaje</option>
              </select>
            </label>
          </div>
          <label class="field inline"><input type="checkbox" name="t" [(ngModel)]="f.is_test" /> Torneo de prueba</label>
          <div class="form-actions">
            <button type="button" class="btn" (click)="edit.set(null)">Cancelar</button>
            <button class="btn primary">Guardar</button>
          </div>
        </form>
      </app-modal>
    }

    @if (genOpen()) {
      <app-modal title="Generar categorías" (closed)="genOpen.set(false)">
        <p class="small muted">Copia las categorías de una plantilla al torneo. Luego puedes editarlas, fusionarlas o cancelarlas.</p>
        <label class="field">
          <span>Plantilla</span>
          <select [(ngModel)]="genTemplate">
            @for (tp of templates(); track tp.id) {
              <option [ngValue]="tp.id">{{ tp.name }} ({{ tp.items.length }} categorías)</option>
            }
          </select>
        </label>
        <div class="form-actions">
          <button class="btn" (click)="genOpen.set(false)">Cancelar</button>
          <button class="btn primary" (click)="generate()">Generar</button>
        </div>
      </app-modal>
    }
  `,
  styles: `
    .dl {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 0.3rem 1rem;
      margin: 0 0 0.75rem;
      dt {
        color: var(--muted);
        font-size: 0.85rem;
      }
      dd {
        margin: 0;
      }
    }
    .stat {
      display: inline-flex;
      gap: 0.3rem;
      align-items: center;
      font-weight: 600;
      margin-right: 0.5rem;
    }
    .big {
      font-size: 2rem;
      font-weight: 800;
    }
  `,
})
export class SummaryTab {
  readonly ctx = inject(TournamentContext);
  readonly auth = inject(AuthService);
  private api = inject(ApiService);
  private mut = inject(MutationService);
  private dialog = inject(DialogService);

  readonly formatLabel = FORMAT_LABEL;
  readonly thirdLabel = THIRD_PLACE_LABEL;
  readonly regs = signal<Registration[]>([]);
  readonly edit = signal<any | null>(null);
  readonly genOpen = signal(false);
  readonly templates = signal<Template[]>([]);
  genTemplate: number | null = null;

  readonly transitions = computed(() => NEXT[this.ctx.tournament()?.status ?? ''] ?? []);
  readonly catStats = computed(() => {
    const m = new Map<string, number>();
    for (const c of this.ctx.categories()) m.set(c.status, (m.get(c.status) ?? 0) + 1);
    return Object.keys(CATEGORY_STATUS)
      .filter((s) => m.has(s))
      .map((status) => ({ status, count: m.get(status)! }));
  });
  readonly activeRegs = computed(() => this.regs().filter((r) => r.status === 'active').length);
  readonly withdrawnRegs = computed(() => this.regs().filter((r) => r.status !== 'active').length);

  constructor() {
    this.loadRegs();
  }

  loadRegs(): void {
    this.api.get<Registration[]>(`/tournaments/${this.ctx.id()}/registrations`).subscribe({
      next: (r) => this.regs.set(r),
      error: () => {},
    });
  }

  async changeStatus(tr: Transition): Promise<void> {
    const t = this.ctx.tournament()!;
    let reason: string | null = null;
    if (tr.reopen) {
      reason = await this.dialog.prompt({
        title: 'Reabrir torneo',
        message: 'Reabrir un torneo finalizado queda auditado (quién, cuándo y por qué).',
        label: 'Motivo',
        minLength: 3,
        confirmText: 'Reabrir',
      });
      if (!reason) return;
    } else {
      const ok = await this.dialog.confirm({
        title: tr.label,
        message: `El torneo pasará a "${TOURNAMENT_STATUS[tr.to]}".`,
        danger: tr.danger,
        confirmText: tr.label,
      });
      if (!ok) return;
    }
    const res = await this.mut.patch<Tournament>(
      `/tournaments/${t.id}/status`,
      { status: tr.to, version: t.version, reason },
      { success: 'Estado actualizado', onConflict: () => this.ctx.reload() },
    );
    if (res) {
      this.ctx.tournament.set(res);
      this.ctx.loadCategories();
    }
  }

  openEdit(t: Tournament): void {
    this.edit.set({
      name: t.name,
      start_date: t.start_date,
      end_date: t.end_date ?? '',
      venue: t.venue,
      city: t.city,
      is_test: t.is_test,
      age_reference_date: t.age_reference_date,
      default_third_place_rule: t.default_third_place_rule,
    });
  }

  async saveEdit(f: any): Promise<void> {
    const t = this.ctx.tournament()!;
    const res = await this.mut.patch<Tournament>(
      `/tournaments/${t.id}`,
      { ...f, end_date: f.end_date || null, version: t.version },
      { success: 'Torneo actualizado', onConflict: () => this.ctx.reload() },
    );
    if (res) {
      this.ctx.tournament.set(res);
      this.edit.set(null);
    }
  }

  openGenerate(): void {
    this.genOpen.set(true);
    this.api.get<Template[]>('/templates').subscribe({
      next: (t) => {
        this.templates.set(t);
        this.genTemplate = this.ctx.tournament()?.template_id ?? t[0]?.id ?? null;
      },
      error: () => {},
    });
  }

  async generate(): Promise<void> {
    const res = await this.mut.post<{ created: number }>(`/tournaments/${this.ctx.id()}/generate-categories`, {
      template_id: this.genTemplate,
    });
    if (res) {
      this.genOpen.set(false);
      this.ctx.loadCategories();
      this.dialog.alert('Categorías generadas', `Se crearon ${res.created} categorías.`);
    }
  }
}
