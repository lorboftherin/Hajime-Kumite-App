import { Injectable, inject } from '@angular/core';
import { Observable, firstValueFrom } from 'rxjs';
import { ApiError } from './api-error';
import { ApiService } from './api.service';
import { DialogService } from './dialog.service';
import { Override } from './models';
import { ToastService } from './toast.service';

export interface MutationOptions {
  /** Mensaje de éxito (toast). */
  success?: string;
  /** Se llama ante VERSION_CONFLICT (409) para recargar los datos. */
  onConflict?: () => void;
  /**
   * Manejo específico de un error. Devuelve true si ya se manejó
   * (no se muestra el toast genérico).
   */
  onError?: (err: ApiError) => boolean | Promise<boolean>;
}

/**
 * "Advertir, no bloquear": toda mutación pasa por aquí.
 * - 409 WARNINGS → diálogo con advertencias + motivo → reenvía la MISMA petición con override={reason}.
 * - 409 VERSION_CONFLICT → aviso "fue modificado por otra persona" y recarga.
 * - Otros errores → toast con el mensaje del servidor.
 * Devuelve el resultado o undefined si se canceló / falló.
 */
@Injectable({ providedIn: 'root' })
export class MutationService {
  private api = inject(ApiService);
  private dialog = inject(DialogService);
  private toast = inject(ToastService);

  async run<T>(send: (override?: Override) => Observable<T>, opts: MutationOptions = {}): Promise<T | undefined> {
    let override: Override | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await firstValueFrom(send(override));
        if (opts.success) this.toast.ok(opts.success);
        return res;
      } catch (e) {
        const err = ApiError.from(e);
        if (err.status === 409 && err.code === 'WARNINGS') {
          const reason = await this.dialog.warnings(err.warnings, err.message);
          if (reason === null) return undefined;
          override = { reason };
          continue;
        }
        if (opts.onError && (await opts.onError(err))) return undefined;
        if (err.code === 'VERSION_CONFLICT') {
          this.toast.warn('El registro fue modificado por otra persona. Se recargaron los datos; revisa y vuelve a intentar.');
          opts.onConflict?.();
          return undefined;
        }
        this.toast.error(err.fullMessage);
        return undefined;
      }
    }
    return undefined;
  }

  /** Atajos: el cuerpo recibe `override` automáticamente cuando el usuario acepta advertencias. */
  post<T>(path: string, body: Record<string, unknown> = {}, opts?: MutationOptions): Promise<T | undefined> {
    return this.run((override) => this.api.post<T>(path, override ? { ...body, override } : body), opts);
  }

  patch<T>(path: string, body: Record<string, unknown> = {}, opts?: MutationOptions): Promise<T | undefined> {
    return this.run((override) => this.api.patch<T>(path, override ? { ...body, override } : body), opts);
  }
}
