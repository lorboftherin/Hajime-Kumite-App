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
import { Icon } from '../../../shared/icon';
import { Modal } from '../../../shared/modal';
import { MoreMenu } from '../../../shared/more-menu';
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

/** Qué sigue en cada estado (Zanshin: el paso siguiente siempre a la vista). */
const HINT: Record<string, string> = {
  draft: 'Prepara categorías y datos; luego abre las inscripciones.',
  registration_open: 'Los dojos pueden inscribir. Cierra las inscripciones para generar las llaves.',
  registration_closed: 'Genera las llaves y asigna tatamis; después inicia el torneo.',
  in_progress: 'Los combates se registran desde la pestaña Tatamis.',
  finished: 'Resultados y medallero publicados.',
  cancelled: 'El torneo fue cancelado.',
};

@Component({
  selector: 'app-summary-tab',
  imports: [FormsModule, RouterLink, StatusBadge, Modal, DatePipe, LabelPipe, MoreMenu, Icon],
  template: `
    @if (ctx.tournament(); as t) {
      <div class="overview">
        <section class="card state">
          <h3>Estado</h3>
          <div class="state-line">
            <app-status [status]="t.status" type="tournament" />
            <span class="muted tiny">versión {{ t.version }}</span>
          </div>
          <p class="next small">{{ nextHint(t.status) }}</p>
          <div class="row actions">
            @for (tr of mainTransitions(); track tr.to; let first = $first) {
              <button class="btn" [class.primary]="first" (click)="changeStatus(tr)">{{ tr.label }}</button>
            } @empty {
              @if (!dangerTransitions().length) {
                <span class="muted small">Sin acciones disponibles.</span>
              }
            }
            @if (dangerTransitions().length) {
              <app-more label="Más acciones del torneo">
                @for (tr of dangerTransitions(); track tr.to) {
                  <button class="menu-item danger" (click)="changeStatus(tr)">{{ tr.label }}</button>
                }
              </app-more>
            }
          </div>
          @if (t.status === 'finished' && !auth.isAdmin()) {
            <p class="hint">Solo el Admin Global puede reabrir un torneo finalizado.</p>
          }
        </section>

        <section class="card kpi">
          <h3>Inscripciones</h3>
          <div class="figure">{{ activeRegs() }}</div>
          <div class="muted small">activas · {{ withdrawnRegs() }} retiradas</div>
          <div class="row actions">
            <a class="btn sm" routerLink="../inscripciones">Inscribir</a>
            <a class="btn sm ghost" routerLink="../importar"><app-icon name="upload" /> Importar Excel</a>
          </div>
        </section>

        <section class="card kpi">
          <h3>Categorías</h3>
          <div class="figure">{{ ctx.categories().length }}</div>
          <ul class="stats">
            @for (s of catStats(); track s.status) {
              <li><app-status [status]="s.status" /><span class="num">{{ s.count }}</span></li>
            }
          </ul>
          <div class="row actions">
            <a class="btn sm" routerLink="../categorias">Ver categorías</a>
            <app-more label="Más acciones de categorías">
              <button class="menu-item" (click)="openGenerate()"><app-icon name="plus" /> Generar desde plantilla</button>
            </app-more>
          </div>
        </section>
      </div>

      <section class="card general">
        <div class="general-head">
          <h3>Datos generales</h3>
          <button class="btn sm" (click)="openEdit(t)">Editar datos</button>
        </div>
        <dl class="dl cols">
          <div><dt>Fechas</dt><dd class="num">{{ t.start_date | fdate }}@if (t.end_date) { – {{ t.end_date | fdate }} }</dd></div>
          <div><dt>Sede</dt><dd>{{ t.venue || '—' }}, {{ t.city || '—' }}</dd></div>
          <div><dt>Referencia de edad</dt><dd class="num">{{ t.age_reference_date | fdate }}</dd></div>
          <div><dt>Formato por defecto</dt><dd>{{ t.default_format | label: formatLabel }}</dd></div>
          <div><dt>Terceros lugares</dt><dd>{{ t.default_third_place_rule | label: thirdLabel }}</dd></div>
          <div><dt>Tatamis</dt><dd class="num">{{ t.tatamis.length }}</dd></div>
        </dl>
      </section>
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
    .overview {
      display: grid;
      grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr) minmax(0, 1fr);
      gap: 1.25rem;
      margin-bottom: 1.25rem;
      .card {
        margin: 0;
        display: flex;
        flex-direction: column;
      }
    }
    @media (max-width: 1100px) {
      .overview {
        grid-template-columns: 1fr 1fr;
      }
      .state {
        grid-column: 1 / -1;
      }
    }
    @media (max-width: 640px) {
      .overview {
        grid-template-columns: 1fr;
      }
    }
    .state-line {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .next {
      color: var(--sumi-2);
      margin: 0.9rem 0 0;
    }
    .actions {
      margin-top: auto;
      padding-top: 1.25rem;
    }
    .kpi .figure {
      margin: 0.1rem 0 0.4rem;
    }
    .stats {
      list-style: none;
      margin: 0.35rem 0 0;
      padding: 0;
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem 0.9rem;
      li {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        font-size: var(--fs-14);
        font-weight: 700;
      }
    }
    .general-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 1rem;
      h3 {
        margin: 0 0 1.25rem;
        font-size: var(--fs-14);
        font-weight: 500;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--nezumi-ink);
      }
    }
    .dl.cols {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1.25rem 2rem;
      margin: 0;
      > div {
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
      }
      dd {
        font-size: var(--fs-16);
      }
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
  /** Acciones habituales a la vista; las destructivas (cancelar) quedan en «Más». */
  readonly mainTransitions = computed(() => this.transitions().filter((t) => !t.danger));
  readonly dangerTransitions = computed(() => this.transitions().filter((t) => t.danger));

  nextHint(status: string): string {
    return HINT[status] ?? '';
  }
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
