import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Injectable, InjectionToken, inject } from '@angular/core';
import { Observable, TimeoutError, catchError, throwError, timeout } from 'rxjs';
import { ApiError } from './api-error';
import { apiBase } from './server';

type Params = Record<string, string | number | boolean | null | undefined>;

/** Tiempo máximo de espera de una petición a la API (ms). 0 = sin límite. */
export const API_TIMEOUT_MS = new InjectionToken<number>('API_TIMEOUT_MS', {
  providedIn: 'root',
  factory: () => 8000,
});

/** Para subir archivos o descargar PDF/Excel, que tardan más que una petición normal. */
export const LONG_TIMEOUT_MS = 60000;

export interface RequestOptions {
  /** Cabeceras extra (p. ej. X-Device-Id de la mesa). */
  headers?: Record<string, string>;
  /** Límite propio para esta petición (ms); 0 = sin límite. */
  timeoutMs?: number;
}

function toParams(p?: Params): HttpParams {
  let hp = new HttpParams();
  for (const [k, v] of Object.entries(p ?? {})) {
    if (v !== null && v !== undefined && v !== '') hp = hp.set(k, String(v));
  }
  return hp;
}

/** Error de «el servidor no respondió a tiempo»: la mesa lo trata como sin conexión y reintenta. */
export function timeoutError(): ApiError {
  return new ApiError(0, 'TIMEOUT', $localize`:@@error.servidor-no-respondio-tiempo:El servidor no respondió a tiempo`);
}

/** Corta la espera a los `ms` milisegundos con el error TIMEOUT (0 = sin límite). */
export function withTimeout<T>(obs: Observable<T>, ms: number): Observable<T> {
  if (!ms) return obs;
  return obs.pipe(
    timeout(ms),
    catchError((e: unknown) => throwError(() => (e instanceof TimeoutError ? timeoutError() : e))),
  );
}

/**
 * Envoltura fina de HttpClient para /api/v1. Todos los errores llegan como ApiError (ver interceptor).
 * Cada petición tiene un límite de tiempo (8 s por defecto): una red colgada no deja la pantalla
 * esperando para siempre, y el error `TIMEOUT` se reintenta como un corte de red.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);
  private defaultTimeout = inject(API_TIMEOUT_MS);

  private limit<T>(obs: Observable<T>, ms = this.defaultTimeout): Observable<T> {
    return withTimeout(obs, ms);
  }

  private headers(opts?: RequestOptions): HttpHeaders | undefined {
    return opts?.headers ? new HttpHeaders(opts.headers) : undefined;
  }

  get<T>(path: string, params?: Params, opts?: RequestOptions): Observable<T> {
    return this.limit(
      this.http.get<T>(apiBase() + path, { params: toParams(params), headers: this.headers(opts) }),
      opts?.timeoutMs,
    );
  }

  post<T>(path: string, body: unknown = {}, params?: Params, opts?: RequestOptions): Observable<T> {
    return this.limit(
      this.http.post<T>(apiBase() + path, body, {
        params: toParams(params),
        headers: this.headers(opts),
      }),
      opts?.timeoutMs,
    );
  }

  patch<T>(path: string, body: unknown = {}, opts?: RequestOptions): Observable<T> {
    return this.limit(
      this.http.patch<T>(apiBase() + path, body, { headers: this.headers(opts) }),
      opts?.timeoutMs,
    );
  }

  put<T>(path: string, body: unknown = {}, opts?: RequestOptions): Observable<T> {
    return this.limit(
      this.http.put<T>(apiBase() + path, body, { headers: this.headers(opts) }),
      opts?.timeoutMs,
    );
  }

  delete<T>(path: string, opts?: RequestOptions): Observable<T> {
    return this.limit(
      this.http.delete<T>(apiBase() + path, { headers: this.headers(opts) }),
      opts?.timeoutMs,
    );
  }

  upload<T>(path: string, file: File, field = 'file'): Observable<T> {
    const fd = new FormData();
    fd.append(field, file, file.name);
    return this.limit(this.http.post<T>(apiBase() + path, fd), LONG_TIMEOUT_MS);
  }

  blob(path: string, params?: Params): Observable<Blob> {
    return this.limit(
      this.http.get(apiBase() + path, { params: toParams(params), responseType: 'blob' }),
      LONG_TIMEOUT_MS,
    );
  }
}
