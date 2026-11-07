import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from './auth.service';
import { authInterceptor, errorInterceptor } from './interceptors';
import { TokenOut } from './models';
import { apiBase } from './server';

const user = { id: 1, username: 'mesa', display_name: 'Mesa', is_admin: false, person_id: null };

function tokens(access: string, refresh: string): TokenOut {
  return {
    access_token: access,
    refresh_token: refresh,
    token_type: 'bearer',
    expires_in: 3600,
    user,
  };
}

/** Deja que corran las promesas pendientes (la renovación es asíncrona). */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('renovación silenciosa de la sesión', () => {
  let http: HttpClient;
  let ctrl: HttpTestingController;
  let auth: AuthService;
  const api = apiBase();

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('hajime.token', JSON.stringify('viejo'));
    localStorage.setItem('hajime.refresh', JSON.stringify('r1'));
    localStorage.setItem('hajime.user', JSON.stringify(user));
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'login', children: [] }]),
        provideHttpClient(withInterceptors([authInterceptor, errorInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpClient);
    ctrl = TestBed.inject(HttpTestingController);
    auth = TestBed.inject(AuthService);
  });

  afterEach(() => {
    ctrl.verify();
    TestBed.resetTestingModule();
    localStorage.clear();
  });

  it('una sola renovación aunque fallen varias peticiones a la vez, y todas se reintentan', async () => {
    const results: unknown[] = [];
    for (const path of ['/a', '/b', '/c']) {
      http.get(`${api}${path}`).subscribe((r) => results.push(r));
    }
    for (const path of ['/a', '/b', '/c']) {
      const req = ctrl.expectOne(`${api}${path}`);
      expect(req.request.headers.get('Authorization')).toBe('Bearer viejo');
      req.flush(
        { error: { code: 'UNAUTHORIZED', message: 'vencida' } },
        { status: 401, statusText: 'Unauthorized' },
      );
    }
    await settle();
    const refresh = ctrl.expectOne(`${api}/auth/refresh`);
    expect(refresh.request.body).toEqual({ refresh_token: 'r1' });
    refresh.flush(tokens('nuevo', 'r2'));
    await settle();
    for (const path of ['/a', '/b', '/c']) {
      const retry = ctrl.expectOne(`${api}${path}`);
      expect(retry.request.headers.get('Authorization')).toBe('Bearer nuevo');
      retry.flush({ ok: path });
    }
    expect(results).toHaveLength(3);
    expect(auth.token()).toBe('nuevo');
    expect(JSON.parse(localStorage.getItem('hajime.refresh')!)).toBe('r2');
  });

  it('si la renovación es rechazada, cierra la sesión sin volver a llamar al servidor', async () => {
    let error: unknown = null;
    http.get(`${api}/a`).subscribe({ error: (e) => (error = e) });
    ctrl.expectOne(`${api}/a`).flush({}, { status: 401, statusText: 'Unauthorized' });
    await settle();
    ctrl
      .expectOne(`${api}/auth/refresh`)
      .flush(
        { error: { code: 'UNAUTHORIZED', message: 'no' } },
        { status: 401, statusText: 'Unauthorized' },
      );
    await settle();
    expect(error).not.toBeNull();
    expect(auth.token()).toBeNull();
    expect(auth.refreshToken()).toBeNull();
    expect(localStorage.getItem('hajime.refresh')).toBeNull();
    ctrl.expectNone(`${api}/auth/logout`);
  });

  it('refresh() concurrente comparte la misma petición', async () => {
    const p1 = auth.refresh();
    const p2 = auth.refresh();
    ctrl.expectOne(`${api}/auth/refresh`).flush(tokens('nuevo', 'r2'));
    expect(await p1).toBe('ok');
    expect(await p2).toBe('ok');
  });

  it('sin conexión no cierra la sesión y activa el aviso', async () => {
    const p = auth.refresh();
    ctrl.expectOne(`${api}/auth/refresh`).error(new ProgressEvent('error'), { status: 0 });
    expect(await p).toBe('network');
    expect(auth.token()).toBe('viejo');
    expect(auth.refreshFailed()).toBe(true);
  });

  it('cerrar sesión revoca el token de renovación en el servidor', async () => {
    auth.logout(false);
    const req = ctrl.expectOne(`${api}/auth/logout`);
    expect(req.request.body).toEqual({ refresh_token: 'r1' });
    req.flush(null, { status: 204, statusText: 'No Content' });
    expect(auth.token()).toBeNull();
    const after = firstValueFrom(http.get(`${api}/x`));
    const req2 = ctrl.expectOne(`${api}/x`);
    expect(req2.request.headers.has('Authorization')).toBe(false);
    req2.flush({});
    await after;
  });
});
