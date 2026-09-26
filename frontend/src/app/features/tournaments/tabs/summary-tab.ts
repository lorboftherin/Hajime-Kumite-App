import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../../core/api.service';
import { AuthService } from '../../../core/auth.service';
import { DialogService } from '../../../core/dialog.service';
import { CATEGORY_STATUS, FORMAT_LABEL, THIRD_PLACE_LABEL, TOURNAMENT_STATUS } from '../../../core/format';
import { Registration, Template, Tournament } from '../../../core/models';
import { MutationService } from '../../../core/mutation.service';
import { ToastService } from '../../../core/toast.service';
import { StatusBadge } from '../../../shared/badge';
import { Icon } from '../../../shared/icon';
import { Modal } from '../../../shared/modal';
import { MoreMenu } from '../../../shared/more-menu';
import { DatePipe, LabelPipe } from '../../../shared/pipes';
import { TournamentContext } from '../tournament-context';
import { TournamentRules } from '../tournament-rules';
import { etiquetas } from '../../../core/i18n/etiquetas';

/** Verificación previa al inicio (GET /tournaments/{tid}/readiness). */
interface ReadinessIssue {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  items: string[];
}
interface Readiness {
  ready: boolean;
  issues: ReadinessIssue[];
}

const SEVERITY_LABEL: Record<ReadinessIssue['severity'], string> = etiquetas(() => ({
  error: $localize`:@@torneo.resumen.importante:Importante`,
  warning: $localize`:@@torneo.resumen.revisar:Revisar`,
  info: $localize`:@@torneo.resumen.aviso:Aviso`,
}));
/** Dónde se resuelve cada problema. */
const ISSUE_LINK: Record<string, { path: string; label: string }> = etiquetas(() => ({
  NO_BRACKET: { path: '../categorias', label: $localize`:@@torneo.resumen.ir-categorias:Ir a Categorías` },
  SINGLE_ENTRANT: { path: '../categorias', label: $localize`:@@torneo.resumen.ir-categorias:Ir a Categorías` },
  NO_TATAMI: { path: '../tatamis', label: $localize`:@@torneo.resumen.organizar-colas:Organizar colas` },
  TATAMI_WITHOUT_CATEGORIES: { path: '../tatamis', label: $localize`:@@torneo.resumen.organizar-colas:Organizar colas` },
  NO_TATAMIS: { path: '../tatamis', label: $localize`:@@torneo.resumen.ir-tatamis:Ir a Tatamis` },
  MINOR_WITHOUT_CONSENT: { path: '../inscripciones', label: $localize`:@@torneo.resumen.ir-inscripciones:Ir a Inscripciones` },
}));

interface Transition {
  to: string;
  label: string;
  reopen?: boolean;
  danger?: boolean;
}

/** Acciones sugeridas por estado (solo presentación; el servidor valida la transición). */
const NEXT: Record<string, Transition[]> = etiquetas(() => ({
  draft: [
    { to: 'registration_open', label: $localize`:@@torneo.resumen.abrir-inscripciones:Abrir inscripciones` },
    { to: 'cancelled', label: $localize`:@@torneo.resumen.cancelar-torneo:Cancelar torneo`, danger: true },
  ],
  registration_open: [
    { to: 'registration_closed', label: $localize`:@@torneo.resumen.cerrar-inscripciones:Cerrar inscripciones` },
    { to: 'cancelled', label: $localize`:@@torneo.resumen.cancelar-torneo:Cancelar torneo`, danger: true },
  ],
  registration_closed: [
    { to: 'in_progress', label: $localize`:@@torneo.resumen.iniciar-torneo:Iniciar torneo` },
    { to: 'registration_open', label: $localize`:@@torneo.resumen.reabrir-inscripciones:Reabrir inscripciones` },
  ],
  in_progress: [{ to: 'finished', label: $localize`:@@torneo.resumen.finalizar-torneo:Finalizar torneo` }],
  finished: [{ to: 'in_progress', label: $localize`:@@torneo.resumen.reabrir-torneo-auditado:Reabrir torneo (auditado)`, reopen: true }],
  cancelled: [],
}));

/** Qué sigue en cada estado (Zanshin: el paso siguiente siempre a la vista). */
const HINT: Record<string, string> = etiquetas(() => ({
  draft: $localize`:@@torneo.resumen.prepara-categorias-datos-luego:Prepara categorías y datos; luego abre las inscripciones.`,
  registration_open: $localize`:@@torneo.resumen.dojos-pueden-inscribir-cierra:Los dojos pueden inscribir. Cierra las inscripciones para generar las llaves.`,
  registration_closed: $localize`:@@torneo.resumen.genera-llaves-asigna-tatamis:Genera las llaves y asigna tatamis; después inicia el torneo.`,
  in_progress: $localize`:@@torneo.resumen.combates-registran-desde-pestana:Los combates se registran desde la pestaña Tatamis.`,
  finished: $localize`:@@torneo.resumen.resultados-medallero-publicados:Resultados y medallero publicados.`,
  cancelled: $localize`:@@torneo.resumen.torneo-fue-cancelado:El torneo fue cancelado.`,
}));

@Component({
  selector: 'app-summary-tab',
  imports: [FormsModule, RouterLink, StatusBadge, Modal, DatePipe, LabelPipe, MoreMenu, Icon, TournamentRules],
  template: `
    @if (ctx.tournament(); as t) {
      <div class="overview">
        <section class="card state">
          <h3 i18n="@@torneo.resumen.estado">Estado</h3>
          <div class="state-line">
            <app-status [status]="t.status" type="tournament" />
            <span i18n="@@torneo.resumen.version" class="muted tiny">versión {{ t.version }}</span>
          </div>
          <p class="next small">{{ nextHint(t.status) }}</p>
          <div class="row actions">
            @for (tr of mainTransitions(); track tr.to; let first = $first) {
              <button class="btn" [class.primary]="first" (click)="changeStatus(tr)">{{ tr.label }}</button>
            } @empty {
              @if (!dangerTransitions().length) {
                <span i18n="@@torneo.resumen.sin-acciones-disponibles" class="muted small">Sin acciones disponibles.</span>
              }
            }
            @if (dangerTransitions().length) {
              <app-more i18n-label="@@torneo.resumen.mas-acciones-torneo" label="Más acciones del torneo">
                @for (tr of dangerTransitions(); track tr.to) {
                  <button class="menu-item danger" (click)="changeStatus(tr)">{{ tr.label }}</button>
                }
              </app-more>
            }
          </div>
          @if (t.status === 'finished' && !auth.isAdmin()) {
            <p i18n="@@torneo.resumen.solo-admin-global-puede-reabrir" class="hint">Solo el Admin Global puede reabrir un torneo finalizado.</p>
          }
        </section>

        <section class="card kpi">
          <h3 i18n="@@torneo.resumen.inscripciones">Inscripciones</h3>
          <div class="figure">{{ activeRegs() }}</div>
          <div i18n="@@torneo.resumen.activas-retiradas" class="muted small">activas · {{ withdrawnRegs() }} retiradas</div>
          <div class="row actions">
            <a i18n="@@torneo.resumen.inscribir" class="btn sm" routerLink="../inscripciones">Inscribir</a>
            <a i18n="@@torneo.resumen.importar-excel" class="btn sm ghost" routerLink="../importar"><app-icon name="upload" /> Importar Excel</a>
          </div>
        </section>

        <section class="card kpi">
          <h3 i18n="@@torneo.resumen.categorias">Categorías</h3>
          <div class="figure">{{ ctx.categories().length }}</div>
          <ul class="stats">
            @for (s of catStats(); track s.status) {
              <li><app-status [status]="s.status" /><span class="num">{{ s.count }}</span></li>
            }
          </ul>
          <div class="row actions">
            <a i18n="@@torneo.resumen.ver-categorias" class="btn sm" routerLink="../categorias">Ver categorías</a>
            <app-more i18n-label="@@torneo.resumen.mas-acciones-categorias" label="Más acciones de categorías">
              <button i18n="@@torneo.resumen.generar-desde-plantilla" class="menu-item" (click)="openGenerate()"><app-icon name="plus" /> Generar desde plantilla</button>
            </app-more>
          </div>
        </section>
      </div>

      <section class="card general">
        <div class="general-head">
          <h3 i18n="@@torneo.resumen.datos-generales">Datos generales</h3>
          <button i18n="@@torneo.resumen.editar-datos" class="btn sm" (click)="openEdit(t)">Editar datos</button>
        </div>
        <dl class="dl cols">
          <div><dt i18n="@@torneo.resumen.fechas">Fechas</dt><dd class="num">{{ t.start_date | fdate }}@if (t.end_date) { – {{ t.end_date | fdate }} }</dd></div>
          <div><dt i18n="@@torneo.resumen.sede">Sede</dt><dd>{{ t.venue || '—' }}, {{ t.city || '—' }}</dd></div>
          <div><dt i18n="@@torneo.resumen.referencia-edad">Referencia de edad</dt><dd class="num">{{ t.age_reference_date | fdate }}</dd></div>
          <div><dt i18n="@@torneo.resumen.formato-defecto">Formato por defecto</dt><dd>{{ t.default_format | label: formatLabel }}</dd></div>
          <div><dt i18n="@@torneo.resumen.terceros-lugares">Terceros lugares</dt><dd>{{ t.default_third_place_rule | label: thirdLabel }}</dd></div>
          <div><dt i18n="@@torneo.resumen.tatamis">Tatamis</dt><dd class="num">{{ t.tatamis.length }}</dd></div>
        </dl>
      </section>

      <app-tournament-rules />

      <section class="card live" aria-labelledby="live-title">
        <div class="general-head">
          <div>
            <h3 i18n="@@torneo.resumen.seguimiento-vivo-transmision" id="live-title">Seguimiento en vivo y transmisión</h3>
            <p i18n="@@torneo.resumen.pagina-publica-para-familias" class="small muted">
              Una página pública para familias y público, y un marcador para transmitir en vivo con OBS o vMix.
              Sin inicio de sesión: quien tenga el enlace puede verla.
            </p>
          </div>
          @if (t.public_token) {
            <button i18n="@@torneo.resumen.desactivar" class="btn sm" (click)="setPublic(false)">Desactivar</button>
          } @else {
            <button i18n="@@torneo.resumen.activar" class="btn sm primary" (click)="setPublic(true)">Activar</button>
          }
        </div>
        @if (t.public_token) {
          <div class="live-grid">
            <label class="field">
              <span i18n="@@torneo.resumen.nombres-vista-publica">Nombres en la vista pública</span>
              <select [ngModel]="t.public_names" (ngModelChange)="setPublic(true, $event)">
                <option i18n="@@torneo.resumen.abreviados-diego-r-recomendado" value="short">Abreviados: «Diego R.» (recomendado para menores)</option>
                <option i18n="@@torneo.resumen.completos" value="full">Completos</option>
              </select>
            </label>
            <div class="field">
              <span i18n="@@torneo.resumen.pagina-publica-direccion-fija">Página pública (dirección fija, para compartir)</span>
              @if (t.public_slug && !editingSlug()) {
                <div class="row">
                  <input i18n-aria-label="@@torneo.resumen.direccion-fija-pagina-publica" readonly [value]="slugUrl(t.public_slug)" (focus)="$any($event.target).select()" aria-label="Dirección fija de la página pública" />
                  <button i18n="@@torneo.resumen.copiar" class="btn sm" (click)="copy(slugUrl(t.public_slug))">Copiar</button>
                  <a i18n="@@torneo.resumen.abrir" class="btn sm" [href]="slugUrl(t.public_slug)" target="_blank" rel="noopener">Abrir</a>
                  <button i18n="@@torneo.resumen.cambiar" class="btn sm ghost" (click)="startSlug(t.public_slug)">Cambiar</button>
                </div>
              } @else {
                <form class="row" (ngSubmit)="saveSlug()">
                  <span class="prefix muted small">{{ origin }}/t/</span>
                  <input i18n-placeholder="@@torneo.resumen.copa-lima-2026" i18n-aria-label="@@torneo.resumen.direccion-fija" name="slug" [(ngModel)]="slugDraft" aria-label="Dirección fija" placeholder="copa-lima-2026" />
                  <button i18n="@@torneo.resumen.guardar" class="btn sm primary">Guardar</button>
                  @if (t.public_slug) {<button i18n="@@torneo.resumen.cancelar" type="button" class="btn sm" (click)="editingSlug.set(false)">Cancelar</button>}
                </form>
                <span i18n="@@torneo.resumen.minusculas-sin-tildes-numeros" class="small muted">Minúsculas sin tildes, números y guiones.</span>
              }
            </div>
          </div>
          <div class="field overlays">
            <span i18n="@@torneo.resumen.enlace-secreto-vivo-siempre">Enlace secreto del vivo (el de siempre; sigue funcionando)</span>
            <ul>
              <li>
                <code>{{ publicUrl(t.public_token) }}</code>
                <button i18n="@@torneo.resumen.copiar" class="btn sm ghost" (click)="copy(publicUrl(t.public_token))">Copiar</button>
              </li>
            </ul>
          </div>
          <div class="field overlays">
            <span i18n="@@torneo.resumen.pantallas-coliseo-tv-pantalla">Pantallas del coliseo (TV a pantalla completa, sin interacción)</span>
            <ul>
              <li>
                <strong i18n="@@torneo.resumen.todos-tatamis">Todos los tatamis</strong>
                <code>{{ screenUrl(t.public_token) }}</code>
                <button i18n="@@torneo.resumen.copiar" class="btn sm ghost" (click)="copy(screenUrl(t.public_token))">Copiar</button>
              </li>
              @for (tat of t.tatamis; track tat.id) {
                <li>
                  <strong>{{ tat.name }}</strong>
                  <code>{{ screenUrl(t.public_token, tat.id) }}</code>
                  <button i18n="@@torneo.resumen.copiar" class="btn sm ghost" (click)="copy(screenUrl(t.public_token, tat.id))">Copiar</button>
                </li>
              }
            </ul>
          </div>
          @if (t.tatamis.length) {
            <div class="field overlays">
              <span i18n="@@torneo.resumen.overlay-transmision-fuente">Overlay de transmisión (fuente de navegador 1920×1080, fondo transparente)</span>
              <ul>
                @for (tat of t.tatamis; track tat.id) {
                  <li>
                    <strong>{{ tat.name }}</strong>
                    <code>{{ overlayUrl(t.public_token, tat.id) }}</code>
                    <button i18n="@@torneo.resumen.copiar" class="btn sm ghost" (click)="copy(overlayUrl(t.public_token, tat.id))">Copiar</button>
                  </li>
                }
              </ul>
            </div>
          }
          <p class="small muted"><ng-container i18n="@@torneo.resumen.solo-publican-nombres-dojos">
            Solo se publican nombres, dojos, marcadores, horarios estimados, llaves, resultados y medallero; nunca documentos
            ni fechas de nacimiento.
            </ng-container>@if (!t.is_test) {<ng-container i18n="@@torneo.resumen.aparece-torneos-publicos">Aparece en <a routerLink="/torneos-publicos" target="_blank">Torneos públicos</a>.</ng-container>}
            <ng-container i18n="@@torneo.resumen.cambiar-enlace-secreto-si"><button class="linkish" (click)="regenerate()">Cambiar el enlace secreto</button> si se compartió por error.
          </ng-container></p>
        }
      </section>
    }

    @if (edit(); as f) {
      <app-modal i18n-title="@@torneo.resumen.editar-torneo" title="Editar torneo" (closed)="edit.set(null)">
        <form (ngSubmit)="saveEdit(f)" class="stack">
          <label class="field"><span i18n="@@torneo.resumen.nombre">Nombre</span><input name="n" [(ngModel)]="f.name" /></label>
          <div class="grid-2">
            <label class="field"><span i18n="@@torneo.resumen.inicio">Inicio</span><input type="date" name="s" [(ngModel)]="f.start_date" /></label>
            <label class="field"><span i18n="@@torneo.resumen.fin">Fin</span><input type="date" name="e" [(ngModel)]="f.end_date" /></label>
            <label class="field"><span i18n="@@torneo.resumen.sede">Sede</span><input name="v" [(ngModel)]="f.venue" /></label>
            <label class="field"><span i18n="@@torneo.resumen.ciudad">Ciudad</span><input name="c" [(ngModel)]="f.city" /></label>
            <label class="field"><span i18n="@@torneo.resumen.referencia-edad">Referencia de edad</span><input type="date" name="a" [(ngModel)]="f.age_reference_date" /></label>
            <label class="field">
              <span i18n="@@torneo.resumen.terceros-lugares">Terceros lugares</span>
              <select name="tp" [(ngModel)]="f.default_third_place_rule">
                <option i18n="@@torneo.resumen.dos-bronces" value="two_bronzes">Dos bronces</option>
                <option i18n="@@torneo.resumen.combate-3" value="third_place_match">Combate por el 3.º</option>
                <option i18n="@@torneo.resumen.repechaje" value="repechage">Repechaje</option>
              </select>
            </label>
          </div>
          <label i18n="@@torneo.resumen.torneo-prueba" class="field inline"><input type="checkbox" name="t" [(ngModel)]="f.is_test" /> Torneo de prueba</label>
          <div class="form-actions">
            <button i18n="@@torneo.resumen.cancelar" type="button" class="btn" (click)="edit.set(null)">Cancelar</button>
            <button i18n="@@torneo.resumen.guardar" class="btn primary">Guardar</button>
          </div>
        </form>
      </app-modal>
    }

    @if (check(); as ck) {
      <app-modal i18n-title="@@torneo.resumen.antes-iniciar-torneo" title="Antes de iniciar el torneo" [wide]="true" (closed)="closeCheck(false)">
        @if (ck.data.issues.length) {
          <p class="small">
            @if (ck.data.ready) {<ng-container i18n="@@torneo.resumen.no-hay-nada-impida-iniciar-pero">
              No hay nada que impida iniciar, pero conviene revisar:
            </ng-container>} @else {<ng-container i18n="@@torneo.resumen.hay-cosas-conviene-resolver">
              Hay cosas que conviene resolver antes de iniciar: sin ellas, algunos combates no llegarán a las mesas.
            </ng-container>}
          </p>
          <ul class="list-plain issues">
            @for (i of ck.data.issues; track i.code) {
              <li class="issue {{ i.severity }}">
                <span class="badge" [class.shu]="i.severity === 'error'" [class.yamabuki]="i.severity === 'warning'" [class.plain]="i.severity === 'info'">{{ severityLabel[i.severity] }}</span>
                <div class="grow">
                  <div>{{ i.message }}</div>
                  @if (i.items.length) {
                    <div class="small muted">{{ i.items.slice(0, 8).join(' · ') }}@if (i.items.length > 8) {<ng-container i18n="@@torneo.resumen.mas"> · y {{ i.items.length - 8 }} más </ng-container>}</div>
                  }
                </div>
                @if (issueLink[i.code]; as l) {
                  <a class="btn sm ghost" [routerLink]="l.path" (click)="closeCheck(false)">{{ l.label }}</a>
                }
              </li>
            }
          </ul>
        } @else {
          <p i18n="@@torneo.resumen.todo-orden-categorias-llave">Todo en orden: categorías con llave y tatami, y tatamis con operador.</p>
        }
        <div class="form-actions">
          <button i18n="@@torneo.resumen.revisar-primero" class="btn" (click)="closeCheck(false)">Revisar primero</button>
          <button class="btn" [class.danger]="!ck.data.ready" [class.primary]="ck.data.ready" (click)="closeCheck(true)">
            <ng-container i18n="@@torneo.resumen.iniciar-igual-torneo">@if (ck.data.issues.length) {Iniciar igual} @else {Iniciar torneo}</ng-container>
          </button>
        </div>
      </app-modal>
    }

    @if (genOpen()) {
      <app-modal i18n-title="@@torneo.resumen.generar-categorias" title="Generar categorías" (closed)="genOpen.set(false)">
        <p i18n="@@torneo.resumen.copia-categorias-plantilla" class="small muted">Copia las categorías de una plantilla al torneo. Luego puedes editarlas, fusionarlas o cancelarlas.</p>
        <label class="field">
          <span i18n="@@torneo.resumen.plantilla">Plantilla</span>
          <select [(ngModel)]="genTemplate">
            @for (tp of templates(); track tp.id) {
              <option i18n="@@torneo.resumen.categorias-2" [ngValue]="tp.id">{{ tp.name }} ({{ tp.items.length }} categorías)</option>
            }
          </select>
        </label>
        <div class="form-actions">
          <button i18n="@@torneo.resumen.cancelar" class="btn" (click)="genOpen.set(false)">Cancelar</button>
          <button i18n="@@torneo.resumen.generar" class="btn primary" (click)="generate()">Generar</button>
        </div>
      </app-modal>
    }
  `,
  styles: `
    .issues {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      margin: 0.5rem 0 0.25rem;
    }
    .issue {
      display: flex;
      align-items: flex-start;
      gap: 0.6rem;
      padding: 0.6rem 0.75rem;
      border: 1px solid var(--kasumi);
      border-radius: var(--radius-sm);
      background: var(--kinu);
      &.error {
        border-color: color-mix(in srgb, var(--shu) 45%, var(--kasumi));
      }
      .badge {
        flex: none;
      }
    }
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
    .live {
      margin-top: 1.25rem;
      h3 {
        margin: 0;
      }
      p {
        margin: 0.25rem 0 0;
        max-width: 44rem;
      }
    }
    .live-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 2fr);
      gap: 1rem;
      margin: 1rem 0;
      .row {
        display: flex;
        gap: 0.5rem;
        align-items: center;
      }
      input {
        flex: 1;
      }
    }
    .overlays ul {
      list-style: none;
      margin: 0.25rem 0 0.75rem;
      padding: 0;
      li {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.35rem 0;
        border-bottom: 1px solid var(--kasumi);
        flex-wrap: wrap;
      }
      code {
        flex: 1;
        font-size: 0.8rem;
        color: var(--sumi-2);
        word-break: break-all;
      }
    }
    .prefix {
      white-space: nowrap;
    }
    .linkish {
      border: 0;
      background: none;
      padding: 0;
      color: var(--ai-ink, var(--ai));
      text-decoration: underline;
      cursor: pointer;
      font: inherit;
    }
    @media (max-width: 760px) {
      .live-grid {
        grid-template-columns: 1fr;
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
  private toast = inject(ToastService);

  readonly formatLabel = FORMAT_LABEL;
  readonly thirdLabel = THIRD_PLACE_LABEL;
  readonly regs = signal<Registration[]>([]);
  readonly edit = signal<any | null>(null);
  readonly genOpen = signal(false);
  readonly templates = signal<Template[]>([]);
  genTemplate: number | null = null;

  readonly origin = location.origin;
  readonly editingSlug = signal(false);
  slugDraft = '';

  publicUrl(token: string): string {
    return `${location.origin}/vivo/${token}`;
  }

  slugUrl(slug: string): string {
    return `${location.origin}/t/${slug}`;
  }

  screenUrl(token: string, tatami?: number): string {
    return `${location.origin}/pantalla/${token}${tatami ? `/${tatami}` : ''}`;
  }

  startSlug(current: string): void {
    this.slugDraft = current;
    this.editingSlug.set(true);
  }

  async saveSlug(): Promise<void> {
    const slug = this.slugDraft.trim().toLowerCase();
    if (!slug) return;
    if (await this.setPublic(true, undefined, false, slug)) this.editingSlug.set(false);
  }

  overlayUrl(token: string, tatami: number): string {
    return `${location.origin}/overlay/${token}/${tatami}`;
  }

  async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.toast.ok($localize`:@@torneo.resumen.enlace-copiado:Enlace copiado`);
    } catch {
      this.toast.warn($localize`:@@torneo.resumen.no-pudo-copiar-selecciona-enlace:No se pudo copiar: selecciona el enlace y cópialo a mano`);
    }
  }

  async setPublic(enabled: boolean, names?: string, regenerate = false, slug?: string): Promise<boolean> {
    const t = this.ctx.tournament();
    if (!t) return false;
    const body = { enabled, names: names ?? t.public_names ?? 'short', regenerate, ...(slug ? { slug } : {}) };
    const res = await this.mut.put<Tournament>(`/tournaments/${t.id}/public`, body, {
      success: slug ? $localize`:@@torneo.resumen.direccion-guardada:Dirección guardada` : enabled ? $localize`:@@torneo.resumen.seguimiento-vivo-activo:Seguimiento en vivo activo` : $localize`:@@torneo.resumen.seguimiento-vivo-desactivado:Seguimiento en vivo desactivado`,
    });
    if (res) this.ctx.reload();
    return !!res;
  }

  async regenerate(): Promise<void> {
    const ok = await this.dialog.confirm({
      title: $localize`:@@torneo.resumen.cambiar-enlace-publico:Cambiar el enlace público`,
      message: $localize`:@@torneo.resumen.enlace-overlays-actuales-dejaran:El enlace y los overlays actuales dejarán de funcionar. Habrá que compartir los nuevos.`,
      confirmText: $localize`:@@torneo.resumen.cambiar-enlace:Cambiar enlace`,
    });
    if (ok) this.setPublic(true, undefined, true);
  }

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

  // --- Verificación previa a «Iniciar torneo» ---
  readonly severityLabel = SEVERITY_LABEL;
  readonly issueLink = ISSUE_LINK;
  readonly check = signal<{ data: Readiness; resolve: (go: boolean) => void } | null>(null);

  closeCheck(go: boolean): void {
    const c = this.check();
    this.check.set(null);
    c?.resolve(go);
  }

  /** Muestra la verificación previa; true = iniciar. Si falla la consulta, se confirma como siempre. */
  private async readinessOk(t: Tournament): Promise<boolean | null> {
    let data: Readiness;
    try {
      data = await firstValueFrom(this.api.get<Readiness>(`/tournaments/${t.id}/readiness`));
    } catch {
      return null;
    }
    const go = await new Promise<boolean>((resolve) => this.check.set({ data, resolve }));
    if (!go || data.ready) return go;
    // Hay problemas importantes: se confirma una vez más, explícitamente.
    const errors = data.issues.filter((i) => i.severity === 'error').length;
    return this.dialog.confirm({
      title: $localize`:@@torneo.resumen.iniciar-problemas-pendientes:Iniciar con problemas pendientes`,
      message:
        errors === 1
          ? $localize`:@@torneo.resumen.queda-1-problema:Quedan 1 problema importante sin resolver. ¿Iniciar el torneo de todos modos?`
          : $localize`:@@torneo.resumen.quedan-problemas:Quedan ${errors}:n: problemas importantes sin resolver. ¿Iniciar el torneo de todos modos?`,
      danger: true,
      confirmText: $localize`:@@torneo.resumen.iniciar-todos-modos:Iniciar de todos modos`,
      critical: true,
    });
  }

  async changeStatus(tr: Transition): Promise<void> {
    const t = this.ctx.tournament()!;
    let reason: string | null = null;
    const checked = tr.to === 'in_progress' && !tr.reopen ? await this.readinessOk(t) : null;
    if (checked === false) return;
    if (checked === true) {
      // Ya se confirmó en la verificación previa.
    } else if (tr.reopen) {
      reason = await this.dialog.prompt({
        title: $localize`:@@torneo.resumen.reabrir-torneo:Reabrir torneo`,
        message: $localize`:@@torneo.resumen.reabrir-torneo-finalizado-queda:Reabrir un torneo finalizado queda auditado (quién, cuándo y por qué).`,
        label: $localize`:@@torneo.resumen.motivo:Motivo`,
        minLength: 3,
        confirmText: $localize`:@@torneo.resumen.reabrir:Reabrir`,
      });
      if (!reason) return;
    } else {
      const ok = await this.dialog.confirm({
        title: tr.label,
        message: $localize`:@@torneo.resumen.torneo-pasara:El torneo pasará a "${TOURNAMENT_STATUS[tr.to]}:valor:".`,
        danger: tr.danger,
        confirmText: tr.label,
      });
      if (!ok) return;
    }
    const res = await this.mut.patch<Tournament>(
      `/tournaments/${t.id}/status`,
      { status: tr.to, version: t.version, reason },
      { success: $localize`:@@torneo.resumen.estado-actualizado:Estado actualizado`, onConflict: () => this.ctx.reload() },
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
      { success: $localize`:@@torneo.resumen.torneo-actualizado:Torneo actualizado`, onConflict: () => this.ctx.reload() },
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
      this.dialog.alert($localize`:@@torneo.resumen.categorias-generadas:Categorías generadas`, res.created === 1 ? $localize`:@@torneo.resumen.creo-1-categoria:Se creó 1 categoría.` : $localize`:@@torneo.resumen.crearon:Se crearon ${res.created}:n: categorías.`);
    }
  }
}
