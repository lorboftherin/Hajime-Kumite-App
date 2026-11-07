import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import {
  EMPTY_PUSH_STATE,
  PREFERENCE_LABELS,
  PushPreferences,
  PushState,
} from '../../core/push-logic';
import { PushService } from '../../core/push.service';
import { ToastService } from '../../core/toast.service';
import { Enso, HajimeWord } from '../../shared/enso';
import { Icon } from '../../shared/icon';

/**
 * Ajustes de avisos de este dispositivo: activarlos, qué avisos recibir y dejar de
 * recibirlos. Sirve con y sin cuenta (el espectador de la página pública también).
 */
@Component({
  selector: 'app-push-settings',
  imports: [FormsModule, RouterLink, Enso, HajimeWord, Icon],
  template: `
    <div class="page">
      <header class="top">
        <a
          i18n-aria-label="@@avisos.ajustes.hajime"
          class="brand"
          [routerLink]="auth.user() ? '/perfil' : '/torneos-publicos'"
          aria-label="Hajime"
          ><app-enso class="mark" /><app-hajime-word class="word"
        /></a>
      </header>
      <article class="card doc">
        <h1 i18n="@@avisos.ajustes.avisos"><app-icon name="bell" /> Avisos</h1>
        <p i18n="@@avisos.ajustes.hajime-te-avisa-este-dispositivo">
          Hajime te avisa en este dispositivo cuando le toca a quien sigues («te toca en ~3
          combates» y «¡A tatami!»), su resultado y sus medallas. Elige a quién seguir con
          «Avisarme» en la página del torneo, en «Mis perfiles» o en «Mis competidores».
        </p>

        @if (push.support() !== 'ok') {
          <div class="alert warn" role="note">{{ push.message() }}</div>
        } @else if (!state().subscribed) {
          <p i18n="@@avisos.ajustes.este-dispositivo-todavia-no"
            >Este dispositivo todavía no recibe avisos.</p
          >
          <button
            i18n="@@avisos.ajustes.activar-avisos-este-dispositivo"
            class="btn primary"
            type="button"
            (click)="activate()"
            [disabled]="busy()"
          >
            <app-icon name="bell" /> Activar avisos en este dispositivo
          </button>
        } @else {
          <h2 i18n="@@avisos.ajustes.avisos-recibir">Qué avisos recibir</h2>
          <form class="prefs" (ngSubmit)="save()">
            @for (p of labels; track p.key) {
              <label class="check">
                <input
                  type="checkbox"
                  [name]="p.key"
                  [ngModel]="prefs()[p.key]"
                  (ngModelChange)="setPref(p.key, $event)"
                />
                <span>
                  <strong>{{ p.label }}</strong>
                  <span class="muted small block">{{ p.hint }}</span>
                </span>
              </label>
            }
            <div class="form-actions">
              <button i18n="@@avisos.ajustes.guardar" class="btn primary" [disabled]="busy()"
                >Guardar</button
              >
            </div>
          </form>
          @if (following()) {
            <p
              i18n="@@avisos.ajustes.cuenta-sigues-este-dispositivo"
              class="small muted"
              >{following(), plural,
                =1 {Con tu cuenta sigues 1 perfil o dojo en este dispositivo.}
                other {Con tu cuenta sigues {{ following() }} perfiles o dojos en este dispositivo.}
              }</p
            >
          }
          <button
            i18n="@@avisos.ajustes.dejar-recibir-avisos-este"
            class="btn ghost danger"
            type="button"
            (click)="off()"
            [disabled]="busy()"
          >
            Dejar de recibir avisos en este dispositivo
          </button>
        }

        <h2 i18n="@@avisos.ajustes.iphone-ipad">iPhone y iPad</h2>
        <p i18n="@@avisos.ajustes.safari-solo-entrega-avisos">
          Safari solo entrega avisos a Hajime instalado: toca Compartir → «Agregar a pantalla de
          inicio», abre Hajime desde ese ícono y activa los avisos allí (iOS 16.4 o superior).
        </p>
        <h2 i18n="@@avisos.ajustes.app-android">App de Android</h2>
        <p i18n="@@avisos.ajustes.app-android-todavia-no-recibe">
          La app de Android todavía no recibe avisos. Para recibirlos, abre Hajime en Chrome e
          instálalo desde el navegador («Instalar app»).
        </p>
        <h2 i18n="@@avisos.ajustes.privacidad">Privacidad</h2>
        <p i18n="@@avisos.ajustes.guardamos-direccion-avisos-este" class="small">
          Guardamos la dirección de avisos de este navegador y a quién sigues. Los favoritos de la
          página pública se borran al terminar el torneo. Los avisos de menores usan el nombre
          abreviado, como la página pública.
        </p>
      </article>
    </div>
  `,
  styles: `
    :host {
      display: block;
      min-height: 100vh;
      background: var(--washi);
    }
    .page {
      max-width: 720px;
      margin: 0 auto;
      padding: 1.25rem 1rem 3rem;
    }
    .top .brand {
      display: inline-flex;
      align-items: center;
      gap: 0.6rem;
      color: var(--sumi);
      text-decoration: none;
      margin-bottom: 1.5rem;
      .mark {
        width: 2.2rem;
        height: 2.2rem;
      }
      .word {
        height: 1.5rem;
        margin-top: 0.4rem;
      }
    }
    .doc {
      h1 {
        font-family: var(--font-display);
        margin-top: 0;
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }
      h2 {
        font-size: var(--fs-20);
        margin: 1.5rem 0 0.5rem;
      }
      p {
        line-height: 1.6;
      }
    }
    .prefs {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }
    .check {
      display: flex;
      gap: 0.6rem;
      align-items: flex-start;
      input {
        margin-top: 0.3rem;
      }
    }
    .block {
      display: block;
    }
    .danger {
      color: var(--shu-ink);
      margin-top: 0.5rem;
    }
  `,
})
export class PushSettingsPage {
  readonly auth = inject(AuthService);
  readonly push = inject(PushService);
  private toast = inject(ToastService);
  readonly labels = PREFERENCE_LABELS;
  readonly state = signal<PushState>(EMPTY_PUSH_STATE);
  readonly prefs = signal<PushPreferences>({ ...EMPTY_PUSH_STATE.preferences });
  readonly busy = signal(false);
  readonly following = computed(
    () => this.state().person_ids.length + this.state().dojo_ids.length,
  );

  constructor() {
    void this.push.loadConfig();
    // La suscripción llega del service worker un instante después de abrir la página.
    effect(() => {
      this.push.subscription();
      untracked(() => void this.refresh());
    });
  }

  private async refresh(): Promise<void> {
    const s = await this.push.state();
    this.state.set(s);
    this.prefs.set({ ...s.preferences });
  }

  setPref(key: keyof PushPreferences, value: boolean): void {
    this.prefs.update((p) => ({ ...p, [key]: value }));
  }

  async activate(): Promise<void> {
    this.busy.set(true);
    try {
      if (await this.push.ensure()) {
        await this.refresh();
        this.toast.ok(
          $localize`:@@avisos.ajustes.avisos-activados-este:Avisos activados en este dispositivo`,
        );
      }
    } catch {
      this.toast.error(
        $localize`:@@avisos.ajustes.no-pudieron-activar-avisos:No se pudieron activar los avisos`,
      );
    } finally {
      this.busy.set(false);
    }
  }

  async save(): Promise<void> {
    this.busy.set(true);
    try {
      const s = await this.push.setPreferences(this.prefs());
      if (s) {
        this.state.set(s);
        this.toast.ok($localize`:@@avisos.ajustes.preferencias-guardadas:Preferencias guardadas`);
      }
    } catch {
      this.toast.error($localize`:@@avisos.ajustes.no-pudieron-guardar:No se pudieron guardar`);
    } finally {
      this.busy.set(false);
    }
  }

  async off(): Promise<void> {
    this.busy.set(true);
    try {
      await this.push.unsubscribe();
      this.state.set(EMPTY_PUSH_STATE);
      this.toast.ok(
        $localize`:@@avisos.ajustes.ya-no-recibiras-avisos-este:Ya no recibirás avisos en este dispositivo`,
      );
    } catch {
      this.toast.error($localize`:@@avisos.ajustes.no-pudo-desactivar:No se pudo desactivar`);
    } finally {
      this.busy.set(false);
    }
  }
}
