import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../../core/api.service';
import { DialogService } from '../../../core/dialog.service';
import { FilesService } from '../../../core/files.service';
import { Category, QueueItem, Tatami, TatamiQueue, Tournament } from '../../../core/models';
import { MutationService } from '../../../core/mutation.service';
import { StatusBadge } from '../../../shared/badge';
import { Icon } from '../../../shared/icon';
import { plural } from '../../../shared/plural';
import { appendUnique, estimateMatches, moveItem } from '../organizer-logic';
import { hourText, zoneOfIso } from '../../public/public-logic';
import { TournamentContext } from '../tournament-context';

/** Zonas horarias frecuentes en torneos de la región (la del torneo siempre aparece). */
const TIMEZONES = [
  'America/Lima',
  'America/Bogota',
  'America/Guayaquil',
  'America/La_Paz',
  'America/Santiago',
  'America/Argentina/Buenos_Aires',
  'America/Caracas',
  'America/Mexico_City',
  'America/Sao_Paulo',
];

interface TatamiView {
  tatami: Tatami;
  data: TatamiQueue | null;
  error?: string;
}

@Component({
  selector: 'app-tatamis-tab',
  imports: [FormsModule, RouterLink, StatusBadge, Icon],
  template: `
    <div class="toolbar">
      <span i18n="@@torneo.tatamis.actualiza-cada-15-s" class="muted small grow">Se actualiza cada 15 s.</span>
      <button i18n-aria-label="@@torneo.tatamis.actualizar" i18n-title="@@torneo.tatamis.actualizar" class="btn icon-only ghost" (click)="load()" title="Actualizar" aria-label="Actualizar"><app-icon name="refresh" /></button>
      <button class="btn" [class.primary]="!planning() && unassignedWithBracket() > 0" (click)="planning.set(!planning())" [attr.aria-expanded]="planning()">
        <ng-container i18n="@@torneo.tatamis.cerrar-organizar-colas">@if (planning()) {Cerrar colas} @else {Organizar colas}</ng-container>
      </button>
      <button class="btn" (click)="toggleScheduling()" [attr.aria-expanded]="scheduling()" i18n="@@torneo.tatamis.cerrar-horarios">@if (scheduling()) {Cerrar horarios} @else {Horarios}</button>
      <button i18n="@@torneo.tatamis.agregar-tatami" class="btn" (click)="addTatami()"><app-icon name="plus" /> Agregar tatami</button>
    </div>

    @if (scheduling()) {
      <section class="card planner" aria-labelledby="h-horarios">
        <h2 i18n="@@torneo.tatamis.horarios-estimados" id="h-horarios">Horarios estimados</h2>
        <p i18n="@@torneo.tatamis.hora-inicio-cada-tatami-estima" class="small muted">
          Con la hora de inicio de cada tatami se estima a qué hora empieza cada combate (duración de la categoría más el
          margen, ajustada con el ritmo real del tatami). Se muestra en la página pública, en «¿Cuándo pelea?» y en las colas.
        </p>
        <form class="sched-grid" (ngSubmit)="saveSettings()">
          <label class="field">
            <span i18n="@@torneo.tatamis.margen-entre-combates-segundos">Margen entre combates (segundos)</span>
            <input type="number" name="ovh" min="0" max="1800" step="5" [(ngModel)]="sched.overhead" />
          </label>
          <label class="field">
            <span i18n="@@torneo.tatamis.zona-horaria">Zona horaria</span>
            <select name="tz" [(ngModel)]="sched.timezone">
              @for (z of zones(); track z) {
                <option [value]="z">{{ z }}</option>
              }
            </select>
          </label>
          <div class="field end"><button i18n="@@torneo.tatamis.guardar" class="btn primary" [disabled]="busy()">Guardar</button></div>
        </form>
        <ul class="list-plain sched-list">
          @for (t of ctx.tournament()?.tatamis ?? []; track t.id) {
            <li>
              <label class="field inline">
                <span i18n="@@torneo.tatamis.inicio" class="grow">{{ t.name || 'Tatami ' + t.number }} · inicio</span>
                <input type="datetime-local" [value]="(t.planned_start ?? '').slice(0, 16)" (change)="savePlanned(t, $any($event.target).value)" [attr.aria-label]="ariaHoraInicio(t.name || 'Tatami ' + t.number)" />
              </label>
            </li>
          }
        </ul>
      </section>
    }
    @if (!planning() && unassignedWithBracket() > 0) {
      <div class="alert warn small">
        <ng-container i18n="@@torneo.tatamis.tatami-combates-no-aparecen">{unassignedWithBracket(), plural, =1 {1 categoría con llave no tiene tatami: sus combates no aparecen en ninguna cola.} other {{{ unassignedWithBracket() }} categorías con llave no tienen tatami: sus combates no aparecen en ninguna cola.}}</ng-container>
        <button i18n="@@torneo.tatamis.organizar-colas" class="btn sm" (click)="planning.set(true)">Organizar colas</button>
      </div>
    }

    @if (planning()) {
      <section i18n-aria-label="@@torneo.tatamis.colas-categorias-tatami" class="card planner" aria-label="Colas de categorías por tatami">
        <h2 i18n="@@torneo.tatamis.colas-categorias">Colas de categorías</h2>
        <p i18n="@@torneo.tatamis.elige-categorias-sin-tatami" class="small muted">
          Elige categorías sin tatami y asígnalas; en cada tatami ordénalas con ↑ ↓ y guarda. El número de combates es una
          estimación según los inscritos y el formato.
        </p>
        <div class="plan-grid">
          <div class="plan-col">
            <h3 i18n="@@torneo.tatamis.sin-tatami">Sin tatami <span class="muted small">({{ unassigned().length }})</span></h3>
            @if (unassigned().length) {
              <label i18n="@@torneo.tatamis.seleccionar-todas" class="field inline small all">
                <input type="checkbox" [checked]="picked().size === unassigned().length" (change)="pickAll($any($event.target).checked)" />
                Seleccionar todas
              </label>
              <ul class="list-plain plan-list">
                @for (c of unassigned(); track c.id) {
                  <li>
                    <label class="field inline">
                      <input type="checkbox" [checked]="picked().has(c.id)" (change)="togglePick(c.id)" />
                      <span class="grow">{{ c.name }}</span>
                      <span i18n="@@torneo.tatamis.n-combates" i18n-title="@@torneo.tatamis.combates-estimados" class="est num" title="Combates estimados">{est(c), plural, =1 {1 combate} other {{{ est(c) }} combates}}</span>
                    </label>
                  </li>
                }
              </ul>
              <div class="row assign">
                <select i18n-aria-label="@@torneo.tatamis.tatami-destino" [ngModel]="target()" (ngModelChange)="target.set($event)" aria-label="Tatami destino">
                  @for (t of ctx.tournament()?.tatamis ?? []; track t.id) {
                    <option [ngValue]="t.id">{{ t.name || 'Tatami ' + t.number }}</option>
                  }
                </select>
                <button i18n="@@torneo.tatamis.asignar" class="btn primary" [disabled]="!picked().size || !target() || busy()" (click)="assignPicked()">
                  Asignar {{ picked().size ? '(' + picked().size + ')' : '' }} a {{ tatamiLabel(target()) }}
                </button>
              </div>
            } @else {
              <p i18n="@@torneo.tatamis.todas-categorias-inscritos" class="muted small">Todas las categorías con inscritos tienen tatami.</p>
            }
          </div>
          @for (t of ctx.tournament()?.tatamis ?? []; track t.id) {
            <div class="plan-col">
              <h3>
                {{ t.name || 'Tatami ' + t.number }}
                <span class="muted small">· <ng-container i18n="@@torneo.tatamis.aprox">{queueTotal(t.id), plural, =1 {1 combate aprox.} other {{{ queueTotal(t.id) }} combates aprox.}}</ng-container></span>
                @if (dirty().has(t.id)) {
                  <span i18n="@@torneo.tatamis.sin-guardar" class="badge yamabuki">sin guardar</span>
                }
              </h3>
              <ol class="list-plain plan-list queue-edit">
                @for (cid of queueOf(t.id); track cid; let i = $index; let first = $first; let last = $last) {
                  @let c = ctx.categoryById().get(cid);
                  <li>
                    <span class="pos num">{{ i + 1 }}</span>
                    <span class="grow">
                      {{ c?.name ?? '#' + cid }}
                      <span i18n="@@torneo.tatamis.n-combates" class="est small num">{c ? est(c) : 0, plural, =1 {1 combate} other {{{ c ? est(c) : 0 }} combates}}</span>
                    </span>
                    <button class="btn sm ghost icon-only" [disabled]="first" (click)="move(t.id, i, -1)" [attr.aria-label]="ariaSubir(c?.name ?? '')">↑</button>
                    <button class="btn sm ghost icon-only" [disabled]="last" (click)="move(t.id, i, 1)" [attr.aria-label]="ariaBajar(c?.name ?? '')">↓</button>
                    <button class="btn sm ghost icon-only" (click)="remove(t.id, cid)" [attr.aria-label]="ariaQuitarCola(c?.name ?? '')"><app-icon name="close" /></button>
                  </li>
                } @empty {
                  <li i18n="@@torneo.tatamis.cola-vacia" class="muted small">Cola vacía.</li>
                }
              </ol>
              @if (dirty().has(t.id)) {
                <div class="row">
                  <button i18n="@@torneo.tatamis.descartar" class="btn sm" (click)="discard(t.id)">Descartar</button>
                  <button i18n="@@torneo.tatamis.guardar-cola" class="btn sm primary" [disabled]="busy()" (click)="saveQueue(t.id)">Guardar cola</button>
                </div>
              }
            </div>
          }
        </div>
      </section>
    }
    <div class="tatamis">
      @for (v of views(); track v.tatami.id) {
        <section class="card tatami">
          <div class="tatami-head">
            <h2>
              {{ v.tatami.name || 'Tatami ' + v.tatami.number }}
              @if (v.tatami.planned_start) {
                <span i18n="@@torneo.tatamis.inicio-2" class="muted small num">· inicio {{ v.tatami.planned_start.slice(11, 16) }}</span>
              }
            </h2>
            <button i18n="@@torneo.tatamis.planilla-pdf" i18n-title="@@torneo.tatamis.registro-oficial-papel-para" class="btn sm ghost" (click)="scoresheet(v.tatami.id)" title="Registro oficial en papel para Shadow Mode"><app-icon name="print" /> Planilla PDF</button>
          </div>
          @if (v.data; as q) {
            @if (q.progress; as pr) {
              <div class="progress" [attr.aria-label]="ariaProgreso(pr.done, pr.total)">
                <div class="bar"><span [style.width.%]="pr.total ? (100 * pr.done) / pr.total : 0"></span></div>
                <span i18n="@@torneo.tatamis.combates" class="small muted num">{{ pr.done }} de {{ pr.total }} combates</span>
              </div>
            }
            <div class="people small">
              <div class="line">
                <span i18n="@@torneo.tatamis.operando-ahora" class="muted">Operando ahora:</span>
                @for (o of q.operators ?? []; track o.user) {
                  <span class="op"><i aria-hidden="true"></i>{{ o.user }}<span class="muted">· {{ o.matches.join(', ') }}</span></span>
                } @empty {
                  <span i18n="@@torneo.tatamis.nadie" class="muted">nadie</span>
                }
                @if ((q.operators?.length ?? 0) > 1) {
                  <span i18n="@@torneo.tatamis.varias-tablets" class="badge yamabuki">varias tablets</span>
                }
              </div>
              @if (q.assigned_operators?.length) {
                <div class="line"><span i18n="@@torneo.tatamis.operadores-tatami" class="muted">Operadores del tatami:</span><span>{{ q.assigned_operators!.join(', ') }}</span></div>
              }
              @if (q.referees?.length) {
                <div class="line">
                  <span i18n="@@torneo.tatamis.arbitros" class="muted">Árbitros:</span>
                  @for (r of q.referees!; track $index) {
                    <span class="ref">{{ r.name }}@if (r.position) {<span class="muted">· {{ r.position }}</span>}</span>
                  }
                </div>
              }
            </div>
            @if (q.conflicts.length) {
              <div class="alert warn small">
                <strong i18n="@@torneo.tatamis.competidores-combates-pendientes">Competidores con combates pendientes en otro tatami:</strong>
                <ul>
                  @for (c of q.conflicts; track c.registration_id) {
                    <li>{{ c.name }}</li>
                  }
                </ul>
              </div>
            }
            <div i18n="@@torneo.tatamis.combate-actual" class="label">Combate actual</div>
            @if (q.current; as cur) {
              <div class="match current">
                <div class="grow">
                  <div class="m-meta"><span i18n="@@torneo.tatamis.curso" class="badge matcha live">En curso</span> <span class="num n">{{ cur.number }}</span> {{ cur.category_name }} <span class="code">{{ cur.match.code }}</span></div>
                  <div class="fighter aka"><span class="pname">{{ pname(q, cur.match.aka_registration_id) }}</span> <small class="muted">{{ pdojo(q, cur.match.aka_registration_id) }}</small><span class="pts num">{{ cur.match.aka_score ?? 0 }}</span></div>
                  <div class="fighter ao"><span class="pname">{{ pname(q, cur.match.ao_registration_id) }}</span> <small class="muted">{{ pdojo(q, cur.match.ao_registration_id) }}</small><span class="pts num">{{ cur.match.ao_score ?? 0 }}</span></div>
                </div>
                <a i18n="@@torneo.tatamis.abrir-mesa" class="btn primary" [routerLink]="['/mesa', cur.match.id]" [queryParams]="{ tatami: v.tatami.id }"><app-icon name="open" /> Abrir mesa</a>
              </div>
            } @else {
              <div i18n="@@torneo.tatamis.ninguno-curso" class="muted small quiet">Ninguno en curso.</div>
            }
            <div i18n="@@torneo.tatamis.siguiente-espera" class="label">Siguiente y en espera</div>
            @for (it of waiting(q); track it.match.id; let i = $index) {
              <div class="match" [class.next]="i === 0">
                <div class="grow">
                  <div class="m-meta">
                    @if (i === 0) {
                      <span i18n="@@torneo.tatamis.siguiente" class="badge ai">Siguiente</span>
                    }
                    <span class="num n">{{ it.number }}</span> {{ it.category_name }} <span class="code">{{ it.match.code }}</span>
                    @if (it.eta) {
                      <span i18n-title="@@torneo.tatamis.hora-estimada-inicio" class="eta num" title="Hora estimada de inicio">≈ {{ hour(it.eta) }}</span>
                    }
                    @if (it.match.status !== 'ready') {
                      <app-status [status]="it.match.status" type="match" />
                    }
                  </div>
                  <div class="fighter aka"><span class="pname">{{ pname(q, it.match.aka_registration_id) }}</span> <small class="muted">{{ pdojo(q, it.match.aka_registration_id) }}</small></div>
                  <div class="fighter ao"><span class="pname">{{ pname(q, it.match.ao_registration_id) }}</span> <small class="muted">{{ pdojo(q, it.match.ao_registration_id) }}</small></div>
                </div>
                <a i18n="@@torneo.tatamis.mesa" class="btn sm" [routerLink]="['/mesa', it.match.id]" [queryParams]="{ tatami: v.tatami.id }">Mesa</a>
              </div>
            } @empty {
              <div i18n="@@torneo.tatamis.cola-vacia" class="muted small quiet">Cola vacía.</div>
            }
          } @else if (v.error) {
            <div class="alert danger small">{{ v.error }}</div>
          } @else {
            <span class="spinner"></span>
          }
        </section>
      } @empty {
        <div class="card empty"><p><strong i18n="@@torneo.tatamis.torneo-no-tiene-tatamis">El torneo no tiene tatamis.</strong></p><ng-container i18n="@@torneo.tatamis.agrega-uno-para-empezar">Agrega uno para empezar a programar combates.</ng-container></div>
      }
    </div>
  `,
  styles: `
    .sched-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 0.75rem 1rem;
      align-items: end;
      margin-top: 0.75rem;
      .end {
        justify-content: flex-end;
      }
    }
    .sched-list {
      margin-top: 0.75rem;
      li {
        border-bottom: 1px solid var(--kasumi);
        padding: 0.35rem 0;
      }
      label.field.inline {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        margin: 0;
        flex-wrap: wrap;
      }
    }
    .eta {
      margin-left: auto;
      color: var(--ai-ink, var(--ai));
      font-weight: 700;
    }
    .tatamis {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
      gap: 1.25rem;
      align-items: start;
    }
    @media (max-width: 767px) {
      .tatamis {
        grid-template-columns: 1fr;
      }
    }
    .tatami {
      margin: 0;
    }
    .planner h2 {
      margin-bottom: 0.25rem;
    }
    .plan-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 1.25rem;
      margin-top: 1rem;
      align-items: start;
    }
    .plan-col h3 {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 0.4rem;
      margin: 0 0 0.5rem;
      font-size: var(--fs-16);
    }
    .plan-list {
      max-height: 22rem;
      overflow-y: auto;
      li {
        display: flex;
        align-items: center;
        gap: 0.35rem;
        min-height: 2.75rem;
        padding: 0.2rem 0;
        border-bottom: 1px solid var(--kasumi);
      }
      label.field.inline {
        flex: 1;
        min-height: 2.75rem;
        margin: 0;
      }
    }
    .all {
      margin-bottom: 0.25rem;
    }
    .est {
      color: var(--nezumi-ink);
      font-size: var(--fs-12);
      white-space: nowrap;
      margin-left: 0.35rem;
    }
    .pos {
      min-width: 1.5rem;
      font-weight: 700;
      color: var(--nezumi-ink);
    }
    .assign {
      margin-top: 0.75rem;
      flex-wrap: wrap;
      select {
        flex: 1;
        min-width: 8rem;
      }
    }
    .progress {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      margin: 0.35rem 0 0.5rem;
      .bar {
        flex: 1;
        height: 6px;
        border-radius: 3px;
        background: var(--kasumi);
        overflow: hidden;
        span {
          display: block;
          height: 100%;
          border-radius: 3px;
          background: var(--matcha);
        }
      }
    }
    .people {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
      margin-bottom: 0.5rem;
      .line {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.2rem 0.6rem;
      }
      .op,
      .ref {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
      }
      .op i {
        display: inline-block;
        width: 7px;
        height: 7px;
        margin-right: 0.3rem;
        border-radius: 50%;
        background: var(--matcha);
        vertical-align: middle;
      }
    }
    .pts {
      margin-left: auto;
      padding-left: 0.75rem;
      font-weight: 800;
      font-size: 1.1rem;
    }
    .tatami-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      margin-bottom: 0.25rem;
      h2 {
        margin: 0;
      }
    }
    .label {
      font-size: var(--fs-12);
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--nezumi-ink);
      margin: 1.25rem 0 0.5rem;
    }
    .quiet {
      padding: 0.25rem 0;
    }
    .match {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.75rem 0.85rem;
      border: 1px solid var(--kasumi);
      border-radius: var(--radius-sm);
      margin-bottom: 0.5rem;
      background: var(--kinu);
      font-size: var(--fs-14);
    }
    .match.current {
      border-color: color-mix(in srgb, var(--matcha) 45%, var(--kasumi));
      background: color-mix(in srgb, var(--matcha-soft) 55%, var(--kinu));
    }
    .match.next {
      border-color: color-mix(in srgb, var(--ai) 35%, var(--kasumi));
    }
    .m-meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.4rem;
      margin-bottom: 0.4rem;
      color: var(--sumi-2);
      .n {
        font-weight: 700;
        color: var(--sumi);
      }
    }
    .fighter {
      display: flex;
      align-items: baseline;
      gap: 0.35rem;
      padding: 0.1rem 0 0.1rem 0.65rem;
      border-left: 3px solid transparent;
      line-height: 1.5;
      &.aka {
        border-left-color: var(--shu);
      }
      &.ao {
        border-left-color: var(--ai);
      }
      .pname {
        font-weight: 500;
      }
      small {
        margin-left: 0.4rem;
      }
    }
  `,
})
export class TatamisTab {
  ariaHoraInicio = (tatami: string) => $localize`:@@torneo.tatamis.hora-inicio-de:Hora de inicio de ${tatami}:tatami:`;
  ariaSubir = (categoria: string) => $localize`:@@torneo.tatamis.subir:Subir ${categoria}:categoria:`;
  ariaBajar = (categoria: string) => $localize`:@@torneo.tatamis.bajar:Bajar ${categoria}:categoria:`;
  ariaQuitarCola = (categoria: string) => $localize`:@@torneo.tatamis.quitar-cola:Quitar ${categoria}:categoria: de la cola`;
  ariaProgreso = (hechos: number, total: number) => $localize`:@@torneo.tatamis.progreso:${hechos}:hechos: de ${total}:total: combates`;
  readonly ctx = inject(TournamentContext);
  private api = inject(ApiService);
  private files = inject(FilesService);
  private mut = inject(MutationService);
  private dialog = inject(DialogService);
  readonly views = signal<TatamiView[]>([]);

  // --- Horarios estimados (PATCH /tournaments/{id}/schedule y /tatamis/{id}) ---
  readonly scheduling = signal(false);
  sched = { overhead: 60, timezone: 'America/Lima' };
  readonly zones = computed(() => {
    const cur = this.ctx.tournament()?.timezone ?? 'America/Lima';
    return [...new Set([cur, ...TIMEZONES])];
  });

  toggleScheduling(): void {
    const t = this.ctx.tournament();
    this.sched = { overhead: t?.match_overhead_seconds ?? 60, timezone: t?.timezone ?? 'America/Lima' };
    this.scheduling.set(!this.scheduling());
  }

  async saveSettings(): Promise<void> {
    this.busy.set(true);
    const res = await this.mut.patch<Tournament>(
      `/tournaments/${this.ctx.id()}/schedule`,
      { timezone: this.sched.timezone, match_overhead_seconds: Number(this.sched.overhead) || 0 },
      { success: $localize`:@@torneo.tatamis.horarios-guardados:Horarios guardados` },
    );
    this.busy.set(false);
    if (res) this.ctx.tournament.set(res);
  }

  async savePlanned(t: Tatami, value: string): Promise<void> {
    const res = await this.mut.patch<Tatami>(
      `/tatamis/${t.id}`,
      { planned_start: value || null },
      { success: value ? $localize`:@@torneo.tatamis.inicio-guardado:Inicio de ${t.name || 'Tatami ' + t.number}:tatami: guardado` : $localize`:@@torneo.tatamis.hora-inicio-quitada:Hora de inicio quitada` },
    );
    if (res) this.load();
  }

  hour(iso: string | null | undefined): string {
    return hourText(iso, zoneOfIso(iso));
  }

  constructor() {
    this.load();
    const timer = setInterval(() => this.load(), 15000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  // --- Colas de categorías (PUT /tatamis/{id}/queue) ---
  readonly planning = signal(false);
  readonly busy = signal(false);
  /** Cola local por tatami (ids de categoría en orden); las no guardadas se marcan en `dirty`. */
  readonly queues = signal<Record<number, number[]>>({});
  readonly dirty = signal(new Set<number>());
  readonly picked = signal(new Set<number>());
  readonly target = signal(0);

  /** Categorías que pueden ir a una cola: con inscritos y no fusionadas ni canceladas. */
  private readonly schedulable = computed(() =>
    this.ctx.categories().filter((c) => !['merged', 'cancelled', 'empty'].includes(c.status) && c.entrant_count > 0),
  );
  readonly unassigned = computed(() => {
    const inQueue = new Set(Object.values(this.queues()).flat());
    return this.schedulable().filter((c) => !inQueue.has(c.id));
  });
  readonly unassignedWithBracket = computed(
    () => this.schedulable().filter((c) => !c.tatami_id && ['ready', 'in_progress'].includes(c.status)).length,
  );

  /** Rearma las colas desde el servidor, sin pisar las que tienen cambios sin guardar. */
  private syncQueues(): void {
    const tatamis = this.ctx.tournament()?.tatamis ?? [];
    const dirty = this.dirty();
    const prev = this.queues();
    const next: Record<number, number[]> = {};
    for (const t of tatamis) {
      next[t.id] = dirty.has(t.id)
        ? (prev[t.id] ?? [])
        : this.ctx
            .categories()
            .filter((c) => c.tatami_id === t.id && !['merged', 'cancelled'].includes(c.status))
            .sort((a, b) => (a.queue_position ?? 1e6) - (b.queue_position ?? 1e6) || a.id - b.id)
            .map((c) => c.id);
    }
    this.queues.set(next);
    if (!this.target() || !tatamis.some((t) => t.id === this.target())) this.target.set(tatamis[0]?.id ?? 0);
  }

  queueOf(tid: number): number[] {
    return this.queues()[tid] ?? [];
  }

  est(c: Category): number {
    const t = this.ctx.tournament();
    return estimateMatches(
      c.entrant_count,
      c.format ?? t?.default_format,
      c.third_place_rule ?? t?.default_third_place_rule,
    );
  }

  queueTotal(tid: number): number {
    const byId = this.ctx.categoryById();
    return this.queueOf(tid).reduce((n, cid) => n + (byId.get(cid) ? this.est(byId.get(cid)!) : 0), 0);
  }

  tatamiLabel(tid: number): string {
    const t = this.ctx.tournament()?.tatamis.find((x) => x.id === tid);
    return t ? t.name || $localize`:@@torneo.tatamis.tatami:Tatami ${t.number}:number:` : 'tatami';
  }

  togglePick(cid: number): void {
    const s = new Set(this.picked());
    if (s.has(cid)) s.delete(cid);
    else s.add(cid);
    this.picked.set(s);
  }

  pickAll(on: boolean): void {
    this.picked.set(new Set(on ? this.unassigned().map((c) => c.id) : []));
  }

  private setQueue(tid: number, ids: number[]): void {
    this.queues.update((q) => ({ ...q, [tid]: ids }));
    this.dirty.update((d) => new Set(d).add(tid));
  }

  move(tid: number, i: number, delta: -1 | 1): void {
    this.setQueue(tid, moveItem(this.queueOf(tid), i, delta));
  }

  remove(tid: number, cid: number): void {
    this.setQueue(
      tid,
      this.queueOf(tid).filter((x) => x !== cid),
    );
  }

  discard(tid: number): void {
    this.dirty.update((d) => {
      const s = new Set(d);
      s.delete(tid);
      return s;
    });
    this.syncQueues();
  }

  async assignPicked(): Promise<void> {
    const tid = this.target();
    const add = this.unassigned()
      .filter((c) => this.picked().has(c.id))
      .map((c) => c.id);
    if (!tid || !add.length) return;
    this.setQueue(tid, appendUnique(this.queueOf(tid), add));
    this.picked.set(new Set());
    const asignadas = plural(
      add.length,
      $localize`:@@torneo.tatamis.categoria-asignada:categoría asignada`,
      $localize`:@@torneo.tatamis.categorias-asignadas:categorías asignadas`,
    );
    await this.saveQueue(tid, $localize`:@@torneo.tatamis.asignadas-a:${asignadas}:asignadas: a ${this.tatamiLabel(tid)}:tatami:`);
  }

  async saveQueue(tid: number, success = $localize`:@@torneo.tatamis.cola-guardada:Cola guardada`): Promise<void> {
    this.busy.set(true);
    const res = await this.mut.put<Category[]>(`/tatamis/${tid}/queue`, { category_ids: this.queueOf(tid) }, { success });
    this.busy.set(false);
    if (!res) return;
    this.dirty.update((d) => {
      const s = new Set(d);
      s.delete(tid);
      return s;
    });
    await this.ctx.loadCategories();
    this.syncQueues();
    this.load();
  }

  async load(): Promise<void> {
    await Promise.all([this.ctx.reload(), this.ctx.loadCategories()]);
    this.syncQueues();
    const tatamis = this.ctx.tournament()?.tatamis ?? [];
    const views = await Promise.all(
      tatamis.map(async (t): Promise<TatamiView> => {
        try {
          return { tatami: t, data: await firstValueFrom(this.api.get<TatamiQueue>(`/tatamis/${t.id}/queue`)) };
        } catch (e: any) {
          return { tatami: t, data: null, error: e?.message ?? $localize`:@@torneo.tatamis.error:Error` };
        }
      }),
    );
    this.views.set(views);
  }

  waiting(q: TatamiQueue): QueueItem[] {
    return q.queue.filter((it) => it.match.id !== q.current?.match.id);
  }

  scoresheet(tatamiId: number): void {
    this.files.open(`/tatamis/${tatamiId}/scoresheet.pdf`);
  }

  pname(q: TatamiQueue, rid: number | null): string {
    if (!rid) return $localize`:@@torneo.tatamis.definir:Por definir`;
    const p = q.participants[rid];
    return p ? p.name : `#${rid}`;
  }

  pdojo(q: TatamiQueue, rid: number | null): string {
    return rid ? (q.participants[rid]?.dojo_name ?? '') : '';
  }

  async addTatami(): Promise<void> {
    const n = (this.ctx.tournament()?.tatamis.length ?? 0) + 1;
    const name = await this.dialog.prompt({ title: $localize`:@@torneo.tatamis.agregar-tatami-2:Agregar tatami`, label: $localize`:@@torneo.tatamis.nombre:Nombre`, minLength: 1, initial: $localize`:@@torneo.tatamis.tatami-2:Tatami ${n}:n:` });
    if (!name) return;
    const res = await this.mut.post(`/tournaments/${this.ctx.id()}/tatamis`, { name }, { success: $localize`:@@torneo.tatamis.tatami-agregado:Tatami agregado` });
    if (res) this.load();
  }
}
