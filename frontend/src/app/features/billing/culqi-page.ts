import { Component, inject, input, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiError } from '../../core/api-error';
import { ApiService } from '../../core/api.service';
import { loadCulqi, openCulqi, penFromCents } from '../../core/billing';
import { BillingConfig, PaymentOut, Subscription } from '../../core/models';
import { PageHead } from '../../shared/page-head';

/**
 * Pago con Culqi Checkout. El script de Culqi se carga solo aquí; la tarjeta (o Yape) va directo
 * a Culqi y Hajime recibe un token de un solo uso que el servidor cobra.
 */
@Component({
  selector: 'app-culqi-page',
  imports: [FormsModule, RouterLink, PageHead],
  template: `
    <div class="container narrow">
      <app-page-head kanji="支払" title="Pago con Culqi" />
      @if (error()) {
        <div class="alert danger">{{ error() }}</div>
      }
      @if (sub(); as s) {
        <section class="card stack">
          <p>
            <strong>{{ s.plan_name }}</strong> · {{ s.period === 'year' ? 'anual' : 'mensual' }} ·
            <span class="num">{{ amount() }}</span>
          </p>
          @if (s.period === 'month' && recurringHint()) {
            <p class="small muted">
              Para que el pago mensual se renueve solo, indica tu nombre y celular (Culqi los pide
              para la suscripción). Si los dejas vacíos, se cobra solo este mes.
            </p>
            <div class="grid-2">
              <label class="field"
                ><span>Nombres</span><input name="fn" [(ngModel)]="firstName" maxlength="50"
              /></label>
              <label class="field"
                ><span>Apellidos</span><input name="ln" [(ngModel)]="lastName" maxlength="50"
              /></label>
              <label class="field"
                ><span>Celular</span
                ><input name="ph" [(ngModel)]="phone" inputmode="tel" maxlength="15"
              /></label>
            </div>
          }
          <div class="form-actions">
            <a class="btn" routerLink="/planes">Volver</a>
            <button class="btn primary" type="button" (click)="pay()" [disabled]="busy()">
              @if (busy()) {
                <span class="spinner"></span>
              }
              Pagar {{ amount() }}
            </button>
          </div>
          <p class="small muted">
            Pago seguro procesado por Culqi. Hajime no ve ni guarda los datos de tu tarjeta.
          </p>
        </section>
      } @else if (!error()) {
        <div class="empty"><span class="spinner"></span></div>
      }
    </div>
  `,
  styles: `
    .narrow {
      max-width: 44rem;
    }
    .card {
      margin-top: 1rem;
    }
  `,
})
export class CulqiPage implements OnInit {
  private api = inject(ApiService);
  private router = inject(Router);

  /** Id de la suscripción (ruta /pago/culqi/:id). */
  readonly id = input.required<string>();
  readonly sub = signal<Subscription | null>(null);
  readonly config = signal<BillingConfig | null>(null);
  readonly error = signal('');
  readonly busy = signal(false);
  readonly recurringHint = signal(true);
  firstName = '';
  lastName = '';
  phone = '';

  amount(): string {
    return penFromCents(this.sub()?.amount_cents ?? 0);
  }

  async ngOnInit(): Promise<void> {
    try {
      const [sub, config] = await Promise.all([
        firstValueFrom(this.api.get<Subscription>(`/subscriptions/${this.id()}/status`)),
        firstValueFrom(this.api.get<BillingConfig>('/billing/config')),
      ]);
      this.sub.set(sub);
      this.config.set(config);
      if (!config.culqi_public_key) this.error.set('El pago con Culqi no está disponible ahora.');
      else if (sub.is_current && sub.status === 'active' && !sub.in_grace)
        this.error.set('Esta suscripción ya está pagada.');
    } catch (e) {
      this.error.set(ApiError.from(e).message);
    }
  }

  async pay(): Promise<void> {
    const sub = this.sub();
    const key = this.config()?.culqi_public_key;
    if (!sub || !key) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const culqi = await loadCulqi();
      const res = await openCulqi(culqi, {
        publicKey: key,
        title: 'Hajime',
        description: `${sub.plan_name} (${sub.period === 'year' ? 'anual' : 'mensual'})`,
        amountCents: sub.amount_cents ?? 0,
      });
      if ('error' in res) {
        this.error.set(res.error);
        this.busy.set(false);
        return;
      }
      const pay = await firstValueFrom(
        this.api.post<PaymentOut>('/payments/culqi/charge', {
          subscription_id: sub.id,
          token: res.token,
          email: res.email,
          first_name: this.firstName.trim() || null,
          last_name: this.lastName.trim() || null,
          phone: this.phone.trim() || null,
        }),
      );
      const page =
        pay.status === 'approved' ? 'exito' : pay.status === 'pending' ? 'pendiente' : 'error';
      void this.router.navigate(['/pago', page], { queryParams: { subscription_id: sub.id } });
    } catch (e) {
      this.error.set(
        e instanceof Error && !(e instanceof ApiError) ? e.message : ApiError.from(e).message,
      );
    }
    this.busy.set(false);
  }
}
