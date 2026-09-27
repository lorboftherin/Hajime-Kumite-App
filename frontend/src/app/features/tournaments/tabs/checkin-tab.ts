import { Component, ElementRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiError } from '../../../core/api-error';
import { ApiService } from '../../../core/api.service';
import { DialogService } from '../../../core/dialog.service';
import {
  CheckinList,
  CheckinResult,
  CheckinRow,
  CheckinStatus,
  Registration,
  Tournament,
  WeighInItem,
  WeighInOut,
} from '../../../core/models';
import { MutationService } from '../../../core/mutation.service';
import { ToastService } from '../../../core/toast.service';
import { Icon } from '../../../shared/icon';
import { Modal } from '../../../shared/modal';
import {
  CheckinCard,
  CheckinView,
  filterCards,
  groupByPerson,
  looksLikeCode,
  parseWeight,
  rangeText,
} from '../../checkin/checkin-logic';
import { QrScanner, qrScanSupported } from '../../checkin/qr-scanner';
import { TournamentContext } from '../tournament-context';
import { lista } from '../../../core/i18n/etiquetas';

const VIEWS: Array<{ value: CheckinView; label: string }> = lista(() => [
  { value: 'all', label: $localize`:@@torneo.acreditacion.todos:Todos` },
  { value: 'pending', label: $localize`:@@torneo.acreditacion.pendientes-2:Pendientes` },
  { value: 'present', label: $localize`:@@torneo.acreditacion.presentes-3:Presentes` },
  { value: 'absent', label: $localize`:@@torneo.acreditacion.ausentes-3:Ausentes` },
  { value: 'out_of_weight', label: $localize`:@@torneo.acreditacion.fuera-peso:Fuera de peso` },
]);

/**
 * Mesa de acreditación el día del torneo, pensada para una tablet: buscador
 * grande, «Presente» de un toque, peso con teclado numérico y lector de QR.
 */
@Component({
  selector: 'app-checkin-tab',
  imports: [FormsModule, RouterLink, Icon, Modal, QrScanner],
  template: `
    <div class="head-row">
      <div class="totals" aria-live="polite">
        <span i18n="@@torneo.acreditacion.presentes" class="tot present"
          ><strong>{{ data()?.totals?.present ?? 0 }}</strong> presentes</span
        >
        <span i18n="@@torneo.acreditacion.ausentes" class="tot absent"
          ><strong>{{ data()?.totals?.absent ?? 0 }}</strong> ausentes</span
        >
        <span i18n="@@torneo.acreditacion.pendientes" class="tot pending"
          ><strong>{{ data()?.totals?.pending ?? 0 }}</strong> pendientes</span
        >
        @if (data()?.checkin_required) {
          <span i18n="@@torneo.acreditacion.check-in-obligatorio" class="badge yamabuki"
            >Check-in obligatorio</span
          >
        }
      </div>
      <span class="grow"></span>
      <a
        i18n="@@torneo.acreditacion.credenciales"
        class="btn"
        [routerLink]="['/torneos', ctx.id(), 'credenciales']"
        ><app-icon name="print" /> Credenciales</a
      >
      <button
        i18n-aria-label="@@torneo.acreditacion.ajustes-acreditacion"
        i18n-title="@@torneo.acreditacion.ajustes-acreditacion"
        class="btn ghost icon-only"
        (click)="settingsOpen.set(true)"
        title="Ajustes de acreditación"
        aria-label="Ajustes de acreditación"
      >
        <app-icon name="more" />
      </button>
      <button
        i18n-aria-label="@@torneo.acreditacion.actualizar"
        i18n-title="@@torneo.acreditacion.actualizar"
        class="btn ghost icon-only"
        (click)="load()"
        title="Actualizar"
        aria-label="Actualizar"
      >
        <app-icon name="refresh" />
      </button>
    </div>

    <form class="finder" (ngSubmit)="submitSearch()">
      <div class="search big">
        <app-icon name="search" />
        <input
          i18n-aria-label="@@torneo.acreditacion.buscar-nombre-dojo-codigo"
          i18n-placeholder="@@torneo.acreditacion.nombre-dojo-codigo-credencial"
          #finder
          name="q"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          placeholder="Nombre, dojo o código de la credencial…"
          aria-label="Buscar por nombre, dojo o código"
          [ngModel]="q()"
          (ngModelChange)="q.set($event)"
        />
      </div>
      @if (canScan) {
        <button
          i18n="@@torneo.acreditacion.qr"
          i18n-title="@@torneo.acreditacion.leer-qr-credencial-camara"
          type="button"
          class="btn lg"
          (click)="scanOpen.set(true)"
          title="Leer el QR de la credencial con la cámara"
        >
          QR
        </button>
      }
    </form>

    <div class="filters">
      <div
        i18n-aria-label="@@torneo.acreditacion.filtro-estado"
        class="chips"
        role="group"
        aria-label="Filtro por estado"
      >
        @for (v of views; track v.value) {
          <button
            type="button"
            class="chip"
            [class.on]="view() === v.value"
            [attr.aria-pressed]="view() === v.value"
            (click)="view.set(v.value)"
          >
            {{ v.label }}
          </button>
        }
      </div>
      <select
        i18n-aria-label="@@torneo.acreditacion.dojo"
        aria-label="Dojo"
        [ngModel]="dojoId()"
        (ngModelChange)="dojoId.set($event)"
      >
        <option i18n="@@torneo.acreditacion.todos-dojos" [ngValue]="0">Todos los dojos</option>
        @for (d of dojos(); track d.id) {
          <option [ngValue]="d.id">{{ d.name }}</option>
        }
      </select>
      <span i18n="@@torneo.acreditacion.n-personas" class="count">{shown().length, plural,
        =1 {1 persona}
        other {{{ shown().length }} personas}
      }</span>
    </div>

    <div class="layout">
      <section
        i18n-aria-label="@@torneo.acreditacion.competidores"
        class="cards"
        aria-label="Competidores"
      >
        @for (c of shown(); track c.key) {
          <article
            class="pcard"
            [class.present]="c.status === 'present'"
            [class.absent]="c.status === 'absent'"
          >
            <header>
              <div class="who">
                <strong class="pname">{{ c.name }}</strong>
                <span class="muted small"
                  >{{ c.dojo_name }}
                  @if (c.code) {
                    · <span class="mono">{{ c.code }}</span>
                  }
                </span>
              </div>
              <div class="actions">
                <button
                  type="button"
                  class="btn lg tap"
                  [class.primary]="c.status !== 'present'"
                  [class.done]="c.status === 'present'"
                  [disabled]="busy().has(c.key)"
                  (click)="mark(c, c.status === 'present' ? 'pending' : 'present')"
                  [attr.aria-pressed]="c.status === 'present'"
                >
                  @if (c.status === 'present') {
                    <ng-container i18n="@@torneo.acreditacion.presente"
                      ><app-icon name="check" /> Presente
                    </ng-container>
                  } @else {
                    <ng-container i18n="@@torneo.acreditacion.presente-2"> Presente </ng-container>
                  }
                </button>
                <button
                  type="button"
                  class="btn ghost"
                  [disabled]="busy().has(c.key)"
                  (click)="mark(c, c.status === 'absent' ? 'pending' : 'absent')"
                  [attr.aria-pressed]="c.status === 'absent'"
                >
                  <ng-container i18n="@@torneo.acreditacion.deshacer-ausente">{c.status, select,
                    absent {Deshacer ausente}
                    other {Ausente}
                  }</ng-container>
                </button>
              </div>
            </header>
            <ul class="cats">
              @for (r of c.rows; track r.registration_id) {
                <li>
                  <span class="grow">{{ r.category_name }}</span>
                  @if (r.needs_weigh_in) {
                    <span class="muted small nowrap">{{ range(r) }}</span>
                  }
                  @if (r.weigh_in_result === 'over' || r.weigh_in_result === 'under') {
                    <span
                      class="badge"
                      [class.shu]="!r.weigh_in_resolved"
                      [class.nezumi]="r.weigh_in_resolved"
                    >
                      <ng-container i18n="@@torneo.acreditacion.pasado-bajo-peso">
                        @if (r.weigh_in_result === 'over') {
                          Pasado de peso
                        } @else {
                          Bajo el peso
                        }
                        @if (r.weigh_in_resolved) {
                          · aceptado
                        }
                      </ng-container>
                    </span>
                  } @else if (r.weigh_in_result === 'ok') {
                    <span i18n="@@torneo.acreditacion.peso-ok" class="badge matcha">Peso OK</span>
                  }
                  @if (
                    r.checkin_status === 'absent' &&
                    ['ready', 'in_progress'].includes(r.category_status)
                  ) {
                    <button
                      i18n="@@torneo.acreditacion.walkover"
                      i18n-title="@@torneo.acreditacion.retirar-no-presento-dar-walkover"
                      class="btn sm danger quiet"
                      (click)="noShow(r)"
                      title="Retirar con «No se presentó» y dar walkover al rival"
                    >
                      Walkover
                    </button>
                  }
                </li>
              }
            </ul>
            @if (c.needsWeighIn) {
              <form class="weigh" (ngSubmit)="weigh(c)">
                <label class="field inline">
                  <span i18n="@@torneo.acreditacion.peso">Peso</span>
                  <input
                    i18n-placeholder="@@torneo.acreditacion.kg"
                    [name]="'w' + c.key"
                    inputmode="decimal"
                    enterkeyhint="done"
                    autocomplete="off"
                    placeholder="kg"
                    [ngModel]="weights()[c.key] ?? c.weight ?? ''"
                    (ngModelChange)="setWeight(c.key, $event)"
                    [attr.aria-label]="ariaPesoKg(c.name)"
                  />
                  <span i18n="@@torneo.acreditacion.kg-2" class="muted">kg</span>
                </label>
                <button
                  i18n="@@torneo.acreditacion.pesar"
                  class="btn"
                  [disabled]="busy().has(c.key)"
                  >Pesar</button
                >
                @if (c.unresolved) {
                  <button
                    i18n="@@torneo.acreditacion.resolver-peso"
                    type="button"
                    class="btn danger quiet"
                    (click)="resolve(c)"
                  >
                    Resolver peso…
                  </button>
                }
              </form>
            }
          </article>
        } @empty {
          <div class="card empty">
            @if (!data()) {
              <span class="spinner"></span>
            } @else {
              <p
                ><strong i18n="@@torneo.acreditacion.nadie-coincide-busqueda"
                  >Nadie coincide con la búsqueda.</strong
                ></p
              ><ng-container i18n="@@torneo.acreditacion.prueba-otro-nombre-dojo-filtro">
                Prueba con otro nombre, dojo o filtro.
              </ng-container>
            }
          </div>
        }
      </section>

      <aside class="side">
        <h2 i18n="@@torneo.acreditacion.categoria" class="section-title">Por categoría</h2>
        <ul class="catcount">
          @for (k of data()?.categories ?? []; track k.category_id) {
            <li>
              <span class="grow">{{ k.category_name }}</span>
              <span
                i18n-title="@@torneo.acreditacion.presentes-2"
                class="num present"
                title="Presentes"
                >{{ k.present }}</span
              >
              <span
                i18n-title="@@torneo.acreditacion.ausentes-2"
                class="num absent"
                title="Ausentes"
                >{{ k.absent }}</span
              >
              <span i18n-title="@@torneo.acreditacion.total" class="num muted" title="Total"
                >/ {{ k.total }}</span
              >
            </li>
          } @empty {
            <li i18n="@@torneo.acreditacion.sin-inscripciones-activas" class="muted small"
              >Sin inscripciones activas.</li
            >
          }
        </ul>
        <p i18n="@@torneo.acreditacion.presentes-ausentes" class="hint legend">
          <span class="num present">■</span> presentes <span class="num absent">■</span> ausentes
        </p>
      </aside>
    </div>

    @if (scanOpen()) {
      <app-modal
        i18n-title="@@torneo.acreditacion.leer-credencial"
        title="Leer credencial"
        (closed)="scanOpen.set(false)"
      >
        <app-qr-scanner (scanned)="onScanned($event)" />
      </app-modal>
    }

    @if (resolving(); as rv) {
      <app-modal
        i18n-title="@@torneo.acreditacion.peso-fuera-rango-de"
        title="Peso fuera de rango · {{ rv.card.name }}"
        (closed)="resolving.set(null)"
      >
        @for (it of rv.items; track it.registration_id) {
          <div class="resolve">
            @for (w of it.warnings; track w.code) {
              <p class="alert warn small">{{ w.message }}</p>
            }
            @if (it.suggestions.length) {
              <p i18n="@@torneo.acreditacion.mover-categoria-corresponde-peso" class="small"
                >Mover a la categoría que corresponde al peso:</p
              >
              <div class="row wrap">
                @for (sg of it.suggestions; track sg.category_id) {
                  <button class="btn" (click)="move(it, sg.category_id, sg.name)">
                    {{ sg.name }} <span class="muted small">({{ sg.range }})</span>
                  </button>
                }
              </div>
            } @else {
              <p i18n="@@torneo.acreditacion.no-hay-otra-categoria-abierta" class="muted small"
                >No hay otra categoría abierta que corresponda a este peso.</p
              >
            }
            <button
              i18n="@@torneo.acreditacion.dejarlo-motivo"
              class="btn ghost"
              (click)="accept(it)"
            >
              Dejarlo en «{{ it.category_name }}» con motivo…
            </button>
          </div>
        }
      </app-modal>
    }

    @if (settingsOpen()) {
      <app-modal
        i18n-title="@@torneo.acreditacion.ajustes-acreditacion"
        title="Ajustes de acreditación"
        (closed)="settingsOpen.set(false)"
      >
        <form class="stack" (ngSubmit)="saveSettings()">
          <label i18n="@@torneo.acreditacion.check-in-obligatorio-2" class="field inline"
            ><input type="checkbox" name="req" [(ngModel)]="settings.checkin_required" /> Check-in
            obligatorio</label
          >
          <p i18n="@@torneo.acreditacion.check-in-obligatorio-3" class="hint">
            Con check-in obligatorio, la verificación «listo para iniciar» y la generación de llaves
            avisan de los inscritos sin acreditar. Sin él, la acreditación es opcional y nada
            cambia.
          </p>
          <label class="field">
            <span i18n="@@torneo.acreditacion.tolerancia-peso-kg">Tolerancia de peso (kg)</span>
            <input
              name="tol"
              inputmode="decimal"
              [(ngModel)]="settings.tolerance"
              placeholder="0"
            />
          </label>
          <div class="form-actions"
            ><button i18n="@@torneo.acreditacion.guardar" class="btn primary">Guardar</button></div
          >
        </form>
      </app-modal>
    }
  `,
  styles: `
    .head-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-3);
      margin-bottom: var(--space-4);
    }
    .totals {
      display: flex;
      flex-wrap: wrap;
      gap: 1.25rem;
      align-items: baseline;
      font-size: var(--fs-14);
      color: var(--sumi-2);
      strong {
        font-family: var(--font-display);
        font-size: var(--fs-28);
        margin-right: 0.3rem;
        color: var(--sumi);
      }
      .present strong {
        color: var(--matcha-ink);
      }
      .absent strong {
        color: var(--shu-ink);
      }
    }
    .finder {
      display: flex;
      gap: var(--space-3);
      margin-bottom: var(--space-3);
      .search.big {
        flex: 1;
        input {
          min-height: 3.5rem;
          font-size: var(--fs-20);
        }
      }
    }
    .filters {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-3);
      align-items: center;
      margin-bottom: var(--space-4);
      .count {
        margin-left: auto;
        color: var(--nezumi-ink);
        font-size: var(--fs-14);
      }
      select {
        min-height: 2.75rem;
      }
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
    }
    .chip {
      all: unset;
      box-sizing: border-box;
      min-height: 2.75rem;
      padding: 0 1rem;
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      border: 1px solid var(--kasumi-2);
      font-size: var(--fs-14);
      cursor: pointer;
      &.on {
        background: var(--sumi);
        color: var(--on-sumi);
        border-color: var(--sumi);
      }
      &:focus-visible {
        outline: 2px solid var(--ai);
        outline-offset: 2px;
      }
    }
    .layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 300px;
      gap: 1.5rem;
      align-items: start;
    }
    @media (max-width: 1000px) {
      .layout {
        grid-template-columns: 1fr;
      }
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
      gap: var(--space-3);
    }
    .pcard {
      background: var(--kinu);
      border: 1px solid var(--kasumi);
      border-radius: var(--radius);
      padding: 0.9rem 1rem;
      box-shadow: inset 4px 0 0 var(--kasumi);
      &.present {
        box-shadow: inset 4px 0 0 var(--matcha);
      }
      &.absent {
        box-shadow: inset 4px 0 0 var(--shu);
        .pname {
          text-decoration: line-through;
          color: var(--nezumi-ink);
        }
      }
      header {
        display: flex;
        gap: 0.75rem;
        align-items: flex-start;
        justify-content: space-between;
        flex-wrap: wrap;
      }
      .who {
        display: flex;
        flex-direction: column;
        gap: 0.15rem;
        min-width: 0;
      }
      .pname {
        font-size: var(--fs-16);
      }
      .actions {
        display: flex;
        gap: 0.4rem;
        align-items: center;
      }
      .tap {
        min-width: 8.5rem;
      }
      .tap.done {
        background: var(--matcha-soft);
        border-color: var(--matcha);
        color: var(--matcha-ink);
        font-weight: 700;
      }
    }
    .cats {
      list-style: none;
      margin: 0.6rem 0 0;
      padding: 0;
      li {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.35rem 0;
        border-top: 1px solid var(--kasumi);
        font-size: var(--fs-14);
      }
    }
    .weigh {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
      margin-top: 0.6rem;
      input {
        width: 6.5rem;
        min-height: 2.75rem;
        font-size: var(--fs-20);
        text-align: right;
      }
    }
    .side {
      position: sticky;
      top: 1rem;
    }
    .catcount {
      list-style: none;
      margin: 0;
      padding: 0;
      li {
        display: flex;
        gap: 0.5rem;
        align-items: center;
        padding: 0.4rem 0;
        border-top: 1px solid var(--kasumi);
        font-size: var(--fs-14);
      }
    }
    .num {
      font-variant-numeric: tabular-nums;
      font-weight: 700;
      &.present {
        color: var(--matcha-ink);
      }
      &.absent {
        color: var(--shu-ink);
      }
    }
    .resolve {
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
      padding-bottom: 0.9rem;
      margin-bottom: 0.9rem;
      border-bottom: 1px solid var(--kasumi);
      .wrap {
        flex-wrap: wrap;
        gap: 0.5rem;
      }
    }
  `,
})
export class CheckinTab implements OnInit {
  ariaPesoKg = (nombre: string) =>
    $localize`:@@torneo.acreditacion.peso-de-kg:Peso de ${nombre}:nombre: en kg`;
  readonly ctx = inject(TournamentContext);
  private api = inject(ApiService);
  private mut = inject(MutationService);
  private dialog = inject(DialogService);
  private toast = inject(ToastService);
  private finder = viewChild<ElementRef<HTMLInputElement>>('finder');

  readonly views = VIEWS;
  readonly canScan = qrScanSupported();
  readonly data = signal<CheckinList | null>(null);
  readonly q = signal('');
  readonly view = signal<CheckinView>('all');
  readonly dojoId = signal(0);
  readonly busy = signal<Set<string>>(new Set());
  readonly weights = signal<Record<string, string | undefined>>({});
  readonly scanOpen = signal(false);
  readonly settingsOpen = signal(false);
  readonly resolving = signal<{ card: CheckinCard; items: WeighInItem[] } | null>(null);
  settings = { checkin_required: false, tolerance: '0' };

  readonly cards = computed(() => groupByPerson(this.data()?.rows ?? []));
  readonly shown = computed(() => filterCards(this.cards(), this.q(), this.dojoId(), this.view()));
  readonly dojos = computed(() => {
    const m = new Map<number, string>();
    for (const r of this.data()?.rows ?? []) m.set(r.dojo_id, r.dojo_name);
    return [...m].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  });

  constructor() {
    this.load();
  }

  async load(): Promise<void> {
    try {
      this.data.set(
        await firstValueFrom(this.api.get<CheckinList>(`/tournaments/${this.ctx.id()}/checkin`)),
      );
    } catch (e) {
      this.toast.error(ApiError.from(e).fullMessage);
    }
  }

  range(r: CheckinRow): string {
    return rangeText(r.weight_min_kg, r.weight_max_kg);
  }

  setWeight(key: string, v: string): void {
    this.weights.update((w) => ({ ...w, [key]: v }));
  }

  private setBusy(key: string, on: boolean): void {
    this.busy.update((s) => {
      const n = new Set(s);
      if (on) n.add(key);
      else n.delete(key);
      return n;
    });
  }

  /** Aplica las inscripciones devueltas por el servidor a la lista (sin recargar todo). */
  private apply(regs: Registration[]): void {
    const d = this.data();
    if (!d) return;
    const by = new Map(regs.map((r) => [r.id, r]));
    const rows = d.rows.map((row) => {
      const r = by.get(row.registration_id);
      if (!r) return row;
      return {
        ...row,
        checkin_status: r.checkin_status ?? row.checkin_status,
        checked_in_at: r.checked_in_at ?? null,
        weight_kg: r.weight_kg ?? row.weight_kg,
        weigh_in_result: r.weigh_in_result ?? row.weigh_in_result,
        category_id: r.category_id,
        version: r.version,
      };
    });
    const totals = { total: 0, present: 0, absent: 0, pending: 0 };
    const cats = new Map(
      d.categories.map((c) => [
        c.category_id,
        { ...c, present: 0, absent: 0, pending: 0, total: 0 },
      ]),
    );
    for (const r of rows) {
      totals.total++;
      totals[r.checkin_status]++;
      const c = cats.get(r.category_id);
      if (c) {
        c.total++;
        c[r.checkin_status]++;
      }
    }
    this.data.set({ ...d, rows, totals, categories: [...cats.values()] });
  }

  async mark(c: CheckinCard, status: CheckinStatus): Promise<void> {
    this.setBusy(c.key, true);
    try {
      const res = await firstValueFrom(
        this.api.post<CheckinResult>(`/tournaments/${this.ctx.id()}/checkin`, {
          registration_ids: c.rows.map((r) => r.registration_id),
          status,
        }),
      );
      this.apply(res.registrations);
      await this.offerWalkover(res);
    } catch (e) {
      this.toast.error(ApiError.from(e).fullMessage);
    } finally {
      this.setBusy(c.key, false);
    }
  }

  /** Ausente en una categoría con llave: ofrecer walkover (retira con «No se presentó»). */
  private async offerWalkover(res: CheckinResult): Promise<void> {
    if (!res.absent_with_bracket?.length) return;
    const choice = await this.dialog.choose({
      title: $localize`:@@torneo.acreditacion.ausente-llave-generada:Ausente con llave generada`,
      message: $localize`:@@torneo.acreditacion.llave-estas-categorias-ya-existe:La llave de estas categorías ya existe. Puedes retirarlo con «No se presentó» y dar walkover a sus rivales, o decidirlo más tarde.`,
      items: res.absent_with_bracket.map((a) => a.category_name),
      choices: [
        {
          value: 'walkover',
          label: $localize`:@@torneo.acreditacion.dar-walkover-ahora:Dar walkover ahora`,
          primary: true,
          danger: true,
        },
      ],
      cancelText: $localize`:@@torneo.acreditacion.mas-tarde:Más tarde`,
    });
    if (choice !== 'walkover') return;
    for (const a of res.absent_with_bracket) await this.noShowId(a.registration_id);
    await this.load();
  }

  async noShow(r: CheckinRow): Promise<void> {
    const ok = await this.dialog.confirm({
      title: $localize`:@@torneo.acreditacion.dar-walkover:Dar walkover`,
      message: $localize`:@@torneo.acreditacion.retira-motivo-no-presento-rival:Se retira a ${r.name}:name: de «${r.category_name}:category_name:» con el motivo «No se presentó» y su rival gana por walkover.`,
      confirmText: $localize`:@@torneo.acreditacion.dar-walkover:Dar walkover`,
      danger: true,
    });
    if (!ok) return;
    await this.noShowId(r.registration_id);
    await this.load();
  }

  private async noShowId(rid: number): Promise<void> {
    const res = await this.mut.post<{ walkover_matches: string[]; waiting_matches: string[] }>(
      `/registrations/${rid}/no-show`,
    );
    if (res) {
      const msg = res.walkover_matches.length
        ? $localize`:@@torneo.acreditacion.walkover-2:Walkover en ${res.walkover_matches.join(', ')}:join:`
        : $localize`:@@torneo.acreditacion.retirado-no-presento:Retirado: no se presentó`;
      this.toast.ok(
        res.waiting_matches.length
          ? `${msg}. Pendiente (rival por definir): ${res.waiting_matches.join(', ')}`
          : msg,
      );
    }
  }

  async weigh(c: CheckinCard): Promise<void> {
    const raw = this.weights()[c.key] ?? (c.weight !== null ? String(c.weight) : '');
    const kg = parseWeight(raw);
    if (kg === null) {
      this.toast.warn(
        $localize`:@@torneo.acreditacion.escribe-peso-kg-ejemplo-45-3:Escribe el peso en kg (por ejemplo 45,3).`,
      );
      return;
    }
    const target = c.rows.find((r) => r.needs_weigh_in) ?? c.rows[0];
    this.setBusy(c.key, true);
    try {
      const res = await firstValueFrom(
        this.api.post<WeighInOut>(`/registrations/${target.registration_id}/weigh-in`, {
          weight_kg: kg,
        }),
      );
      await this.load();
      const bad = res.results.filter((x) => x.result !== 'ok');
      if (bad.length) {
        const card = this.cards().find((x) => x.key === c.key) ?? c;
        this.resolving.set({ card, items: bad });
      } else {
        this.toast.ok(
          $localize`:@@torneo.acreditacion.kg-peso-ok:${c.name}:name:: ${kg}:kg: kg, peso OK`,
        );
      }
    } catch (e) {
      this.toast.error(ApiError.from(e).fullMessage);
    } finally {
      this.setBusy(c.key, false);
    }
  }

  /** Vuelve a pedir las sugerencias (re-pesar con el mismo peso no cambia nada). */
  async resolve(c: CheckinCard): Promise<void> {
    if (c.weight === null) return;
    const target = c.rows.find((r) => r.needs_weigh_in) ?? c.rows[0];
    try {
      const res = await firstValueFrom(
        this.api.post<WeighInOut>(`/registrations/${target.registration_id}/weigh-in`, {
          weight_kg: c.weight,
        }),
      );
      const bad = res.results.filter(
        (x) =>
          x.result !== 'ok' &&
          !c.rows.find((r) => r.registration_id === x.registration_id)?.weigh_in_resolved,
      );
      this.resolving.set(bad.length ? { card: c, items: bad } : null);
    } catch (e) {
      this.toast.error(ApiError.from(e).fullMessage);
    }
  }

  async move(it: WeighInItem, categoryId: number, name: string): Promise<void> {
    const reason = await this.dialog.prompt({
      title: $localize`:@@torneo.acreditacion.mover:Mover a «${name}:name:»`,
      message: $localize`:@@torneo.acreditacion.queda-registrado-auditoria:Queda registrado en la auditoría.`,
      label: $localize`:@@torneo.acreditacion.motivo:Motivo`,
      minLength: 3,
      initial: $localize`:@@torneo.acreditacion.peso-balanza-oficial:Peso en la balanza oficial`,
      confirmText: $localize`:@@torneo.acreditacion.mover-2:Mover`,
    });
    if (!reason) return;
    const res = await this.mut.post<Registration>(
      `/registrations/${it.registration_id}/weigh-in/move`,
      { category_id: categoryId, reason },
      { success: $localize`:@@torneo.acreditacion.movido:Movido a «${name}:name:»` },
    );
    if (res) {
      this.resolving.set(null);
      await Promise.all([this.load(), this.ctx.loadCategories()]);
    }
  }

  async accept(it: WeighInItem): Promise<void> {
    const reason = await this.dialog.prompt({
      title: $localize`:@@torneo.acreditacion.aceptar-fuera-peso:Aceptar fuera de peso`,
      message: $localize`:@@torneo.acreditacion.compite-aunque-peso-este-fuera:Compite en «${it.category_name}:category_name:» aunque el peso esté fuera de rango. Queda como advertencia aceptada.`,
      label: $localize`:@@torneo.acreditacion.motivo:Motivo`,
      minLength: 3,
      confirmText: $localize`:@@torneo.acreditacion.aceptar:Aceptar`,
    });
    if (!reason) return;
    const res = await this.mut.post<Registration>(
      `/registrations/${it.registration_id}/weigh-in/accept`,
      { reason },
      { success: $localize`:@@torneo.acreditacion.peso-aceptado-motivo:Peso aceptado con motivo` },
    );
    if (res) {
      this.resolving.set(null);
      await this.load();
    }
  }

  async submitSearch(): Promise<void> {
    const text = this.q().trim();
    if (looksLikeCode(text)) {
      await this.scan(text);
      return;
    }
    const list = this.shown();
    if (list.length === 1 && list[0].status !== 'present') await this.mark(list[0], 'present');
  }

  async onScanned(value: string): Promise<void> {
    this.scanOpen.set(false);
    await this.scan(value);
  }

  private async scan(code: string): Promise<void> {
    try {
      const res = await firstValueFrom(
        this.api.post<CheckinResult>(`/tournaments/${this.ctx.id()}/checkin/scan`, { code }),
      );
      this.apply(res.registrations);
      this.toast.ok($localize`:@@torneo.acreditacion.presente-3:${res.name}:name:: presente`);
      this.q.set('');
      this.finder()?.nativeElement.focus();
      await this.offerWalkover(res);
    } catch (e) {
      this.toast.error(ApiError.from(e).fullMessage);
    }
  }

  async saveSettings(): Promise<void> {
    const t = this.ctx.tournament();
    if (!t) return;
    const tol = parseWeight(this.settings.tolerance) ?? 0;
    const res = await this.mut.patch<Tournament>(
      `/tournaments/${t.id}`,
      {
        version: t.version,
        checkin_required: this.settings.checkin_required,
        weigh_in_tolerance_kg: tol,
      },
      {
        success: $localize`:@@torneo.acreditacion.ajustes-guardados:Ajustes guardados`,
        onConflict: () => this.ctx.reload(),
      },
    );
    if (res) {
      this.ctx.tournament.set(res);
      this.settingsOpen.set(false);
      await this.load();
    }
  }

  ngOnInit(): void {
    const t = this.ctx.tournament();
    this.settings = {
      checkin_required: !!t?.checkin_required,
      tolerance: String(t?.weigh_in_tolerance_kg ?? 0),
    };
  }
}
