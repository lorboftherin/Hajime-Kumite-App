import { Injectable, signal } from '@angular/core';

export interface Toast {
  id: number;
  kind: 'ok' | 'danger' | 'warn' | 'info';
  text: string;
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly toasts = signal<Toast[]>([]);
  private seq = 0;

  show(text: string, kind: Toast['kind'] = 'info', ms = 4500): void {
    const t: Toast = { id: ++this.seq, kind, text };
    this.toasts.update((l) => [...l, t]);
    setTimeout(() => this.dismiss(t.id), ms);
  }
  ok(text: string): void {
    this.show(text, 'ok');
  }
  error(text: string): void {
    this.show(text, 'danger', 7000);
  }
  warn(text: string): void {
    this.show(text, 'warn', 6000);
  }
  dismiss(id: number): void {
    this.toasts.update((l) => l.filter((t) => t.id !== id));
  }
}
