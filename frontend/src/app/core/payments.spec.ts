import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { EnvironmentInjector, runInInjectionContext } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ActivatedRouteSnapshot,
  RouterStateSnapshot,
  UrlTree,
  provideRouter,
} from '@angular/router';
import { Observable, firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canSubscribe } from '../features/organizations/plans-page';
import { menuItems } from '../layout/shell';
import { BillingConfig, User } from './models';
import { PaymentsService, paymentsEnabled, paymentsGuard } from './payments';
import { apiBase } from './server';
import { ToastService } from './toast.service';

const config = (on: boolean): BillingConfig => ({
  payments_enabled: on,
  mode: on ? 'enforced' : 'marcha_blanca',
  provider: 'manual',
  culqi_public_key: null,
  invoicing: 'none',
  grace_days: 7,
});

describe('cobros apagados (PaymentsService y guardia)', () => {
  let ctrl: HttpTestingController;
  let svc: PaymentsService;
  const url = `${apiBase()}/billing/config`;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
    ctrl = TestBed.inject(HttpTestingController);
    svc = TestBed.inject(PaymentsService);
  });

  afterEach(() => {
    ctrl.verify();
    TestBed.resetTestingModule();
  });

  function guard(): Promise<boolean | UrlTree> {
    const out = runInInjectionContext(TestBed.inject(EnvironmentInjector), () =>
      paymentsGuard({} as ActivatedRouteSnapshot, {} as RouterStateSnapshot),
    );
    return firstValueFrom(out as Observable<boolean | UrlTree>);
  }

  it('está apagado hasta que el servidor diga lo contrario', async () => {
    expect(svc.enabled()).toBe(false);
    const on = svc.load();
    const p = firstValueFrom(on);
    ctrl.expectOne(url).flush(config(false));
    expect(await p).toBe(false);
    expect(svc.enabled()).toBe(false);
    // Una sola consulta por sesión de la app.
    expect(await firstValueFrom(svc.load())).toBe(false);
  });

  it('se enciende con payments_enabled: true', async () => {
    const p = firstValueFrom(svc.load());
    ctrl.expectOne(url).flush(config(true));
    expect(await p).toBe(true);
    expect(svc.enabled()).toBe(true);
    expect(svc.config()?.provider).toBe('manual');
  });

  it('si la consulta falla, queda apagado (y se reintenta después)', async () => {
    const p = firstValueFrom(svc.load());
    ctrl.expectOne(url).flush({}, { status: 500, statusText: 'Error' });
    expect(await p).toBe(false);
    const again = firstValueFrom(svc.load());
    ctrl.expectOne(url).flush(config(true));
    expect(await again).toBe(true);
  });

  it('las rutas de pago llevan al inicio con los cobros apagados', async () => {
    const p = guard();
    ctrl.expectOne(url).flush(config(false));
    const out = await p;
    expect(out).toBeInstanceOf(UrlTree);
    expect(String(out)).toBe('/');
  });

  it('las rutas de pago se abren con los cobros activos', async () => {
    const p = guard();
    ctrl.expectOne(url).flush(config(true));
    expect(await p).toBe(true);
  });

  it('el aviso de plan requerido va sin «Ver planes» si no hay cobros', () => {
    const toast = TestBed.inject(ToastService);
    toast.planRequired('Necesita plan', false);
    expect(toast.toasts()[0].link).toBeUndefined();
    toast.planRequired('Otro aviso');
    expect(toast.toasts()[1].link?.path).toBe('/planes');
  });
});

describe('ocultamiento de pagos en la interfaz', () => {
  const admin: User = {
    id: 1,
    username: 'admin',
    display_name: 'Admin',
    is_admin: true,
    person_id: null,
  };

  it('solo cuenta como activo si el servidor lo dice', () => {
    expect(paymentsEnabled(null)).toBe(false);
    expect(paymentsEnabled({ payments_enabled: false })).toBe(false);
    expect(paymentsEnabled({} as BillingConfig)).toBe(false);
    expect(paymentsEnabled({ payments_enabled: true })).toBe(true);
  });

  it('el menú «Pagos» del Admin desaparece con los cobros apagados', () => {
    const off = menuItems(admin, true, false).map((it) => it.path);
    expect(off).toContain('/usuarios');
    expect(off).not.toContain('/pagos');
    expect(menuItems(admin, true, true).map((it) => it.path)).toContain('/pagos');
  });

  it('no ofrece «Suscribirse» sin cobros activos, aunque el modo sea enforced', () => {
    const plan = { price_pen_month: 69, price_pen_year: 690 };
    expect(canSubscribe(false, 'enforced', plan)).toBe(false);
    expect(canSubscribe(true, 'marcha_blanca', plan)).toBe(false);
    expect(canSubscribe(true, 'enforced', plan)).toBe(true);
    expect(canSubscribe(true, 'enforced', { price_pen_month: 0, price_pen_year: 0 })).toBe(false);
  });
});
