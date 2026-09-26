import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { fmtDate, todayLima } from '../../core/format';
import { Organization, Template, Tournament } from '../../core/models';
import { MutationService } from '../../core/mutation.service';
import { StatusBadge } from '../../shared/badge';
import { Modal } from '../../shared/modal';
import { Enso } from '../../shared/enso';
import { Icon } from '../../shared/icon';
import { PageHead } from '../../shared/page-head';

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

const INCLUDE_TEST_KEY = 'hajime.torneos.incluir-prueba';

function readIncludeTest(): boolean {
  try {
    return localStorage.getItem(INCLUDE_TEST_KEY) === '1';
  } catch {
    return false;
  }
}

@Component({
  selector: 'app-tournament-list',
  imports: [FormsModule, RouterLink, StatusBadge, Modal, PageHead, Icon, Enso],
  template: `
    <div class="container">
      <app-page-head kanji="大会" title="Torneos">
        <div meta class="meta-line">
          @if (!loading()) {
            <span>{{ tournaments().length }} {{ tournaments().length === 1 ? 'torneo' : 'torneos' }}</span>
          }
        </div>
        <label class="field inline small"><input type="checkbox" [(ngModel)]="includeTest" (ngModelChange)="onIncludeTest()" /> Incluir torneos de prueba</label>
        <button class="btn primary" (click)="openNew()"><app-icon name="plus" /> Nuevo torneo</button>
      </app-page-head>
      @if (loading()) {
        <div class="empty"><span class="spinner"></span></div>
      } @else if (!tournaments().length) {
        <div class="card start" data-testid="getting-started">
          <app-enso class="start-enso" tone="mono" />
          <div class="start-body">
            <h2>Primeros pasos</h2>
            <p class="muted">
              Aún no hay torneos@if (!includeTest) { (los de prueba están ocultos)}. Para probar Hajime de punta a punta:
            </p>
            <ol class="steps">
              <li>
                <strong>Crear torneo</strong>: elige la plantilla <em>"Plantilla base (borrador)"</em> y marca
                <em>"Torneo de prueba"</em> para que no cuente en historial ni medallero.
              </li>
              <li><strong>Importar Excel o inscribir</strong> competidores (pestañas <em>Importar Excel</em> o <em>Inscripciones</em>).</li>
              <li><strong>Generar llaves</strong> en la pestaña <em>Categorías</em>.</li>
              <li><strong>Abrir la mesa</strong> desde la pestaña <em>Tatamis</em> y marcar el combate.</li>
            </ol>
            <div><button class="btn primary" (click)="openNew(true)"><app-icon name="plus" /> Crear torneo de prueba</button></div>
          </div>
        </div>
      } @else {
        <div class="cards">
          @for (t of tournaments(); track t.id) {
            <a class="card tcard" [routerLink]="['/torneos', t.id]">
              <div class="date" aria-hidden="true">
                <span class="day">{{ day(t.start_date) }}</span>
                <span class="mon">{{ month(t.start_date) }}</span>
                <span class="yr">{{ year(t.start_date) }}</span>
              </div>
              <div class="body">
                <h3>{{ t.name }}</h3>
                @if (t.end_date && t.end_date !== t.start_date) {
                  <div class="when small">{{ dateRange(t.start_date, t.end_date) }}</div>
                }
                <div class="where small">{{ t.venue }}@if (t.venue && t.city) {, }{{ t.city }}</div>
                @if (t.organization_name && multiOrg()) {
                  <div class="org small">{{ t.organization_name }}</div>
                }
                <div class="foot">
                  <app-status [status]="t.status" type="tournament" />
                  @if (t.is_test) {
                    <span class="badge yamabuki hollow">Prueba</span>
                  }
                  <span class="tatamis small">{{ t.tatamis.length }} {{ t.tatamis.length === 1 ? 'tatami' : 'tatamis' }}</span>
                </div>
              </div>
            </a>
          }
        </div>
      }
    </div>

    @if (showNew()) {
      <app-modal title="Nuevo torneo" (closed)="showNew.set(false)">
        <form (ngSubmit)="create()" class="stack">
          @if (orgs().length > 1) {
            <label class="field">
              <span>Organización *</span>
              <select name="org" [(ngModel)]="form.organization_id" required>
                @for (o of orgs(); track o.id) {
                  <option [ngValue]="o.id">{{ o.name }}</option>
                }
              </select>
            </label>
          } @else if (orgs().length === 1) {
            <p class="small muted">Organización: <strong>{{ orgs()[0].name }}</strong></p>
          }
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
    .start {
      display: grid;
      grid-template-columns: 9rem minmax(0, 1fr);
      gap: 2.5rem;
      align-items: center;
      max-width: 760px;
      padding: 2.5rem;
      h2 {
        margin-bottom: 0.35rem;
      }
    }
    .start-enso {
      width: 9rem;
      height: 9rem;
      color: var(--kasumi-2);
    }
    @media (max-width: 767px) {
      .start {
        grid-template-columns: 1fr;
        gap: 1rem;
        padding: 1.5rem;
      }
      .start-enso {
        width: 4rem;
        height: 4rem;
      }
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(330px, 1fr));
      gap: 1.25rem;
    }
    .tcard {
      display: grid !important;
      grid-template-columns: 4.25rem minmax(0, 1fr);
      gap: 1.25rem;
      margin: 0;
      padding: 1.5rem 1.5rem 1.25rem;
    }
    .date {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 0.35rem 0 0.5rem;
      border-right: 1px solid var(--kasumi);
      padding-right: 1.1rem;
      line-height: 1.1;
      .day {
        font-family: var(--font-display);
        font-weight: 700;
        font-size: var(--fs-28);
        font-variant-numeric: tabular-nums;
        color: var(--sumi);
      }
      .mon {
        margin-top: 0.3rem;
        font-size: var(--fs-12);
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--sumi-2);
      }
      .yr {
        font-size: var(--fs-12);
        color: var(--nezumi-ink);
        font-variant-numeric: tabular-nums;
      }
    }
    .body {
      display: flex;
      flex-direction: column;
      min-width: 0;
      h3 {
        margin: 0.1rem 0 0.35rem;
        font-family: var(--font-display);
        font-size: var(--fs-20);
        line-height: 1.35;
      }
    }
    .when {
      color: var(--sumi-2);
    }
    .where,
    .org {
      color: var(--nezumi-ink);
    }
    .foot {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
      margin-top: 1rem;
      padding-top: 0.9rem;
      border-top: 1px solid var(--kasumi);
    }
    .tatamis {
      margin-left: auto;
      color: var(--nezumi-ink);
    }
    @media (max-width: 767px) {
      .cards {
        grid-template-columns: 1fr;
        gap: 1rem;
      }
      .tcard {
        grid-template-columns: 3rem minmax(0, 1fr);
        gap: 1rem;
        padding: 1.1rem 1.1rem 1rem;
      }
      .date {
        padding-right: 0.9rem;
      }
    }
  `,
})
export class TournamentListPage {
  private api = inject(ApiService);
  private mut = inject(MutationService);
  private router = inject(Router);

  readonly tournaments = signal<Tournament[]>([]);
  readonly templates = signal<Template[]>([]);
  /** Organizaciones donde el usuario puede crear torneos (owner/admin; el Admin, todas). */
  readonly orgs = signal<Organization[]>([]);
  /** Se muestra la organización en cada tarjeta solo si hay torneos de más de una. */
  readonly multiOrg = signal(false);
  readonly loading = signal(true);
  readonly showNew = signal(false);
  readonly busy = signal(false);
  /** Los torneos de prueba se ocultan por defecto; la elección se recuerda en el dispositivo. */
  includeTest = readIncludeTest();
  form = this.blank();

  constructor() {
    this.load();
  }

  day(d: string): string {
    return d ? String(Number(d.slice(8, 10))) : '';
  }
  month(d: string): string {
    return d ? MONTHS[Number(d.slice(5, 7)) - 1] ?? '' : '';
  }
  year(d: string): string {
    return d ? d.slice(0, 4) : '';
  }
  dateRange(a: string, b: string | null): string {
    return b && b !== a ? `${fmtDate(a)} – ${fmtDate(b)}` : fmtDate(a);
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
      organization_id: null as number | null,
      tatami_count: 1,
      default_format: 'single_elimination',
      default_third_place_rule: 'two_bronzes',
    };
  }

  onIncludeTest(): void {
    try {
      localStorage.setItem(INCLUDE_TEST_KEY, this.includeTest ? '1' : '0');
    } catch {
      /* sin almacenamiento */
    }
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.api.get<Tournament[]>('/tournaments', { include_test: this.includeTest }).subscribe({
      next: (t) => {
        this.tournaments.set(t);
        this.multiOrg.set(new Set(t.map((x) => x.organization_id)).size > 1);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  /** asTest: desde "Primeros pasos" se propone un torneo de prueba con la plantilla base. */
  openNew(asTest = false): void {
    this.form = this.blank();
    if (asTest) {
      this.form.is_test = true;
      this.form.name = 'Torneo de prueba';
    }
    this.showNew.set(true);
    this.api.get<Organization[]>('/organizations').subscribe({
      next: (list) => {
        const mine = list.filter((o) => o.can_manage);
        this.orgs.set(mine);
        if (mine.length && this.form.organization_id === null) this.form.organization_id = mine[0].id;
      },
      error: () => {},
    });
    this.api.get<Template[]>('/templates').subscribe({
      next: (t) => {
        this.templates.set(t);
        if (t.length && this.form.template_id === null) {
          this.form.template_id = (t.find((x) => x.name === 'Plantilla base (borrador)') ?? t[0]).id;
        }
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
