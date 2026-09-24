import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, from, switchMap, throwError } from 'rxjs';
import { ApiError } from './api-error';
import { AuthService } from './auth.service';

/** Agrega el JWT como Bearer a las llamadas a la API. */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const token = inject(AuthService).token();
  if (token && req.url.startsWith('/api/')) {
    req = req.clone({ setHeaders: { Authorization: `Bearer ${token}` } });
  }
  return next(req);
};

/**
 * Convierte cualquier error HTTP a ApiError (formato uniforme {error:{code,message,details}}).
 * Si la respuesta era un Blob (descargas), lee su JSON. En 401 cierra la sesión.
 */
export const errorInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  return next(req).pipe(
    catchError((err: unknown) => {
      if (!(err instanceof HttpErrorResponse)) return throwError(() => ApiError.from(err));
      if (err.status === 401 && !req.url.endsWith('/auth/login')) {
        auth.logout(true);
      }
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
    }),
  );
};
