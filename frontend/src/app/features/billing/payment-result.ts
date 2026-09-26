import { Component, DestroyRef, OnInit, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { fmtDate } from '../../core/format';
import { Subscription } from '../../core/models';
import { PageHead } from '../../shared/page-head';

type Result = 'exito' | 'pendiente' | 'error';

const TEXT: Record<Result, { title: string; kanji: string; body: string; cls: string }> = {
  exito: {
    title: 'Pago recibido',
    kanji: '完了',
    body: 'Gracias. En cuanto la pasarela confirme el pago, tu plan queda activo (suele tardar unos segundos).',
    cls: 'ok',
  },
  pendiente: {
    title: 'Pago pendiente',
    kanji: '保留',
    body: 'La pasarela todavía está procesando el pago (por ejemplo, un pago en efectivo o por transferencia). Te avisaremos cuando se confirme.',
    cls: 'info',
  },
  error: {
    title: 'El pago no se completó',
    kanji: '失敗',
    body: 'No se realizó ningún cobro. Puedes intentarlo otra vez con otra tarjeta o medio de pago.',
    cls: 'danger',
  },
};

/** Páginas de retorno de la pasarela: /pago/exito, /pago/pendiente y /pago/error. */
@Component({
  selector: 'app-payment-result',
  imports: [RouterLink, PageHead],
  template: `
    @let t = text();
    <div class="container narrow">
      <app-page-head [kanji]="t.kanji" [title]="t.title" />
      <div class="alert" [class]="t.cls">{{ t.body }}</div>
      @if (sub(); as s) {
        <section class="card">
          <p>
            <strong>{{ s.plan_name }}</strong> ·
            @if (s.is_current) {
              <span class="badge matcha">Activa</span>
              @if (s.current_period_end) {
                hasta el {{ date(s.current_period_end) }}
              }
            } @else {
              <span class="badge plain">Esperando confirmación</span>
            }
          </p>
        </section>
      }
      <div class="form-actions">
        @if (result() === 'error') {
          <a class="btn primary" routerLink="/planes">Intentar otra vez</a>
        }
        @if (sub()?.organization_id; as oid) {
          <a class="btn" [routerLink]="['/organizacion', oid]">Ir a la organización</a>
        } @else {
          <a class="btn" routerLink="/planes">Ver mis planes</a>
        }
      </div>
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
export class PaymentResultPage implements OnInit {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private destroyed = false;

  /** Dato de la ruta. */
  readonly result = input<Result>('exito');
  /** ?subscription_id= (lo agrega Hajime a las URL de retorno). */
  readonly subscription_id = input<string>();
  readonly sub = signal<Subscription | null>(null);

  constructor() {
    inject(DestroyRef).onDestroy(() => (this.destroyed = true));
  }

  text() {
    return TEXT[this.result()] ?? TEXT.exito;
  }
  date(v: string): string {
    return fmtDate(v.slice(0, 10));
  }

  async ngOnInit(): Promise<void> {
    const id = Number(this.subscription_id() ?? 0);
    if (!id) return;
    // El aviso de la pasarela puede llegar unos segundos después del retorno: se consulta
    // unas cuantas veces hasta verla activa.
    for (let i = 0; i < 6 && !this.destroyed; i++) {
      const s = await firstValueFrom(
        this.api.get<Subscription>(`/subscriptions/${id}/status`),
      ).catch(() => null);
      if (s) this.sub.set(s);
      if (!s || s.is_current || this.result() === 'error') break;
      await new Promise((r) => setTimeout(r, 2500));
    }
    if (this.sub()?.is_current) this.auth.refreshMe();
  }
}
