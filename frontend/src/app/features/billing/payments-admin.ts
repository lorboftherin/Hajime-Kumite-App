import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import {
  INVOICE_STATUS,
  invoiceNumber,
  PAYMENT_STATUS,
  penFromCents,
  PROVIDER_LABEL,
} from '../../core/billing';
import { DialogService } from '../../core/dialog.service';
import { fmtDateTime } from '../../core/format';
import { BillingConfig, Coupon, PaymentOut } from '../../core/models';
import { MutationService } from '../../core/mutation.service';
import { Icon } from '../../shared/icon';
import { PageHead } from '../../shared/page-head';

/** Admin Global: pagos de todas las organizaciones y cuentas, reembolsos, comprobantes y cupones. */
@Component({
  selector: 'app-payments-admin',
  imports: [FormsModule, PageHead, Icon],
  template: `
    <div class="container">
      <app-page-head kanji="会計" title="Pagos">
        <div meta class="meta-line">
          @if (config(); as c) {
            <span>Pasarela: {{ provider(c.provider) }}</span>
            <span
              >Comprobantes: {{ c.invoicing === 'nubefact' ? 'Nubefact' : 'desactivados' }}</span
            >
            <span>Modo: {{ c.mode === 'enforced' ? 'cobro activo' : 'marcha blanca' }}</span>
          }
        </div>
      </app-page-head>

      <form class="row filters" (ngSubmit)="load()">
        <input
          name="q"
          [(ngModel)]="q"
          placeholder="Referencia, organización o usuario"
          aria-label="Buscar pagos"
        />
        <select name="st" [(ngModel)]="status" aria-label="Estado" (ngModelChange)="load()">
          <option value="">Todos los estados</option>
          <option value="approved">Aprobados</option>
          <option value="pending">Pendientes</option>
          <option value="rejected">Rechazados</option>
          <option value="refunded">Reembolsados</option>
        </select>
        <button class="btn"><app-icon name="search" /> Buscar</button>
      </form>

      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Titular</th>
              <th>Plan</th>
              <th class="right">Monto</th>
              <th>Estado</th>
              <th>Pasarela</th>
              <th>Comprobante</th>
              <th><span class="sr-only">Acciones</span></th>
            </tr>
          </thead>
          <tbody>
            @for (p of payments(); track p.id) {
              <tr>
                <td class="nowrap small">{{ dt(p.created_at) }}</td>
                <td>{{ p.organization_name ?? p.person_name ?? p.username ?? '—' }}</td>
                <td class="small">
                  {{ p.plan_name ?? '—' }}
                  @if (p.coupon_code) {
                    <span class="badge plain">{{ p.coupon_code }}</span>
                  }
                </td>
                <td class="right num nowrap">{{ money(p.amount_pen) }}</td>
                <td>{{ statusLabel(p.status) }}</td>
                <td class="small">
                  {{ provider(p.provider) }}<br /><span class="code">{{ p.provider_ref }}</span>
                </td>
                <td class="small">
                  @if (p.invoice; as inv) {
                    @if (inv.pdf_url) {
                      <a [href]="inv.pdf_url" target="_blank" rel="noopener">{{
                        num(inv.serie, inv.numero)
                      }}</a>
                    } @else {
                      {{ num(inv.serie, inv.numero) }}
                    }
                    <br /><span [class.danger-text]="inv.status === 'error'">{{
                      invStatus(inv.status)
                    }}</span>
                    @if (p.credit_note; as nc) {
                      <br />Nota de crédito
                      @if (nc.pdf_url) {
                        <a [href]="nc.pdf_url" target="_blank" rel="noopener">{{
                          num(nc.serie, nc.numero)
                        }}</a>
                      } @else {
                        {{ num(nc.serie, nc.numero) }}
                      }
                      ·
                      <span [class.danger-text]="nc.status === 'error'">{{
                        invStatus(nc.status)
                      }}</span>
                    }
                  } @else {
                    —
                  }
                </td>
                <td class="right nowrap">
                  @if (
                    p.status === 'approved' &&
                    p.amount_pen > 0 &&
                    config()?.invoicing === 'nubefact'
                  ) {
                    @if (!p.invoice || p.invoice.status === 'error') {
                      <button class="btn sm" (click)="invoice(p)">Emitir comprobante</button>
                    }
                  }
                  @if (p.status === 'refunded' && p.credit_note?.status === 'error') {
                    <button class="btn sm" (click)="invoice(p)">Reintentar nota de crédito</button>
                  }
                  @if (p.status === 'approved') {
                    <button class="btn sm ghost" (click)="refund(p)">Reembolsar</button>
                  }
                </td>
              </tr>
            } @empty {
              <tr>
                <td colspan="8" class="muted small">
                  @if (loading()) {
                    <span class="spinner"></span>
                  } @else {
                    Sin pagos.
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>

      <section class="card coupons" aria-labelledby="h-cupones">
        <h2 id="h-cupones">Cupones</h2>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>Código</th>
                <th>Descuento</th>
                <th>Planes</th>
                <th>Usos</th>
                <th>Vence</th>
                <th>Activo</th>
              </tr>
            </thead>
            <tbody>
              @for (c of coupons(); track c.id) {
                <tr>
                  <td>
                    <span class="code">{{ c.code }}</span>
                    <div class="small muted">{{ c.description }}</div>
                  </td>
                  <td class="nowrap">
                    {{ c.percent_off ? c.percent_off + ' %' : money(c.amount_off_pen ?? 0) }}
                    <span class="small muted">{{
                      c.first_period_only ? '(primer periodo)' : '(siempre)'
                    }}</span>
                  </td>
                  <td class="small">
                    {{ c.plan_codes.length ? c.plan_codes.join(', ') : 'Todos' }}
                  </td>
                  <td class="num">
                    {{ c.times_redeemed }}{{ c.max_redemptions ? ' / ' + c.max_redemptions : '' }}
                  </td>
                  <td class="small nowrap">{{ c.expires_at ? dt(c.expires_at) : '—' }}</td>
                  <td>
                    <input
                      type="checkbox"
                      [checked]="c.active"
                      (change)="toggle(c)"
                      [attr.aria-label]="'Cupón ' + c.code + ' activo'"
                    />
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        <form class="row new-coupon" (ngSubmit)="createCoupon()">
          <input
            name="cc"
            [(ngModel)]="nc.code"
            placeholder="CÓDIGO"
            aria-label="Código"
            required
          />
          <input
            name="cp"
            type="number"
            min="1"
            max="100"
            [(ngModel)]="nc.percent"
            placeholder="% desc."
            aria-label="Porcentaje de descuento"
          />
          <input
            name="cd"
            [(ngModel)]="nc.description"
            placeholder="Descripción"
            aria-label="Descripción"
          />
          <select name="cpl" [(ngModel)]="nc.plans" aria-label="Planes">
            <option value="">Todos los planes</option>
            <option value="dojo,organizador">Dojo y Organizador</option>
            <option value="competidor_plus">Competidor Plus</option>
          </select>
          <label class="small"
            ><input type="checkbox" name="cf" [(ngModel)]="nc.firstOnly" /> Solo primer
            periodo</label
          >
          <button class="btn" [disabled]="!nc.code.trim() || !nc.percent">
            <app-icon name="plus" /> Crear
          </button>
        </form>
      </section>
    </div>
  `,
  styles: `
    .filters,
    .new-coupon {
      gap: 0.5rem;
      flex-wrap: wrap;
      margin-bottom: 1rem;
      input {
        min-width: 10rem;
      }
    }
    .new-coupon {
      margin-top: 0.75rem;
    }
    .coupons {
      margin-top: 1.5rem;
      h2 {
        font-size: var(--fs-20);
        margin-bottom: 0.75rem;
      }
    }
    .danger-text {
      color: var(--danger);
    }
  `,
})
export class PaymentsAdminPage {
  private api = inject(ApiService);
  private mut = inject(MutationService);
  private dialog = inject(DialogService);

  readonly payments = signal<PaymentOut[]>([]);
  readonly coupons = signal<Coupon[]>([]);
  readonly config = signal<BillingConfig | null>(null);
  readonly loading = signal(false);
  q = '';
  status = '';
  nc = { code: '', percent: null as number | null, description: '', plans: '', firstOnly: true };

  constructor() {
    this.api.get<BillingConfig>('/billing/config').subscribe({ next: (c) => this.config.set(c) });
    void this.load();
    void this.loadCoupons();
  }

  money(c: number): string {
    return penFromCents(c);
  }
  dt(v: string): string {
    return fmtDateTime(v);
  }
  num(serie: string, numero: number): string {
    return invoiceNumber(serie, numero);
  }
  statusLabel(s: PaymentOut['status']): string {
    return PAYMENT_STATUS[s] ?? s;
  }
  invStatus(s: string): string {
    return INVOICE_STATUS[s] ?? s;
  }
  provider(p: string): string {
    return PROVIDER_LABEL[p] ?? p;
  }

  async load(): Promise<void> {
    this.loading.set(true);
    const rows = await firstValueFrom(
      this.api.get<PaymentOut[]>('/payments', {
        q: this.q.trim() || null,
        status: this.status || null,
      }),
    ).catch(() => []);
    this.payments.set(rows);
    this.loading.set(false);
  }

  async loadCoupons(): Promise<void> {
    this.coupons.set(await firstValueFrom(this.api.get<Coupon[]>('/coupons')).catch(() => []));
  }

  private replace(p: PaymentOut): void {
    this.payments.update((l) => l.map((x) => (x.id === p.id ? p : x)));
  }

  async refund(p: PaymentOut): Promise<void> {
    const reason = await this.dialog.prompt({
      title: 'Reembolsar pago',
      message: `Se devolverán ${this.money(p.amount_pen)} por ${this.provider(p.provider)} y se cancelará la suscripción. Si hubo comprobante, emite la nota de crédito en Nubefact.`,
      label: 'Motivo',
      minLength: 3,
      confirmText: 'Reembolsar',
    });
    if (reason === null) return;
    const out = await this.mut.post<PaymentOut>(
      `/payments/${p.id}/refund`,
      { reason: reason.trim(), cancel_subscription: true },
      { success: 'Pago reembolsado' },
    );
    if (out) this.replace(out);
  }

  async invoice(p: PaymentOut): Promise<void> {
    const out = await this.mut.post<PaymentOut>(`/payments/${p.id}/invoice`, {}, {});
    if (out) this.replace(out);
  }

  async toggle(c: Coupon): Promise<void> {
    const out = await this.mut.patch<Coupon>(
      `/coupons/${c.id}`,
      { active: !c.active },
      { success: c.active ? 'Cupón desactivado' : 'Cupón activado' },
    );
    if (out) this.coupons.update((l) => l.map((x) => (x.id === out.id ? out : x)));
    else await this.loadCoupons();
  }

  async createCoupon(): Promise<void> {
    const body = {
      code: this.nc.code.trim().toUpperCase(),
      percent_off: this.nc.percent,
      description: this.nc.description.trim(),
      plan_codes: this.nc.plans ? this.nc.plans.split(',') : [],
      first_period_only: this.nc.firstOnly,
    };
    const out = await this.mut.post<Coupon>('/coupons', body, { success: 'Cupón creado' });
    if (out) {
      this.coupons.update((l) => [out, ...l]);
      this.nc = { code: '', percent: null, description: '', plans: '', firstOnly: true };
    }
  }
}
