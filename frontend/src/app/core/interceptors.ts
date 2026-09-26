import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject, untracked } from '@angular/core';
import { catchError, from, switchMap, throwError } from 'rxjs';
import { ApiError } from './api-error';
import { AuthService } from './auth.service';
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

/**
 * Convierte cualquier error HTTP a ApiError (formato uniforme {error:{code,message,details}}).
 * Si la respuesta era un Blob (descargas), lee su JSON. En 401 cierra la sesión.
 */
export const errorInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  return next(req).pipe(
    catchError((err: unknown) => {
      if (!(err instanceof HttpErrorResponse)) return throwError(() => ApiError.from(err));
      // En login y cambio de contraseña, 401 = credenciales incorrectas (no sesión vencida).
      if (err.status === 401 && !req.url.endsWith('/auth/login') && !req.url.endsWith('/auth/change-password')) {
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
