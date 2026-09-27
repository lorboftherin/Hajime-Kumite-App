import { HttpErrorResponse } from '@angular/common/http';
import { mensajeDeError } from './i18n/errores';

export interface WarningItem {
  code: string;
  message: string;
}

/** Error uniforme de la API: {"error": {"code", "message", "details"}} (sección 23). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, any> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** 0 = sin conexión / servidor inaccesible. */
  get isNetwork(): boolean {
    return this.status === 0 || this.status === 502 || this.status === 503 || this.status === 504;
  }

  get warnings(): WarningItem[] {
    return this.code === 'WARNINGS' ? ((this.details['warnings'] as WarningItem[]) ?? []) : [];
  }

  /** 402 PLAN_REQUIRED: la función necesita un plan (details.plan / plan_name / feature). */
  get planRequired(): boolean {
    return this.status === 402 && this.code === 'PLAN_REQUIRED';
  }

  /** Mensaje legible, incluyendo errores de validación. */
  get fullMessage(): string {
    const errs = this.details['errors'] as Array<{ loc: unknown[]; msg: string }> | undefined;
    if (this.code === 'VALIDATION_ERROR' && errs?.length) {
      return `${this.message}: ` + errs.map((e) => `${e.loc.filter((x) => x !== 'body').join('.')}: ${e.msg}`).join('; ');
    }
    return this.message;
  }

  static from(err: unknown, body?: unknown): ApiError {
    if (err instanceof ApiError) return err;
    if (err instanceof HttpErrorResponse) {
      const b = (body ?? err.error) as any;
      if (b && typeof b === 'object' && b.error && typeof b.error === 'object') {
        const code: string = b.error.code ?? 'ERROR';
        const details = b.error.details ?? {};
        // En español, el mensaje del servidor; en otros idiomas, traducido por código (core/i18n/errores.ts).
        const message = mensajeDeError(code, b.error.message ?? err.message, details);
        return new ApiError(err.status, code, message, details);
      }
      if (b && typeof b === 'object' && typeof b.detail === 'string') {
        return new ApiError(err.status, 'ERROR', b.detail);
      }
      if (err.status === 0) {
        return new ApiError(0, 'NETWORK', $localize`:@@error.sin-conexion-servidor:Sin conexión con el servidor`);
      }
      return new ApiError(err.status, 'HTTP_' + err.status, err.statusText || $localize`:@@error.error-servidor:Error del servidor`);
    }
    return new ApiError(-1, 'CLIENT', err instanceof Error ? err.message : String(err));
  }
}
