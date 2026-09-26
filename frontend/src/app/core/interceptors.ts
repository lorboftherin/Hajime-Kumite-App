import { HttpErrorResponse, HttpHandlerFn, HttpInterceptorFn, HttpRequest } from '@angular/common/http';
import { inject, untracked } from '@angular/core';
import { Observable, catchError, from, switchMap, throwError } from 'rxjs';
import { ApiError } from './api-error';
import { AuthService } from './auth.service';
import { SessionExpiredService } from './session-expired.service';
import { ToastService } from './toast.service';
import { apiBase } from './server';

/** Agrega el JWT como Bearer a las llamadas a la API. */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  // untracked: si la petición sale desde un effect(), el token no debe volverse dependencia
  // (si no, cerrar sesión re-ejecutaría ese effect y dispararía peticiones sin token → 401).
  const auth = inject(AuthService);
  const token = untracked(() => auth.token());
  if (token && req.url.startsWith(apiBase())) {
    req = req.clone({ setHeaders: { Authorization: `Bearer ${token}` } });
  }
  return next(req);
};

/** En estas rutas un 401 significa credenciales incorrectas, no sesión vencida. */
const CREDENTIAL_PATHS = ['/auth/login', '/auth/change-password', '/auth/delete-account'];
/** Rutas de la propia sesión: su 401 no dispara otra renovación. */
const SESSION_PATHS = ['/auth/refresh', '/auth/logout'];

function endsWithAny(url: string, paths: string[]): boolean {
  const path = url.split('?')[0];
  return paths.some((p) => path.endsWith(p));
}

/** Convierte el error a ApiError (si la respuesta era un Blob de una descarga, lee su JSON). */
function toApiError(err: HttpErrorResponse): Observable<never> {
  if (err.error instanceof Blob) {
    return from(
      err.error.text().then((t) => {
        try {
          return JSON.parse(t);
        } catch {
          return null;
        }
      }),
    ).pipe(switchMap((body) => throwError(() => ApiError.from(err, body))));
  }
  return throwError(() => ApiError.from(err));
}

/**
 * Convierte cualquier error HTTP a ApiError (formato uniforme {error:{code,message,details}}).
 *
 * Ante un 401 renueva el token de acceso en silencio (una sola renovación
 * aunque fallen varias peticiones a la vez) y reintenta la petición una vez.
 * Si la renovación es rechazada, cierra la sesión y lleva al login (la cola
 * de la mesa se conserva: vive en el almacenamiento local).
 */
export const errorInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const expired = inject(SessionExpiredService);
  const toast = inject(ToastService);
  return next(req).pipe(
    catchError((err: unknown) => {
      if (!(err instanceof HttpErrorResponse)) return throwError(() => ApiError.from(err));
      if (err.status === 402) {
        // Plan requerido: aviso claro con «Ver planes», venga de donde venga la petición.
        const e = ApiError.from(err);
        if (e.planRequired) toast.planRequired(e.message);
        return throwError(() => e);
      }
      if (err.status !== 401 || endsWithAny(req.url, CREDENTIAL_PATHS) || endsWithAny(req.url, SESSION_PATHS)) {
        return toApiError(err);
      }
      return renewAndRetry(auth, expired, req, next, err);
    }),
  );
};

/**
 * Sesión cerrada sin remedio. Si hay una pantalla que se encarga del reingreso (la mesa,
 * con eventos en cola), se cierra sin redirigir y ella muestra su panel; si no, al login.
 */
function expireSession(auth: AuthService, expired: SessionExpiredService): void {
  if (expired.notifyExpired()) auth.logout(false, false);
  else auth.logout(true, false);
}

function renewAndRetry(
  auth: AuthService,
  expired: SessionExpiredService,
  req: HttpRequest<unknown>,
  next: HttpHandlerFn,
  original: HttpErrorResponse,
): Observable<any> {
  const sent = req.headers.get('Authorization');
  const current = untracked(() => auth.token());
  // Otra petición ya renovó el token mientras esta viajaba: basta reintentar.
  const renewal: Promise<string> =
    current && sent && sent !== `Bearer ${current}` ? Promise.resolve('ok') : auth.refresh();
  return from(renewal).pipe(
    switchMap((result) => {
      const token = untracked(() => auth.token());
      if (result !== 'ok' || !token) {
        if (result !== 'network') expireSession(auth, expired);
        return toApiError(original);
      }
      return next(req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })).pipe(
        catchError((err: unknown) => {
          if (!(err instanceof HttpErrorResponse)) return throwError(() => ApiError.from(err));
          if (err.status === 401) expireSession(auth, expired); // ni con el token nuevo: sesión cerrada
          return toApiError(err);
        }),
      );
    }),
  );
}
