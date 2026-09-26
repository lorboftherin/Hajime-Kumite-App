import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../../core/api.service';
import { FilesService } from '../../../core/files.service';
import { CategoryResult, MedalTable, Tournament } from '../../../core/models';
import { MutationService } from '../../../core/mutation.service';
import { StatusBadge } from '../../../shared/badge';
import { Hanko } from '../../../shared/hanko';
import { Icon } from '../../../shared/icon';
import { Modal } from '../../../shared/modal';
import { MoreMenu } from '../../../shared/more-menu';
import { TournamentContext } from '../tournament-context';


@Component({
  selector: 'app-results-tab',
  imports: [FormsModule, RouterLink, StatusBadge, Hanko, Icon, Modal, MoreMenu],
  template: `
    <div class="toolbar">
      <span class="grow"></span>
      <button i18n-aria-label="@@torneo.resultados.actualizar" i18n-title="@@torneo.resultados.actualizar" class="btn icon-only ghost" (click)="load()" title="Actualizar" aria-label="Actualizar"><app-icon name="refresh" /></button>
      <button i18n="@@torneo.resultados.excel" class="btn" (click)="files.download('/tournaments/' + ctx.id() + '/results.xlsx', 'resultados-' + ctx.id() + '.xlsx')"><app-icon name="download" /> Excel</button>
      <button i18n="@@torneo.resultados.pdf" class="btn" (click)="files.open('/tournaments/' + ctx.id() + '/results.pdf')"><app-icon name="print" /> PDF</button>
      <app-more i18n-label="@@torneo.resultados.diplomas-certificados" i18n-text="@@torneo.resultados.diplomas" text="Diplomas" label="Diplomas y certificados" [small]="false">
        <button i18n="@@torneo.resultados.diplomas-dojo" class="menu-item" (click)="dojoOpen.set(true)">Diplomas por dojo…</button>
        <button i18n="@@torneo.resultados.todos-diplomas-torneo" class="menu-item" (click)="files.open('/tournaments/' + ctx.id() + '/diplomas.pdf')">Todos los diplomas del torneo</button>
        <hr />
        <button i18n="@@torneo.resultados.firma-organizador" class="menu-item" (click)="openSigner()">Firma y organizador…</button>
      </app-more>
    </div>
    <div class="layout">
      <section>
        <h2 i18n="@@torneo.resultados.resultados-categoria" class="section-title"><span class="kanji" aria-hidden="true">結果</span> Resultados por categoría</h2>
        @for (c of shown(); track c.category_id) {
          <article class="card cat">
            <header class="cat-head">
              <h3>{{ c.category_name }}</h3>
              <app-status [status]="c.status" />
              @if (['ready', 'in_progress', 'finished'].includes(c.status)) {
                <a i18n="@@torneo.resultados.llave" class="btn sm ghost" [routerLink]="['/categorias', c.category_id, 'llave']">Llave</a>
              }
              @if (c.status === 'finished') {
                <button i18n="@@torneo.resultados.diplomas-esta-categoria" i18n-title="@@torneo.resultados.diplomas-podio-certificados" class="btn sm" (click)="files.open('/categories/' + c.category_id + '/diplomas.pdf')" title="Diplomas de podio y certificados de participación">
                  <app-icon name="print" /> Diplomas de esta categoría
                </button>
              }
            </header>
            @if (c.places.length) {
              <ol i18n-aria-label="@@torneo.resultados.podio" class="podium" aria-label="Podio">
                @for (p of c.places; track p.registration_id) {
                  <li>
                    <app-hanko [place]="p.place" />
                    <span class="pname">{{ p.name }}</span>
                    <a class="dojo" [routerLink]="['/dojos', p.dojo_id]">{{ p.dojo_name }}</a>
                  </li>
                }
              </ol>
            } @else {
              <div i18n="@@torneo.resultados.sin-resultados-todavia" class="muted small">Sin resultados todavía.</div>
            }
          </article>
        } @empty {
          <div class="card empty"><p><strong i18n="@@torneo.resultados.aun-no-hay-resultados">Aún no hay resultados.</strong></p><ng-container i18n="@@torneo.resultados.apareceran-aqui-medida-terminen">Aparecerán aquí a medida que terminen los combates.</ng-container></div>
        }
        @if (pending().length) {
          <details class="pending card quiet">
            <summary i18n="@@torneo.resultados.categorias-aun-sin-resultados">{{ pending().length }} categorías aún sin resultados</summary>
            <ul>
              @for (c of pending(); track c.category_id) {
                <li>
                  <span class="grow">{{ c.category_name }}</span>
                  <app-status [status]="c.status" />
                  @if (['ready', 'in_progress', 'finished'].includes(c.status)) {
                    <a i18n="@@torneo.resultados.llave" class="btn sm ghost" [routerLink]="['/categorias', c.category_id, 'llave']">Llave</a>
                  }
                </li>
              }
            </ul>
          </details>
        }
      </section>
      <section class="medals">
        <h2 i18n="@@torneo.resultados.medallero-dojo" class="section-title">Medallero por dojo</h2>
        @if (medals()?.is_test) {
          <div i18n="@@torneo.resultados.torneo-prueba-medallero-no" class="alert warn small">Torneo de prueba: el medallero no cuenta para historial ni estadísticas.</div>
        }
        <div class="table-wrap">
          <table class="table medal-table">
            <thead>
              <tr>
                <th class="center">#</th>
                <th i18n="@@torneo.resultados.dojo">Dojo</th>
                <th class="center"><span class="ring kin" aria-hidden="true"></span><span i18n="@@torneo.resultados.oro" class="sr-only">Oro</span></th>
                <th class="center"><span class="ring gin" aria-hidden="true"></span><span i18n="@@torneo.resultados.plata" class="sr-only">Plata</span></th>
                <th class="center"><span class="ring dou" aria-hidden="true"></span><span i18n="@@torneo.resultados.bronce" class="sr-only">Bronce</span></th>
                <th i18n="@@torneo.resultados.total" class="right">Total</th>
              </tr>
            </thead>
            <tbody>
              @for (r of medals()?.rows ?? []; track r.dojo_id) {
                <tr>
                  <td class="center rank">{{ r.rank }}</td>
                  <td><a [routerLink]="['/dojos', r.dojo_id]" i18n-title="@@torneo.resultados.historial-dojo" title="{{ r.dojo_name }} · historial del dojo">{{ r.dojo_name }}</a></td>
                  <td class="center" [class.zero]="!r.gold">{{ r.gold }}</td>
                  <td class="center" [class.zero]="!r.silver">{{ r.silver }}</td>
                  <td class="center" [class.zero]="!r.bronze">{{ r.bronze }}</td>
                  <td class="total">{{ r.total }}</td>
                </tr>
              } @empty {
                <tr><td i18n="@@torneo.resultados.sin-medallas-todavia-solo" colspan="6" class="empty">Sin medallas todavía. Solo cuentan las categorías finalizadas.</td></tr>
              }
            </tbody>
          </table>
        </div>
        <p i18n="@@torneo.resultados.oro-plata-bronce" class="hint legend"><span class="ring kin"></span> Oro <span class="ring gin"></span> Plata <span class="ring dou"></span> Bronce</p>
      </section>
    </div>

    @if (dojoOpen()) {
      <app-modal i18n-title="@@torneo.resultados.diplomas-dojo-2" title="Diplomas por dojo" (closed)="dojoOpen.set(false)">
        <div class="stack">
          <p i18n="@@torneo.resultados.todos-diplomas-certificados" class="hint">Todos los diplomas y certificados de los competidores del dojo, de las categorías finalizadas.</p>
          <label class="field">
            <span i18n="@@torneo.resultados.dojo">Dojo</span>
            <select [ngModel]="dojoId()" (ngModelChange)="dojoId.set($event)">
              <option i18n="@@torneo.resultados.elige-dojo" [ngValue]="0" disabled>Elige un dojo…</option>
              @for (d of dojoOptions(); track d.id) {
                <option [ngValue]="d.id">{{ d.name }}</option>
              }
            </select>
          </label>
          <label class="field">
            <span i18n="@@torneo.resultados.incluir">Incluir</span>
            <select [ngModel]="kind()" (ngModelChange)="kind.set($event)">
              <option i18n="@@torneo.resultados.podio-participacion" value="all">Podio y participación</option>
              <option i18n="@@torneo.resultados.solo-podio-oro-plata-bronce" value="podium">Solo podio (oro, plata, bronce)</option>
              <option i18n="@@torneo.resultados.solo-participacion" value="participation">Solo participación</option>
            </select>
          </label>
          <div class="form-actions">
            <button i18n="@@torneo.resultados.abrir-pdf" class="btn primary" [disabled]="!dojoId()" (click)="dojoDiplomas()"><app-icon name="print" /> Abrir PDF</button>
          </div>
        </div>
      </app-modal>
    }

    @if (signerOpen()) {
      <app-modal i18n-title="@@torneo.resultados.firma-diplomas" title="Firma de los diplomas" (closed)="signerOpen.set(false)">
        <form class="stack" (ngSubmit)="saveSigner()">
          <label class="field"><span i18n="@@torneo.resultados.organizador">Organizador</span><input i18n-placeholder="@@torneo.resultados.liga-karate-lima" name="org" [(ngModel)]="signer.certificate_organizer" placeholder="Liga de Karate de Lima" /></label>
          <label class="field"><span i18n="@@torneo.resultados.nombre-quien-firma">Nombre de quien firma</span><input name="sn" [(ngModel)]="signer.certificate_signer_name" /></label>
          <label class="field"><span i18n="@@torneo.resultados.cargo">Cargo</span><input i18n-placeholder="@@torneo.resultados.presidente-liga" name="st" [(ngModel)]="signer.certificate_signer_title" placeholder="Presidente de la liga" /></label>
          <p i18n="@@torneo.resultados.aparecen-pie-cada-diploma-junto" class="hint">Aparecen al pie de cada diploma, junto con el torneo, la ciudad y la fecha.</p>
          <div class="form-actions"><button i18n="@@torneo.resultados.guardar" class="btn primary">Guardar</button></div>
        </form>
      </app-modal>
    }
  `,
  styles: `
    .layout {
      display: grid;
      grid-template-columns: minmax(0, 3fr) minmax(0, 2.25fr);
      gap: 2rem;
      align-items: start;
    }
    @media (max-width: 1000px) {
      .layout {
        grid-template-columns: 1fr;
      }
    }
    .section-title .kanji {
      font-weight: 500;
      color: var(--nezumi);
      font-size: var(--fs-16);
      letter-spacing: 0.1em;
    }
    .cat {
      padding: 1.1rem 1.35rem;
      margin-bottom: 0.9rem;
    }
    .cat-head {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      flex-wrap: wrap;
      h3 {
        margin: 0;
        flex: 1;
        font-size: var(--fs-16);
      }
    }
    .podium {
      list-style: none;
      margin: 0.85rem 0 0;
      padding: 0;
      li {
        display: grid;
        grid-template-columns: 2.25rem minmax(0, 1fr) auto;
        align-items: center;
        gap: 0.75rem;
        padding: 0.5rem 0;
        border-top: 1px solid var(--kasumi);
        font-size: var(--fs-14);
      }
      .pname {
        font-weight: 700;
      }
      .dojo {
        color: var(--nezumi-ink);
        text-align: right;
      }
      .dojo:hover {
        color: var(--ai-ink);
      }
    }
    .pending {
      padding: 0.9rem 1.35rem;
      summary {
        color: var(--sumi-2);
      }
      ul {
        list-style: none;
        margin: 0.75rem 0 0;
        padding: 0;
      }
      li {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.5rem 0;
        border-top: 1px solid var(--kasumi);
        font-size: var(--fs-14);
      }
    }
    .medal-table {
      table-layout: fixed;
      th:first-child,
      td:first-child {
        width: 2.5rem;
        padding-left: 0.9rem;
        padding-right: 0.25rem;
      }
      th:nth-child(2),
      td:nth-child(2) {
        padding-left: 0.6rem;
        padding-right: 0.4rem;
      }
      /* El nombre del dojo ocupa una línea; si no cabe, se corta con puntos suspensivos. */
      td:nth-child(2) a {
        display: block;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      th:nth-child(n + 3):nth-child(-n + 5),
      td:nth-child(n + 3):nth-child(-n + 5) {
        width: 2.4rem;
        padding-left: 0.2rem;
        padding-right: 0.2rem;
      }
      th:last-child,
      td:last-child {
        width: 4.25rem;
        padding-left: 0.4rem;
        padding-right: 1.1rem;
        text-align: right;
      }
      .rank {
        font-family: var(--font-display);
        font-weight: 700;
        color: var(--sumi-2);
      }
      td.zero {
        color: var(--nezumi);
      }
      .total {
        font-weight: 700;
      }
      a {
        color: var(--sumi);
        font-weight: 500;
      }
      a:hover {
        color: var(--ai-ink);
      }
    }
    .ring {
      display: inline-block;
      width: 0.75rem;
      height: 0.75rem;
      border-radius: 50%;
      border: 2.5px solid;
      vertical-align: -0.1rem;
      &.kin {
        border-color: var(--kin);
      }
      &.gin {
        border-color: var(--gin);
      }
      &.dou {
        border-color: var(--dou);
      }
    }
    .legend {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      .ring + .ring,
      .ring {
        margin-left: 0.5rem;
      }
      .ring:first-child {
        margin-left: 0;
      }
    }
  `,
})
export class ResultsTab {
  readonly ctx = inject(TournamentContext);
  readonly files = inject(FilesService);
  private api = inject(ApiService);
  private mut = inject(MutationService);

  // --- Diplomas (derecho «certificates» del plan: sin él, el servidor responde 402) ---
  readonly dojoOpen = signal(false);
  readonly dojoId = signal(0);
  readonly kind = signal<'all' | 'podium' | 'participation'>('all');
  readonly signerOpen = signal(false);
  signer = { certificate_organizer: '', certificate_signer_name: '', certificate_signer_title: '' };
  /** Dojos con algún competidor en el podio o en el medallero. */
  readonly dojoOptions = computed(() => {
    const m = new Map<number, string>();
    for (const c of this.results()) for (const p of c.places) m.set(p.dojo_id, p.dojo_name);
    for (const r of this.medals()?.rows ?? []) m.set(r.dojo_id, r.dojo_name);
    return [...m].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  });

  dojoDiplomas(): void {
    this.files.open(`/tournaments/${this.ctx.id()}/diplomas.pdf`, { dojo_id: this.dojoId(), kind: this.kind() });
    this.dojoOpen.set(false);
  }

  openSigner(): void {
    const t = this.ctx.tournament();
    this.signer = {
      certificate_organizer: t?.certificate_organizer ?? '',
      certificate_signer_name: t?.certificate_signer_name ?? '',
      certificate_signer_title: t?.certificate_signer_title ?? '',
    };
    this.signerOpen.set(true);
  }

  async saveSigner(): Promise<void> {
    const t = this.ctx.tournament();
    if (!t) return;
    const res = await this.mut.patch<Tournament>(
      `/tournaments/${t.id}`,
      { version: t.version, ...this.signer },
      { success: $localize`:@@torneo.resultados.firma-guardada:Firma guardada`, onConflict: () => this.ctx.reload() },
    );
    if (res) {
      this.ctx.tournament.set(res);
      this.signerOpen.set(false);
    }
  }

  readonly results = signal<CategoryResult[]>([]);
  readonly medals = signal<MedalTable | null>(null);
  /** Con podio: a la vista. Sin resultados aún: plegadas al final (revelar de a poco). */
  readonly shown = computed(() => this.results().filter((c) => c.places.length > 0));
  readonly pending = computed(() =>
    this.results().filter((c) => !c.places.length && !['empty', 'merged', 'cancelled'].includes(c.status)),
  );

  constructor() {
    this.load();
  }

  load(): void {
    this.api.get<CategoryResult[]>(`/tournaments/${this.ctx.id()}/results`).subscribe({ next: (r) => this.results.set(r), error: () => {} });
    this.api.get<MedalTable>(`/tournaments/${this.ctx.id()}/medal-table`).subscribe({ next: (m) => this.medals.set(m), error: () => {} });
  }
}
