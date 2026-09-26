import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { apiBase } from './server';

type Params = Record<string, string | number | boolean | null | undefined>;

function toParams(p?: Params): HttpParams {
  let hp = new HttpParams();
  for (const [k, v] of Object.entries(p ?? {})) {
    if (v !== null && v !== undefined && v !== '') hp = hp.set(k, String(v));
  }
  return hp;
}

/** Envoltura fina de HttpClient para /api/v1. Todos los errores llegan como ApiError (ver interceptor). */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);

  get<T>(path: string, params?: Params): Observable<T> {
    return this.http.get<T>(apiBase() + path, { params: toParams(params) });
  }

  post<T>(path: string, body: unknown = {}, params?: Params): Observable<T> {
    return this.http.post<T>(apiBase() + path, body, { params: toParams(params) });
  }

  patch<T>(path: string, body: unknown = {}): Observable<T> {
    return this.http.patch<T>(apiBase() + path, body);
  }

  put<T>(path: string, body: unknown = {}): Observable<T> {
    return this.http.put<T>(apiBase() + path, body);
  }

  delete<T>(path: string): Observable<T> {
    return this.http.delete<T>(apiBase() + path);
  }

  upload<T>(path: string, file: File, field = 'file'): Observable<T> {
    const fd = new FormData();
    fd.append(field, file, file.name);
    return this.http.post<T>(apiBase() + path, fd);
  }

  blob(path: string, params?: Params): Observable<Blob> {
    return this.http.get(apiBase() + path, { params: toParams(params), responseType: 'blob' });
  }
}
