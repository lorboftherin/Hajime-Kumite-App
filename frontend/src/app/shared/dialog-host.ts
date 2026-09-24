import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DialogRequest, DialogService } from '../core/dialog.service';
import { ToastService } from '../core/toast.service';

/** Dibuja los diálogos de DialogService y los toasts. Va una sola vez en App. */
@Component({
  selector: 'app-dialog-host',
  imports: [FormsModule],
  template: `
    @if (top(); as d) {
      <div class="modal-backdrop" (keydown.escape)="cancel(d)">
        <div class="modal" role="dialog" aria-modal="true" [attr.aria-label]="d.title">
          <h2>{{ d.title }}</h2>
          @switch (d.kind) {
            @case ('confirm') {
              <p>{{ d.message }}</p>
              <div class="form-actions">
                <button class="btn" (click)="d.resolve(false)">Cancelar</button>
                <button class="btn" [class.danger]="d.danger" [class.primary]="!d.danger" (click)="d.resolve(true)" autofocus>
                  {{ d.confirmText || 'Confirmar' }}
                </button>
              </div>
            }
            @case ('alert') {
              <p>{{ d.message }}</p>
              @if (d.items?.length) {
                <ul>
                  @for (it of d.items; track $index) {
                    <li>{{ it }}</li>
                  }
                </ul>
              }
              <div class="form-actions">
                <button class="btn primary" (click)="d.resolve(true)" autofocus>Entendido</button>
              </div>
            }
            @case ('prompt') {
              @if (d.message) {
                <p>{{ d.message }}</p>
              }
              <form (ngSubmit)="submitText(d)">
                <label class="field">
                  <span>{{ d.label }}</span>
                  <textarea name="text" rows="3" [(ngModel)]="text" autofocus></textarea>
                </label>
                @if (d.minLength && text().trim().length < d.minLength) {
                  <div class="hint">Mínimo {{ d.minLength }} caracteres.</div>
                }
                <div class="form-actions">
                  <button type="button" class="btn" (click)="d.resolve(null)">Cancelar</button>
                  <button type="submit" class="btn primary" [disabled]="text().trim().length < d.minLength">
                    {{ d.confirmText || 'Aceptar' }}
                  </button>
                </div>
              </form>
            }
            @case ('warnings') {
              <div class="alert warn">
                <strong>{{ d.message }}</strong>
                <ul>
                  @for (w of d.warnings; track $index) {
                    <li>{{ w.message }}</li>
                  }
                </ul>
              </div>
              <p class="small muted">
                Puedes continuar igualmente: la excepción quedará registrada con tu usuario y el motivo.
              </p>
              <form (ngSubmit)="submitText(d)">
                <label class="field">
                  <span>Motivo para continuar</span>
                  <textarea name="reason" rows="2" [(ngModel)]="text" placeholder="Ej.: autorizado por el organizador" autofocus></textarea>
                </label>
                @if (text().trim().length < 3) {
                  <div class="hint">Mínimo 3 caracteres.</div>
                }
                <div class="form-actions">
                  <button type="button" class="btn" (click)="d.resolve(null)">Cancelar</button>
                  <button type="submit" class="btn danger" [disabled]="text().trim().length < 3">Continuar de todos modos</button>
                </div>
              </form>
            }
          }
        </div>
      </div>
    }
    <div class="toasts" aria-live="polite">
      @for (t of toast.toasts(); track t.id) {
        <div class="alert toast {{ t.kind }}" (click)="toast.dismiss(t.id)">{{ t.text }}</div>
      }
    </div>
  `,
  styles: `
    .toasts {
      position: fixed;
      right: 1.25rem;
      bottom: calc(1.25rem + var(--bottom-bar-h));
      z-index: 2000;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      max-width: min(420px, calc(100vw - 2rem));
    }
    .toast {
      cursor: pointer;
      margin: 0;
      padding-right: 1.25rem;
    }
    .modal > p {
      color: var(--sumi-2);
    }
    @media (max-width: 767px) {
      .toasts {
        left: 0.75rem;
        right: 0.75rem;
        max-width: none;
      }
    }
  `,
})
export class DialogHost {
  private dialogs = inject(DialogService);
  readonly toast = inject(ToastService);
  readonly top = computed(() => {
    const s = this.dialogs.stack();
    return s.length ? s[s.length - 1] : null;
  });
  readonly text = signal('');

  constructor() {
    // Reinicia el texto cada vez que aparece un diálogo nuevo.
    effect(() => {
      const d = this.top();
      this.text.set(d && d.kind === 'prompt' ? (d.initial ?? '') : '');
    });
  }

  submitText(d: DialogRequest): void {
    const v = this.text().trim();
    if (d.kind === 'prompt') {
      if (v.length >= d.minLength) d.resolve(v);
    } else if (d.kind === 'warnings') {
      if (v.length >= 3) d.resolve(v);
    }
  }

  cancel(d: DialogRequest): void {
    if (d.kind === 'confirm' || d.kind === 'alert') d.resolve(false);
    else d.resolve(null);
  }
}
