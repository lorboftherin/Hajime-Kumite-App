import { Component, computed, inject, input, OnInit, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiError } from '../../core/api-error';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { penFromCents } from '../../core/billing';
import {
  BillingConfig,
  BillingPeriod,
  CheckoutOut,
  Plan,
  QuoteOut,
  Subscription,
} from '../../core/models';
import { ToastService } from '../../core/toast.service';
import { Modal } from '../../shared/modal';

/**
 * «Suscribirse» a un plan: periodo (mensual/anual), cupón, organización titular (Dojo y
 * Organizador) o la propia cuenta (Competidor Plus), y la pasarela configurada:
 * Mercado Pago redirige a su página; Culqi abre su Checkout en /pago/culqi/:id.
 */
@Component({
  selector: 'app-subscribe-dialog',
  imports: [FormsModule, Modal],
  template: `
    <app-modal [title]="'Suscribirse a ' + plan().name" (closed)="closed.emit()">
      @if (instructions()) {
        <div class="alert info">{{ instructions() }}</div>
        <div class="form-actions">
          <button class="btn primary" type="button" (click)="closed.emit()">Entendido</button>
        </div>
      } @else {
        <form class="stack" (ngSubmit)="pay()">
          @if (forOrg()) {
            @if (orgs().length) {
              <label class="field">
                <span>Organización</span>
                <select name="org" [(ngModel)]="orgId" required>
                  @for (o of orgs(); track o.id) {
                    <option [ngValue]="o.id">{{ o.name }}</option>
                  }
                </select>
              </label>
            } @else {
              <p class="alert warn small">
                Solo el dueño o un administrador de una organización puede contratar este plan.
              </p>
            }
          }

          <fieldset class="periods">
            <legend>Periodo</legend>
            @if (plan().price_pen_month) {
              <label class="radio">
                <input
                  type="radio"
                  name="period"
                  value="month"
                  [(ngModel)]="period"
                  (ngModelChange)="requote()"
                />
                Mensual · {{ money(plan().price_pen_month) }}
              </label>
            }
            @if (plan().price_pen_year) {
              <label class="radio">
                <input
                  type="radio"
                  name="period"
                  value="year"
                  [(ngModel)]="period"
                  (ngModelChange)="requote()"
                />
                Anual · {{ money(plan().price_pen_year) }}
              </label>
            }
          </fieldset>

          <div class="row coupon">
            <label class="field grow">
              <span>Cupón (opcional)</span>
              <input name="coupon" [(ngModel)]="coupon" autocomplete="off" placeholder="CODIGO" />
            </label>
            <button type="button" class="btn" (click)="requote()" [disabled]="!coupon.trim()">
              Aplicar
            </button>
          </div>
          @if (quoteError()) {
            <p class="alert danger small">{{ quoteError() }}</p>
          }

          @if (config()?.provider === 'mercadopago') {
            <label class="field">
              <span>Correo de tu cuenta de Mercado Pago{{ period === 'month' ? ' *' : '' }}</span>
              <input name="email" type="email" [(ngModel)]="email" autocomplete="email" />
              @if (period === 'month') {
                <small class="muted">El pago mensual se renueva solo con esa cuenta.</small>
              }
            </label>
          }

          @if (!forOrg()) {
            <div class="grid-2">
              <label class="field">
                <span>DNI para la boleta (opcional)</span>
                <input
                  name="dni"
                  [(ngModel)]="dni"
                  inputmode="numeric"
                  maxlength="8"
                  pattern="[0-9]{8}"
                />
              </label>
              <label class="field">
                <span>Nombre en la boleta</span>
                <input name="bn" [(ngModel)]="billingName" maxlength="200" />
              </label>
            </div>
          }

          @if (quote(); as q) {
            <div class="summary card">
              <div class="line">
                <span>Precio</span><span class="num">{{ cents(q.list_cents) }}</span>
              </div>
              @if (q.discount_cents) {
                <div class="line">
                  <span>Cupón {{ q.coupon_code }}</span
                  ><span class="num">− {{ cents(q.discount_cents) }}</span>
                </div>
              }
              <div class="line total">
                <span>A pagar hoy</span><span class="num">{{ cents(q.first_cents) }}</span>
              </div>
              @if (q.recurring_cents !== q.first_cents) {
                <p class="small muted">
                  Las renovaciones se cobran a {{ cents(q.recurring_cents) }}.
                </p>
              }
            </div>
          }

          <div class="form-actions">
            @if (forOrg() && plan().trial_days && orgs().length) {
              <button type="button" class="btn" (click)="trial()" [disabled]="busy()">
                Probar {{ plan().trial_days }} días gratis
              </button>
            }
            <button class="btn primary" [disabled]="busy() || !canPay()">
              @if (busy()) {
                <span class="spinner"></span>
              }
              Continuar al pago
            </button>
          </div>
        </form>
      }
    </app-modal>
  `,
  styles: `
    .periods {
      border: 0;
      padding: 0;
      margin: 0;
      display: flex;
      gap: 1.25rem;
      flex-wrap: wrap;
      legend {
        font-weight: 600;
        margin-bottom: 0.35rem;
      }
    }
    .radio {
      display: inline-flex;
      gap: 0.4rem;
      align-items: center;
    }
    .coupon {
      gap: 0.5rem;
      align-items: flex-end;
    }
    .grow {
      flex: 1;
    }
    .summary {
      padding: 0.75rem 1rem;
      .line {
        display: flex;
        justify-content: space-between;
        gap: 1rem;
      }
      .total {
        font-weight: 700;
        border-top: 1px solid var(--kasumi);
        margin-top: 0.35rem;
        padding-top: 0.35rem;
      }
    }
  `,
})
export class SubscribeDialog implements OnInit {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private router = inject(Router);
  private toast = inject(ToastService);

  readonly plan = input.required<Plan>();
  readonly config = input<BillingConfig | null>(null);
  readonly closed = output<void>();

  readonly quote = signal<QuoteOut | null>(null);
  readonly quoteError = signal('');
  readonly busy = signal(false);
  readonly instructions = signal('');
  readonly forOrg = computed(() => this.plan().audience !== 'person');
  /** Organizaciones que el usuario administra (dueño o administrador). */
  readonly orgs = computed(() =>
    (this.auth.user()?.organizations ?? []).filter((o) => o.role === 'owner' || o.role === 'admin'),
  );

  period: BillingPeriod = 'month';
  coupon = '';
  email = '';
  dni = '';
  billingName = '';
  orgId: number | null = null;

  ngOnInit(): void {
    const p = this.plan();
    this.period = p.price_pen_month ? 'month' : 'year';
    this.orgId = this.orgs()[0]?.id ?? null;
    this.billingName = this.auth.user()?.display_name ?? '';
    void this.requote();
  }

  money(v: number | null): string {
    return penFromCents(Math.round((v ?? 0) * 100));
  }
  cents(v: number): string {
    return penFromCents(v);
  }

  canPay(): boolean {
    if (this.forOrg() && !this.orgId) return false;
    if (
      this.config()?.provider === 'mercadopago' &&
      this.period === 'month' &&
      !this.email.trim()
    ) {
      // Sin correo solo se puede si el cupón hace que el primer mes sea un pago único.
      const q = this.quote();
      return !!q && q.first_cents !== q.recurring_cents;
    }
    return !this.dni || /^\d{8}$/.test(this.dni);
  }

  async requote(): Promise<void> {
    this.quoteError.set('');
    try {
      this.quote.set(
        await firstValueFrom(
          this.api.get<QuoteOut>(`/plans/${this.plan().code}/quote`, {
            period: this.period,
            coupon_code: this.coupon.trim() || null,
          }),
        ),
      );
    } catch (e) {
      this.quote.set(null);
      this.quoteError.set(ApiError.from(e).message);
    }
  }

  async trial(): Promise<void> {
    if (!this.orgId) return;
    this.busy.set(true);
    try {
      await firstValueFrom(
        this.api.post<Subscription>(`/organizations/${this.orgId}/trial`, {
          plan_code: this.plan().code,
        }),
      );
      this.toast.ok(`Prueba de ${this.plan().trial_days} días activada`);
      this.auth.refreshMe();
      this.closed.emit();
      void this.router.navigate(['/organizacion', this.orgId]);
    } catch (e) {
      this.toast.error(ApiError.from(e).message);
    }
    this.busy.set(false);
  }

  async pay(): Promise<void> {
    if (!this.canPay()) return;
    this.busy.set(true);
    const body = {
      plan_code: this.plan().code,
      period: this.period,
      coupon_code: this.coupon.trim() || null,
      payer_email: this.email.trim() || null,
      billing_doc: this.forOrg() ? null : this.dni.trim() || '',
      billing_name: this.forOrg() ? null : this.billingName.trim(),
    };
    const path = this.forOrg() ? `/organizations/${this.orgId}/checkout` : '/me/checkout';
    try {
      const co = await firstValueFrom(this.api.post<CheckoutOut>(path, body));
      this.handle(co);
    } catch (e) {
      this.toast.error(ApiError.from(e).message);
      this.busy.set(false);
    }
  }

  private handle(co: CheckoutOut): void {
    if (co.status === 'active' || co.provider === 'coupon') {
      this.closed.emit();
      void this.router.navigate(['/pago/exito'], {
        queryParams: { subscription_id: co.subscription_id },
      });
    } else if (co.url) {
      // Mercado Pago: se paga en su página y vuelve a /pago/exito|pendiente|error.
      window.location.assign(co.url);
    } else if (co.provider === 'culqi') {
      this.closed.emit();
      void this.router.navigate(['/pago/culqi', co.subscription_id]);
    } else {
      this.busy.set(false);
      this.instructions.set(co.instructions);
    }
  }
}
