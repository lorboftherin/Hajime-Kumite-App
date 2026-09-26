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
      <app-page-head i18n-title="@@cobro.admin.pagos" kanji="会計" title="Pagos">
        <div meta class="meta-line">
          @if (config(); as c) {
            <span i18n="@@cobro.admin.pasarela">Pasarela: {{ provider(c.provider) }}</span>
            <span i18n="@@cobro.admin.comprobantes"
              >Comprobantes: {c.invoicing, select, nubefact {Nubefact} other {desactivados}}</span
            >
            <span i18n="@@cobro.admin.modo">Modo: {c.mode, select, enforced {cobro activo} other {marcha blanca}}</span>
          }
        </div>
      </app-page-head>

      <form class="row filters" (ngSubmit)="load()">
        <input i18n-aria-label="@@cobro.admin.buscar-pagos" i18n-placeholder="@@cobro.admin.referencia-organizacion-usuario"
          name="q"
          [(ngModel)]="q"
          placeholder="Referencia, organización o usuario"
          aria-label="Buscar pagos"
        />
        <select i18n-aria-label="@@cobro.admin.estado" name="st" [(ngModel)]="status" aria-label="Estado" (ngModelChange)="load()">
          <option i18n="@@cobro.admin.todos-estados" value="">Todos los estados</option>
          <option i18n="@@cobro.admin.aprobados" value="approved">Aprobados</option>
          <option i18n="@@cobro.admin.pendientes" value="pending">Pendientes</option>
          <option i18n="@@cobro.admin.rechazados" value="rejected">Rechazados</option>
          <option i18n="@@cobro.admin.reembolsados" value="refunded">Reembolsados</option>
        </select>
        <button i18n="@@cobro.admin.buscar" class="btn"><app-icon name="search" /> Buscar</button>
      </form>

      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th i18n="@@cobro.admin.fecha">Fecha</th>
              <th i18n="@@cobro.admin.titular">Titular</th>
              <th i18n="@@cobro.admin.plan">Plan</th>
              <th i18n="@@cobro.admin.monto" class="right">Monto</th>
              <th i18n="@@cobro.admin.estado-2">Estado</th>
              <th i18n="@@cobro.admin.pasarela-2">Pasarela</th>
              <th i18n="@@cobro.admin.comprobante">Comprobante</th>
              <th><span i18n="@@cobro.admin.acciones" class="sr-only">Acciones</span></th>
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
                      <ng-container i18n="@@cobro.admin.nota-credito"><br />Nota de crédito
                      </ng-container>@if (nc.pdf_url) {
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
                      <button i18n="@@cobro.admin.emitir-comprobante" class="btn sm" (click)="invoice(p)">Emitir comprobante</button>
                    }
                  }
                  @if (p.status === 'refunded' && p.credit_note?.status === 'error') {
                    <button i18n="@@cobro.admin.reintentar-nota-credito" class="btn sm" (click)="invoice(p)">Reintentar nota de crédito</button>
                  }
                  @if (p.status === 'approved') {
                    <button i18n="@@cobro.admin.reembolsar" class="btn sm ghost" (click)="refund(p)">Reembolsar</button>
                  }
                </td>
              </tr>
            } @empty {
              <tr>
                <td colspan="8" class="muted small">
                  @if (loading()) {
                    <span class="spinner"></span>
                  } @else {<ng-container i18n="@@cobro.admin.sin-pagos">
                    Sin pagos.
                  </ng-container>}
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>

      <section class="card coupons" aria-labelledby="h-cupones">
        <h2 i18n="@@cobro.admin.cupones" id="h-cupones">Cupones</h2>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th i18n="@@cobro.admin.codigo">Código</th>
                <th i18n="@@cobro.admin.descuento">Descuento</th>
                <th i18n="@@cobro.admin.planes">Planes</th>
                <th i18n="@@cobro.admin.usos">Usos</th>
                <th i18n="@@cobro.admin.vence">Vence</th>
                <th i18n="@@cobro.admin.activo">Activo</th>
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
                    <span class="small muted">@if (c.first_period_only) {<ng-container i18n="@@cobro.admin.primer-periodo">(primer periodo)</ng-container>} @else {<ng-container i18n="@@cobro.admin.siempre">(siempre)</ng-container>}</span>
                  </td>
                  <td class="small">
                    @if (c.plan_codes.length) {
                      {{ c.plan_codes.join(', ') }}
                    } @else {
                      <ng-container i18n="@@cobro.admin.planes-todos">Todos</ng-container>
                    }
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
                      [attr.aria-label]="ariaCupon(c.code)"
                    />
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        <form class="row new-coupon" (ngSubmit)="createCoupon()">
          <input i18n-aria-label="@@cobro.admin.codigo-3" i18n-placeholder="@@cobro.admin.codigo-2"
            name="cc"
            [(ngModel)]="nc.code"
            placeholder="CÓDIGO"
            aria-label="Código"
            required
          />
          <input i18n-aria-label="@@cobro.admin.porcentaje-descuento" i18n-placeholder="@@cobro.admin.desc"
            name="cp"
            type="number"
            min="1"
            max="100"
            [(ngModel)]="nc.percent"
            placeholder="% desc."
            aria-label="Porcentaje de descuento"
          />
          <input i18n-aria-label="@@cobro.admin.descripcion" i18n-placeholder="@@cobro.admin.descripcion"
            name="cd"
            [(ngModel)]="nc.description"
            placeholder="Descripción"
            aria-label="Descripción"
          />
          <select i18n-aria-label="@@cobro.admin.planes-2" name="cpl" [(ngModel)]="nc.plans" aria-label="Planes">
            <option i18n="@@cobro.admin.todos-planes" value="">Todos los planes</option>
            <option i18n="@@cobro.admin.dojo-organizador" value="dojo,organizador">Dojo y Organizador</option>
            <option i18n="@@cobro.admin.competidor-plus" value="competidor_plus">Competidor Plus</option>
          </select>
          <label i18n="@@cobro.admin.solo-primer-periodo" class="small"
            ><input type="checkbox" name="cf" [(ngModel)]="nc.firstOnly" /> Solo primer
            periodo</label
          >
          <button i18n="@@cobro.admin.crear" class="btn" [disabled]="!nc.code.trim() || !nc.percent">
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

  ariaCupon(code: string): string {
    return $localize`:@@cobro.admin.cupon-activo:Cupón ${code}:codigo: activo`;
  }

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
      title: $localize`:@@cobro.admin.reembolsar-pago:Reembolsar pago`,
      message: $localize`:@@cobro.admin.devolveran-cancelara-suscripcion:Se devolverán ${this.money(p.amount_pen)}:money: por ${this.provider(p.provider)}:provider: y se cancelará la suscripción. Si hubo comprobante, emite la nota de crédito en Nubefact.`,
      label: $localize`:@@cobro.admin.motivo:Motivo`,
      minLength: 3,
      confirmText: $localize`:@@cobro.admin.reembolsar-2:Reembolsar`,
    });
    if (reason === null) return;
    const out = await this.mut.post<PaymentOut>(
      `/payments/${p.id}/refund`,
      { reason: reason.trim(), cancel_subscription: true },
      { success: $localize`:@@cobro.admin.pago-reembolsado:Pago reembolsado` },
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
      { success: c.active ? $localize`:@@cobro.admin.cupon-desactivado:Cupón desactivado` : $localize`:@@cobro.admin.cupon-activado:Cupón activado` },
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
    const out = await this.mut.post<Coupon>('/coupons', body, { success: $localize`:@@cobro.admin.cupon-creado:Cupón creado` });
    if (out) {
      this.coupons.update((l) => [out, ...l]);
      this.nc = { code: '', percent: null, description: '', plans: '', firstOnly: true };
    }
  }
}
