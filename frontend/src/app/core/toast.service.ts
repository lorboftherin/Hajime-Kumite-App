import { Injectable, signal } from '@angular/core';

export interface Toast {
  id: number;
  kind: 'ok' | 'danger' | 'warn' | 'info';
  text: string;
  /** Los errores no desaparecen solos: quedan hasta que se cierran. */
  sticky: boolean;
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly toasts = signal<Toast[]>([]);
  private seq = 0;

  /** `ms = 0` deja el aviso fijo hasta que se cierre. */
  show(text: string, kind: Toast['kind'] = 'info', ms = 4500): void {
    // El mismo error repetido (p. ej. reintentos) no se apila: se deja uno solo.
    const same = this.toasts().find((t) => t.sticky && t.text === text && t.kind === kind);
    if (same) return;
    const t: Toast = { id: ++this.seq, kind, text, sticky: ms <= 0 };
    this.toasts.update((l) => [...l, t]);
    if (ms > 0) setTimeout(() => this.dismiss(t.id), ms);
  }
  ok(text: string): void {
    this.show(text, 'ok');
  }
  error(text: string): void {
    this.show(text, 'danger', 0);
  }
  warn(text: string): void {
    this.show(text, 'warn', 6000);
  }
  dismiss(id: number): void {
    this.toasts.update((l) => l.filter((t) => t.id !== id));
  }
}
