import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { INVOICE_STATUS, invoiceNumber, PAYMENT_STATUS, penFromCents } from '../../core/billing';
import { DialogService } from '../../core/dialog.service';
import { fmtDate, fmtSoles, SUBSCRIPTION_STATUS } from '../../core/format';
import { BillingConfig, PaymentOut, Plan, PlansOut, Subscription } from '../../core/models';
import { MutationService } from '../../core/mutation.service';
import { PageHead } from '../../shared/page-head';
import { SubscribeDialog } from '../billing/subscribe-dialog';

/** Qué incluye cada nivel (docs/modelo-negocio.md). El servidor decide los derechos reales. */
const INCLUDES: Record<string, string> = {
  publico:
    'Torneos, llaves, resultados, medallero por dojo, seguimiento en vivo y perfil básico del competidor.',
  competidor:
    'Todo lo necesario del propio perfil (o del hijo o hija): historial completo, hoja de cada combate, medallas, grados, estadísticas básicas, insignias y avisos.',
  competidor_plus:
    'Análisis adicional: evolución por temporada, técnicas, índice Hajime y su tendencia, comparación con rivales (datos públicos) y certificados descargables.',
  dojo: 'Administrar el dojo y sus competidores, inscribir alumnos y organizar torneos: inscripciones, Excel, llaves, mesa, varios tatamis, árbitros, reportes, Shadow Mode y overlay en vivo.',
  organizador: 'Lo mismo que Dojo, pensado para ligas y organizadores que no son un dojo.',
};
const AUDIENCE: Record<string, string> = {
  all: 'Cualquiera',
  person: 'Competidores, padres o apoderados',
  organization: 'Dojos, ligas y organizadores',
};

/** Página «Planes»: niveles, precios (provisionales) y el modo de cobro vigente. */
@Component({
  selector: 'app-plans-page',
  imports: [RouterLink, PageHead, SubscribeDialog],
  template: `
    <div class="container">
      <app-page-head kanji="料金" title="Planes">
        <div meta class="meta-line">
          <span>Gratis lo necesario; membresía para dojos y organizadores</span>
        </div>
      </app-page-head>

      @if (data(); as d) {
        @if (d.mode === 'marcha_blanca') {
          <div class="alert ok">
            <strong>Marcha blanca:</strong> durante las pruebas todo es gratis para cualquier
            cuenta. Los niveles ya existen y se activarán en el lanzamiento.
          </div>
        } @else {
          <div class="alert info">
            Los planes están activos. Elige «Suscribirse» para contratar o renovar
            @if (config()?.provider === 'manual') {
              (por ahora el pago se coordina con el equipo de Hajime y el administrador lo activa)
            }
            . El plan de tu organización está en <a routerLink="/organizacion">Organización</a>.
          </div>
        }

        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>Nivel</th>
                <th>Para quién</th>
                <th class="right">Mensual</th>
                <th class="right">Anual</th>
                <th>Qué incluye</th>
                <th><span class="sr-only">Contratar</span></th>
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
                      <button class="btn sm primary" type="button" (click)="chosen.set(p)">
                        Suscribirse
                      </button>
                      @if (p.trial_days) {
                        <div class="small muted">{{ p.trial_days }} días de prueba</div>
                      }
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        @if (mySubs().length || myPayments().length) {
          <section class="card mine" aria-labelledby="h-mio">
            <h2 id="h-mio">Mi Competidor Plus</h2>
            @for (sub of mySubs(); track sub.id) {
              <p>
                <strong>{{ sub.plan_name }}</strong> · {{ statusLabel(sub.status) }}
                @if (sub.current_period_end) {
                  · {{ sub.cancel_at_period_end ? 'termina' : 'vigente hasta' }} el
                  {{ date(sub.current_period_end) }}
                }
                @if (sub.in_grace) {
                  <span class="badge plain">En gracia</span>
                }
                @if (sub.recurring) {
                  <span class="badge matcha">Renovación automática</span>
                }
                @if (sub.status !== 'canceled' && !sub.cancel_at_period_end) {
                  <button class="btn sm ghost" type="button" (click)="cancel(sub)">Cancelar</button>
                }
              </p>
            }
            @if (myPayments().length) {
              <div class="table-wrap">
                <table class="table">
                  <thead>
                    <tr>
                      <th>Fecha</th>
                      <th class="right">Monto</th>
                      <th>Estado</th>
                      <th>Comprobante</th>
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
                              <a [href]="inv.pdf_url" target="_blank" rel="noopener"
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

        <p class="small muted note">
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
  readonly data = signal<PlansOut | null>(null);
  readonly config = signal<BillingConfig | null>(null);
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
      error: (e) => this.error.set(e?.message ?? 'No se pudieron cargar los planes'),
    });
    this.api.get<BillingConfig>('/billing/config').subscribe({
      next: (c) => this.config.set(c),
      error: () => {},
    });
    void this.loadMine();
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

  /** Se contrata lo que tiene precio; la marcha blanca no cobra. */
  canSubscribe(p: Plan): boolean {
    return this.data()?.mode === 'enforced' && !!(p.price_pen_month || p.price_pen_year);
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
      title: 'Cancelar Competidor Plus',
      message: 'No se renovará. Conservas el acceso hasta el fin del periodo pagado.',
      confirmText: 'Cancelar suscripción',
      danger: true,
    });
    if (!ok) return;
    const out = await this.mut.post<Subscription>(
      `/subscriptions/${sub.id}/cancel`,
      {},
      {
        success: 'Suscripción cancelada',
      },
    );
    if (out) void this.loadMine();
  }

  price(v: number | null): string {
    if (v === null || v === undefined) return '—';
    if (!v) return 'Gratis';
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
