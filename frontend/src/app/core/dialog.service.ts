import { Injectable, signal } from '@angular/core';
import { WarningItem } from './api-error';

/** `critical`: Escape no cierra el diálogo (hay que elegir con los botones). */
export type DialogRequest = { critical?: boolean } & (
  | {
      kind: 'confirm';
      title: string;
      message: string;
      confirmText?: string;
      danger?: boolean;
      resolve: (v: boolean) => void;
    }
  | {
      kind: 'prompt';
      title: string;
      message?: string;
      label: string;
      minLength: number;
      initial?: string;
      confirmText?: string;
      resolve: (v: string | null) => void;
    }
  | {
      kind: 'warnings';
      title: string;
      message: string;
      warnings: WarningItem[];
      resolve: (v: string | null) => void;
    }
  | {
      kind: 'alert';
      title: string;
      message: string;
      items?: string[];
      resolve: (v: boolean) => void;
    }
  | {
      kind: 'choice';
      title: string;
      message: string;
      items?: string[];
      choices: DialogChoice[];
      cancelText?: string;
      resolve: (v: string | null) => void;
    }
);

/** Opción de un diálogo con varias acciones (p. ej. «Regenerar la llave» / «Dar walkover»). */
export interface DialogChoice {
  value: string;
  label: string;
  hint?: string;
  primary?: boolean;
  danger?: boolean;
}

type Without<T> = T extends unknown ? Omit<T, 'resolve' | 'kind'> : never;

/** Diálogos simples basados en promesas; los dibuja <app-dialog-host>. */
@Injectable({ providedIn: 'root' })
export class DialogService {
  readonly stack = signal<DialogRequest[]>([]);

  private open<T>(req: Omit<DialogRequest, 'resolve'>): Promise<T> {
    return new Promise<T>((resolve) => {
      const full = {
        ...req,
        resolve: (v: T) => {
          this.stack.update((s) => s.filter((x) => x !== full));
          resolve(v);
        },
      } as unknown as DialogRequest;
      this.stack.update((s) => [...s, full]);
    });
  }

  confirm(opts: Without<Extract<DialogRequest, { kind: 'confirm' }>>): Promise<boolean> {
    return this.open<boolean>({ kind: 'confirm', ...opts } as DialogRequest);
  }

  /** Pide un texto (p. ej. motivo). Devuelve null si se cancela. */
  prompt(opts: Without<Extract<DialogRequest, { kind: 'prompt' }>>): Promise<string | null> {
    return this.open<string | null>({ kind: 'prompt', ...opts } as DialogRequest);
  }

  /** Lista advertencias y pide motivo (mín. 3 caracteres). Devuelve el motivo o null. */
  warnings(warnings: WarningItem[], message = 'Hay advertencias que requieren confirmación'): Promise<string | null> {
    return this.open<string | null>({
      kind: 'warnings',
      title: 'Advertencias',
      message,
      warnings,
    } as DialogRequest);
  }

  alert(title: string, message: string, items?: string[]): Promise<boolean> {
    return this.open<boolean>({ kind: 'alert', title, message, items } as DialogRequest);
  }

  /** Varias acciones posibles; devuelve el `value` elegido o null si se cancela. */
  choose(opts: Without<Extract<DialogRequest, { kind: 'choice' }>>): Promise<string | null> {
    return this.open<string | null>({ kind: 'choice', ...opts } as DialogRequest);
  }
}
