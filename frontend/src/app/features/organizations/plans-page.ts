import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { INVOICE_STATUS, invoiceNumber, PAYMENT_STATUS, penFromCents } from '../../core/billing';
import { DialogService } from '../../core/dialog.service';
import { fmtDate, fmtSoles, SUBSCRIPTION_STATUS } from '../../core/format';
import { PaymentOut, Plan, PlansOut, Subscription } from '../../core/models';
import { MutationService } from '../../core/mutation.service';
import { PaymentsService } from '../../core/payments';
import { PageHead } from '../../shared/page-head';
import { SubscribeDialog } from '../billing/subscribe-dialog';
import { etiquetas } from '../../core/i18n/etiquetas';

/** Qué incluye cada nivel (docs/modelo-negocio.md). El servidor decide los derechos reales. */
const INCLUDES: Record<string, string> = etiquetas(() => ({
  publico: $localize`:@@planes.torneos-llaves-resultados:Torneos, llaves, resultados, medallero por dojo, seguimiento en vivo y perfil básico del competidor.`,
  competidor: $localize`:@@planes.todo-necesario-propio-perfil:Todo lo necesario del propio perfil (o del hijo o hija): historial completo, hoja de cada combate, medallas, grados, estadísticas básicas, insignias y avisos.`,
  competidor_plus: $localize`:@@planes.analisis-adicional-evolucion:Análisis adicional: evolución por temporada, técnicas, índice Hajime y su tendencia, comparación con rivales (datos públicos) y certificados descargables.`,
  dojo: $localize`:@@planes.administrar-dojo-competidores:Administrar el dojo y sus competidores, inscribir alumnos y organizar torneos: inscripciones, Excel, llaves, mesa, varios tatamis, árbitros, reportes, Shadow Mode y overlay en vivo.`,
  organizador: $localize`:@@planes.mismo-dojo-pensado-para-ligas:Lo mismo que Dojo, pensado para ligas y organizadores que no son un dojo.`,
}));
const AUDIENCE: Record<string, string> = etiquetas(() => ({
  all: $localize`:@@planes.cualquiera:Cualquiera`,
  person: $localize`:@@planes.competidores-padres-apoderados:Competidores, padres o apoderados`,
  organization: $localize`:@@planes.dojos-ligas-organizadores:Dojos, ligas y organizadores`,
}));

/**
 * ¿Se muestra «Suscribirse» para el plan? Solo con los cobros activos, en modo enforced y si el
 * plan tiene precio.
 */
export function canSubscribe(
  paymentsOn: boolean,
  mode: PlansOut['mode'] | undefined,
  p: Pick<Plan, 'price_pen_month' | 'price_pen_year'>,
): boolean {
  return paymentsOn && mode === 'enforced' && !!(p.price_pen_month || p.price_pen_year);
}

/** Página «Planes»: niveles, precios (provisionales) y el modo de cobro vigente. */
@Component({
  selector: 'app-plans-page',
  imports: [RouterLink, PageHead, SubscribeDialog],
  template: `
    <div class="container">
      <app-page-head i18n-title="@@planes.planes" kanji="料金" title="Planes">
        <div meta class="meta-line">
          <span i18n="@@planes.gratis-necesario-membresia-para"
            >Gratis lo necesario; membresía para dojos y organizadores</span
          >
        </div>
      </app-page-head>

      @if (data(); as d) {
        @if (!payments.enabled()) {
          <!-- Cobros apagados (core/payments.ts): la página queda solo informativa. -->
          <div
            i18n="@@planes.marcha-blanca-todo-incluido"
            class="alert ok"
            data-testid="sin-cobros"
          >
            Durante la marcha blanca todo está incluido sin costo.
          </div>
        } @else if (d.mode === 'marcha_blanca') {
          <div i18n="@@planes.marcha-blanca-durante-pruebas" class="alert ok">
            <strong>Marcha blanca:</strong> durante las pruebas todo es gratis para cualquier
            cuenta. Los niveles ya existen y se activarán en el lanzamiento.
          </div>
        } @else {
          <div class="alert info"
            ><ng-container i18n="@@planes.planes-estan-activos-elige">
              Los planes están activos. Elige «Suscribirse» para contratar o renovar
            </ng-container>
            @if (config()?.provider === 'manual') {
              <ng-container i18n="@@planes.ahora-pago-coordina-equipo">
                (por ahora el pago se coordina con el equipo de Hajime y el administrador lo activa)
              </ng-container>
            }
            <ng-container i18n="@@planes.plan-organizacion-esta">
              . El plan de tu organización está en <a routerLink="/organizacion">Organización</a>.
            </ng-container></div
          >
        }

        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th i18n="@@planes.nivel">Nivel</th>
                <th i18n="@@planes.para-quien">Para quién</th>
                <th i18n="@@planes.mensual" class="right">Mensual</th>
                <th i18n="@@planes.anual" class="right">Anual</th>
                <th i18n="@@planes.incluye">Qué incluye</th>
                <th><span i18n="@@planes.contratar" class="sr-only">Contratar</span></th>
              </tr>
            </thead>
            <tbody>
              @for (p of visible(); track p.code) {
                <tr>
                  <td>
                    <strong>{{ p.name }}</strong>
                  </td>
                  <td class="small">{{ audience(p) }}</td>
                  <td class="right nowrap num">{{ price(p.price_pen_month) }}</td>
                  <td class="right nowrap num">{{ price(p.price_pen_year) }}</td>
                  <td class="small">
                    {{ includes(p) }}
                    @if (p.features.length) {
                      <div class="features">
                        @for (f of p.features; track f) {
                          <span class="badge plain">{{ featureName(d, f) }}</span>
                        }
                      </div>
                    }
                  </td>
                  <td class="right nowrap">
                    @if (canSubscribe(p)) {
                      <button
                        i18n="@@planes.suscribirse"
                        class="btn sm primary"
                        type="button"
                        (click)="chosen.set(p)"
                      >
                        Suscribirse
                      </button>
                      @if (p.trial_days) {
                        <div i18n="@@planes.dias-prueba" class="small muted"
                          >{{ p.trial_days }} días de prueba</div
                        >
                      }
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        @if (payments.enabled() && (mySubs().length || myPayments().length)) {
          <section class="card mine" aria-labelledby="h-mio">
            <h2 i18n="@@planes.mi-competidor-plus" id="h-mio">Mi Competidor Plus</h2>
            @for (sub of mySubs(); track sub.id) {
              <p>
                <strong>{{ sub.plan_name }}</strong> · {{ statusLabel(sub.status) }}
                @if (sub.current_period_end) {
                  <ng-container i18n="@@organizacion.termina-vigente-hasta">
                    ·
                    @if (sub.cancel_at_period_end) {
                      termina
                    } @else {
                      vigente hasta
                    }
                    el
                    {{ date(sub.current_period_end) }}
                  </ng-container>
                }
                @if (sub.in_grace) {
                  <span i18n="@@planes.gracia" class="badge plain">En gracia</span>
                }
                @if (sub.recurring) {
                  <span i18n="@@planes.renovacion-automatica" class="badge matcha"
                    >Renovación automática</span
                  >
                }
                @if (sub.status !== 'canceled' && !sub.cancel_at_period_end) {
                  <button
                    i18n="@@planes.cancelar"
                    class="btn sm ghost"
                    type="button"
                    (click)="cancel(sub)"
                    >Cancelar</button
                  >
                }
              </p>
            }
            @if (myPayments().length) {
              <div class="table-wrap">
                <table class="table">
                  <thead>
                    <tr>
                      <th i18n="@@planes.fecha">Fecha</th>
                      <th i18n="@@planes.monto" class="right">Monto</th>
                      <th i18n="@@planes.estado">Estado</th>
                      <th i18n="@@planes.comprobante">Comprobante</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (pay of myPayments(); track pay.id) {
                      <tr>
                        <td class="nowrap">{{ date(pay.created_at) }}</td>
                        <td class="right num">{{ cents(pay.amount_pen) }}</td>
                        <td>{{ payStatus(pay.status) }}</td>
                        <td class="small">
                          @if (pay.invoice; as inv) {
                            @if (inv.pdf_url) {
                              <a
                                i18n="@@planes.pdf"
                                [href]="inv.pdf_url"
                                target="_blank"
                                rel="noopener"
                                >{{ num(inv.serie, inv.numero) }} (PDF)</a
                              >
                            } @else {
                              {{ num(inv.serie, inv.numero) }} · {{ invStatus(inv.status) }}
                            }
                          } @else {
                            —
                          }
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          </section>
        }

        <p i18n="@@planes.precios-soles-s-provisionales" class="small muted note">
          Precios en soles (S/), <strong>provisionales</strong>: pueden cambiar antes del
          lanzamiento. Los resultados siguen siendo públicos y gratuitos: pagar da herramientas de
          gestión o análisis adicional, nunca ocultar o cambiar resultados.
        </p>
      } @else if (error()) {
        <div class="alert danger">{{ error() }}</div>
      } @else {
        <div class="empty"><span class="spinner"></span></div>
      }
    </div>

    @if (chosen(); as p) {
      <app-subscribe-dialog [plan]="p" [config]="config()" (closed)="chosen.set(null)" />
    }
  `,
  styles: `
    .features {
      display: flex;
      flex-wrap: wrap;
      gap: 0.3rem;
      margin-top: 0.4rem;
    }
    .note {
      margin-top: 1rem;
      max-width: 60rem;
    }
    .mine {
      margin-top: 1.5rem;
      h2 {
        font-size: var(--fs-20);
        margin-bottom: 0.5rem;
      }
    }
  `,
})
export class PlansPage {
  private api = inject(ApiService);
  private mut = inject(MutationService);
  private dialog = inject(DialogService);
  /** Cobros activos: sin ellos no hay «Suscribirse», pagos ni comprobantes. */
  readonly payments = inject(PaymentsService);
  readonly data = signal<PlansOut | null>(null);
  readonly config = this.payments.config;
  readonly error = signal('');
  /** Plan elegido para «Suscribirse» (abre el diálogo). */
  readonly chosen = signal<Plan | null>(null);
  readonly mySubs = signal<Subscription[]>([]);
  readonly myPayments = signal<PaymentOut[]>([]);
  /** La marcha blanca es un modo, no un nivel que se contrate. */
  readonly visible = computed(() =>
    (this.data()?.plans ?? []).filter((p) => p.code !== 'marcha_blanca'),
  );

  constructor() {
    this.api.get<PlansOut>('/plans').subscribe({
      next: (d) => this.data.set(d),
      error: (e) =>
        this.error.set(
          e?.message ??
            $localize`:@@planes.no-pudieron-cargar-planes:No se pudieron cargar los planes`,
        ),
    });
    this.payments.load().subscribe((on) => {
      if (on) void this.loadMine();
    });
  }

  private async loadMine(): Promise<void> {
    const subs = await firstValueFrom(this.api.get<Subscription[]>('/me/subscriptions')).catch(
      () => [],
    );
    this.mySubs.set(subs.filter((x) => x.plan_code === 'competidor_plus'));
    this.myPayments.set(
      await firstValueFrom(this.api.get<PaymentOut[]>('/me/payments')).catch(() => []),
    );
  }

  /** Se contrata lo que tiene precio; la marcha blanca (o sin cobros activos) no cobra. */
  canSubscribe(p: Plan): boolean {
    return canSubscribe(this.payments.enabled(), this.data()?.mode, p);
  }
  cents(v: number): string {
    return penFromCents(v);
  }
  date(v: string): string {
    return fmtDate(v.slice(0, 10));
  }
  num(serie: string, numero: number): string {
    return invoiceNumber(serie, numero);
  }
  statusLabel(s: string): string {
    return SUBSCRIPTION_STATUS[s] ?? s;
  }
  payStatus(s: PaymentOut['status']): string {
    return PAYMENT_STATUS[s] ?? s;
  }
  invStatus(s: string): string {
    return INVOICE_STATUS[s] ?? s;
  }

  async cancel(sub: Subscription): Promise<void> {
    const ok = await this.dialog.confirm({
      title: $localize`:@@planes.cancelar-competidor-plus:Cancelar Competidor Plus`,
      message: $localize`:@@planes.no-renovara-conservas-acceso:No se renovará. Conservas el acceso hasta el fin del periodo pagado.`,
      confirmText: $localize`:@@planes.cancelar-suscripcion:Cancelar suscripción`,
      danger: true,
    });
    if (!ok) return;
    const out = await this.mut.post<Subscription>(
      `/subscriptions/${sub.id}/cancel`,
      {},
      {
        success: $localize`:@@planes.suscripcion-cancelada:Suscripción cancelada`,
      },
    );
    if (out) void this.loadMine();
  }

  price(v: number | null): string {
    if (v === null || v === undefined) return '—';
    if (!v) return $localize`:@@planes.gratis:Gratis`;
    return fmtSoles(v);
  }
  featureName(d: PlansOut, f: string): string {
    return d.features[f] || f;
  }
  includes(p: Plan): string {
    return INCLUDES[p.code] ?? '';
  }
  audience(p: Plan): string {
    return AUDIENCE[p.audience] ?? p.audience;
  }
}
