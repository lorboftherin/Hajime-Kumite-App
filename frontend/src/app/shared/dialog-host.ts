import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { DialogRequest, DialogService } from '../core/dialog.service';
import { ToastService } from '../core/toast.service';
import { FocusTrap } from './focus-trap';

/** Dibuja los diálogos de DialogService y los toasts. Va una sola vez en App. */
@Component({
  selector: 'app-dialog-host',
  imports: [FormsModule, FocusTrap, RouterLink],
  host: { '(document:keydown.escape)': 'onEscape()' },
  template: `
    @if (top(); as d) {
      <div class="modal-backdrop">
        <div class="modal" role="dialog" aria-modal="true" [attr.aria-label]="d.title" appFocusTrap>
          <h2>{{ d.title }}</h2>
          @switch (d.kind) {
            @case ('confirm') {
              <p>{{ d.message }}</p>
              <div class="form-actions">
                <button i18n="@@dialogo.cancelar" class="btn" (click)="d.resolve(false)"
                  >Cancelar</button
                >
                <button
                  class="btn"
                  [class.danger]="d.danger"
                  [class.primary]="!d.danger"
                  (click)="d.resolve(true)"
                  autofocus
                >
                  {{ d.confirmText || txtConfirmar }}
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
                <button
                  i18n="@@dialogo.entendido"
                  class="btn primary"
                  (click)="d.resolve(true)"
                  autofocus
                  >Entendido</button
                >
              </div>
            }
            @case ('choice') {
              <p>{{ d.message }}</p>
              @if (d.items?.length) {
                <ul>
                  @for (it of d.items; track $index) {
                    <li>{{ it }}</li>
                  }
                </ul>
              }
              <div class="choices">
                @for (c of d.choices; track c.value; let first = $first) {
                  <button
                    type="button"
                    class="btn choice"
                    [class.primary]="c.primary"
                    [class.danger]="c.danger"
                    (click)="d.resolve(c.value)"
                    [attr.autofocus]="first ? '' : null"
                  >
                    <span class="choice-label">{{ c.label }}</span>
                    @if (c.hint) {
                      <span class="choice-hint">{{ c.hint }}</span>
                    }
                  </button>
                }
              </div>
              <div class="form-actions">
                <button class="btn" (click)="d.resolve(null)">{{
                  d.cancelText || txtDecidirDespues
                }}</button>
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
                  <div i18n="@@dialogo.minimo-caracteres" class="hint"
                    >Mínimo {{ d.minLength }} caracteres.</div
                  >
                }
                <div class="form-actions">
                  <button
                    i18n="@@dialogo.cancelar"
                    type="button"
                    class="btn"
                    (click)="d.resolve(null)"
                    >Cancelar</button
                  >
                  <button
                    type="submit"
                    class="btn primary"
                    [disabled]="text().trim().length < d.minLength"
                  >
                    {{ d.confirmText || txtAceptar }}
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
              <p i18n="@@dialogo.puedes-continuar-igualmente" class="small muted">
                Puedes continuar igualmente: la excepción quedará registrada con tu usuario y el
                motivo.
              </p>
              <form (ngSubmit)="submitText(d)">
                <label class="field">
                  <span i18n="@@dialogo.motivo-para-continuar">Motivo para continuar</span>
                  <textarea
                    i18n-placeholder="@@dialogo.ej-autorizado-organizador"
                    name="reason"
                    rows="2"
                    [(ngModel)]="text"
                    placeholder="Ej.: autorizado por el organizador"
                    autofocus
                  ></textarea>
                </label>
                @if (text().trim().length < 3) {
                  <div i18n="@@dialogo.minimo-3-caracteres" class="hint">Mínimo 3 caracteres.</div>
                }
                <div class="form-actions">
                  <button
                    i18n="@@dialogo.cancelar"
                    type="button"
                    class="btn"
                    (click)="d.resolve(null)"
                    >Cancelar</button
                  >
                  <button
                    i18n="@@dialogo.continuar-todos-modos"
                    type="submit"
                    class="btn danger"
                    [disabled]="text().trim().length < 3"
                    >Continuar de todos modos</button
                  >
                </div>
              </form>
            }
          }
        </div>
      </div>
    }
    <div class="toasts" aria-live="polite">
      @for (t of toast.toasts(); track t.id) {
        <div
          class="alert toast {{ t.kind }}"
          [attr.role]="t.kind === 'danger' ? 'alert' : 'status'"
          (click)="toast.dismiss(t.id)"
        >
          <span class="toast-text">{{ t.text }}</span>
          @if (t.link) {
            <a
              class="toast-link"
              [routerLink]="t.link.path"
              (click)="toast.dismiss(t.id); $event.stopPropagation()"
              >{{ t.link.label }}</a
            >
          }
          <button
            i18n-aria-label="@@dialogo.cerrar-aviso"
            type="button"
            class="toast-x"
            (click)="toast.dismiss(t.id); $event.stopPropagation()"
            aria-label="Cerrar aviso"
            >✕</button
          >
        </div>
      }
    </div>
  `,
  styles: `
    .toasts {
      position: fixed;
      right: 1.25rem;
      bottom: calc(1.25rem + var(--bottom-bar-h) + var(--safe-bottom));
      z-index: 2000;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      max-width: min(420px, calc(100vw - 2rem));
    }
    .toast {
      cursor: pointer;
      margin: 0;
      display: flex;
      align-items: flex-start;
      gap: 0.5rem;
      padding-right: 0.5rem;
    }
    .toast-text {
      flex: 1;
    }
    .toast-link {
      flex: none;
      align-self: center;
      font-weight: 700;
      color: inherit;
      text-decoration: underline;
      white-space: nowrap;
    }
    .toast-x {
      flex: none;
      display: inline-grid;
      place-items: center;
      min-width: 2rem;
      min-height: 2rem;
      margin: -0.35rem -0.1rem -0.35rem 0;
      border: 0;
      border-radius: var(--radius-sm);
      background: transparent;
      color: inherit;
      font: inherit;
      cursor: pointer;
      opacity: 0.75;
      &:hover {
        opacity: 1;
        background: var(--hover);
      }
      &:focus-visible {
        outline: 2px solid var(--ai);
      }
    }
    .modal > p {
      color: var(--sumi-2);
    }
    .choices {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .choice {
      flex-direction: column;
      align-items: flex-start;
      height: auto;
      min-height: 2.75rem;
      padding: 0.6rem 0.9rem;
      text-align: left;
      white-space: normal;
    }
    .choice-hint {
      font-size: var(--fs-12);
      font-weight: 400;
      opacity: 0.85;
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
  readonly txtConfirmar = $localize`:@@dialogo.confirmar:Confirmar`;
  readonly txtDecidirDespues = $localize`:@@dialogo.decidir-despues:Decidir después`;
  readonly txtAceptar = $localize`:@@dialogo.aceptar:Aceptar`;
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

  /** Escape cancela el diálogo de arriba, salvo en acciones críticas (se decide con los botones). */
  onEscape(): void {
    const d = this.top();
    if (d && !d.critical) this.cancel(d);
  }

  cancel(d: DialogRequest): void {
    if (d.kind === 'confirm' || d.kind === 'alert') d.resolve(false);
    else d.resolve(null);
  }
}
