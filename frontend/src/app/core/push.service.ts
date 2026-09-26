import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { SwPush } from '@angular/service-worker';
import { firstValueFrom } from 'rxjs';
import { ApiError } from './api-error';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { DialogService } from './dialog.service';
import {
  EMPTY_PUSH_STATE,
  PUSH_MESSAGES,
  PushPreferences,
  PushRef,
  PushState,
  PushSupport,
  detectEnv,
  pushRef,
  pushSupport,
  safeUrl,
} from './push-logic';
import { isMobileApp } from './server';

interface PushConfig {
  enabled: boolean;
  public_key: string | null;
  soon_ahead: number;
}

/**
 * Avisos Web Push con el service worker de Angular (`SwPush`): suscribir este
 * dispositivo (con o sin cuenta), elegir a quién seguir y qué avisos recibir, y
 * abrir la página correcta al tocar un aviso. Ver docs/avisos-push.md.
 *
 * El servidor identifica la suscripción por su endpoint y su secreto `auth`
 * (solo los conoce este navegador): el espectador sin cuenta también la
 * administra. Con sesión, la suscripción queda además ligada a la cuenta.
 */
@Injectable({ providedIn: 'root' })
export class PushService {
  private sw = inject(SwPush);
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private router = inject(Router);
  private dialog = inject(DialogService);

  private config: PushConfig | null = null;
  private registeredAs: string | null = null;
  private started = false;
  /** Cambia al pedir permiso: vuelve a calcular `support`. */
  private readonly permissionTick = signal(0);
  readonly serverEnabled = signal<boolean | null>(null);
  readonly subscription = signal<PushSubscription | null>(null);
  readonly support = computed<PushSupport>(() => {
    this.permissionTick();
    return pushSupport(detectEnv(this.sw.isEnabled, isMobileApp), this.serverEnabled());
  });
  readonly message = computed(() => PUSH_MESSAGES[this.support()]);
  /** El botón «Avisarme» se oculta en la app de Android (su WebView no tiene Web Push). */
  readonly hidden = computed(() => this.support() === 'app');

  /** Lo llama la app al arrancar: suscripción actual y clics en los avisos. */
  start(): void {
    if (this.started || !this.sw.isEnabled) return;
    this.started = true;
    this.sw.subscription.subscribe((s) => this.subscription.set(s));
    // El service worker ya abre la URL (onActionClick); con la app abierta, además se navega aquí.
    this.sw.notificationClicks.subscribe(({ notification }) => {
      const data = notification.data as { url?: unknown } | undefined;
      const url = safeUrl(data?.url);
      if (url) void this.router.navigateByUrl(url);
    });
  }

  async loadConfig(): Promise<PushConfig | null> {
    if (this.config) return this.config;
    try {
      this.config = await firstValueFrom(this.api.get<PushConfig>('/push/config'));
      this.serverEnabled.set(this.config.enabled);
    } catch {
      this.config = null;
    }
    return this.config;
  }

  /** Suscripción actual de este navegador (sin pedir permiso). */
  ref(): PushRef | null {
    const s = this.subscription();
    return s ? pushRef(s.toJSON()) : null;
  }

  /** Explica por qué este dispositivo no puede recibir avisos. */
  async explain(): Promise<void> {
    const msg = this.message() || $localize`:@@avisos.no-pudo-activar-avisos-este:No se pudo activar los avisos en este dispositivo.`;
    await this.dialog.alert($localize`:@@avisos.avisos-este-dispositivo:Avisos en este dispositivo`, msg);
  }

  /**
   * Pide permiso (si hace falta), suscribe el navegador y lo registra en el servidor.
   * Devuelve la referencia de la suscripción o `null` si no se pudo (ya explicado).
   */
  async ensure(): Promise<PushRef | null> {
    const cfg = await this.loadConfig();
    if (this.support() !== 'ok' || !cfg?.public_key) {
      await this.explain();
      return null;
    }
    let sub = this.subscription();
    if (!sub) {
      try {
        sub = await this.sw.requestSubscription({ serverPublicKey: cfg.public_key });
        this.subscription.set(sub);
      } catch {
        this.permissionTick.update((n) => n + 1);
        await this.explain();
        return null;
      }
    }
    const json = sub.toJSON();
    const ref = pushRef(json);
    if (!ref) return null;
    // Se registra una vez por sesión y cuenta (con sesión, queda ligada a la cuenta).
    const who = `${ref.endpoint}|${this.auth.user()?.id ?? ''}`;
    if (this.registeredAs !== who) {
      await firstValueFrom(
        this.api.post<PushState>('/push/subscriptions', {
          endpoint: json.endpoint,
          keys: json.keys,
          user_agent: navigator.userAgent.slice(0, 255),
        }),
      );
      this.registeredAs = who;
    }
    return ref;
  }

  /** Estado en el servidor (preferencias, a quién sigue); con `tournament`, sus claves allí. */
  async state(tournament?: string): Promise<PushState> {
    const ref = this.ref();
    if (!ref) return EMPTY_PUSH_STATE;
    try {
      return await firstValueFrom(
        this.api.post<PushState>('/push/subscriptions/state', { ...ref, tournament }),
      );
    } catch {
      return EMPTY_PUSH_STATE;
    }
  }

  /** Competidores que sigue este dispositivo en un torneo público (reemplaza la lista). */
  async followPublic(tournament: string, keys: string[]): Promise<PushState | null> {
    const ref = await this.ensure();
    if (!ref) return null;
    return firstValueFrom(this.api.put<PushState>('/push/follows', { ...ref, tournament, keys }));
  }

  /** Seguir (o dejar de seguir) un perfil o un dojo desde la cuenta, en este dispositivo. */
  async followAccount(
    target: { person_id?: number; dojo_id?: number },
    follow: boolean,
  ): Promise<PushState | null> {
    const ref = await this.ensure();
    if (!ref) return null;
    return firstValueFrom(
      this.api.put<PushState>('/me/push/follows', { ...ref, ...target, follow }),
    );
  }

  async setPreferences(preferences: PushPreferences): Promise<PushState | null> {
    const ref = await this.ensure();
    if (!ref) return null;
    return firstValueFrom(
      this.api.put<PushState>('/push/subscriptions/preferences', { ...ref, preferences }),
    );
  }

  /** Deja de recibir avisos en este dispositivo (borra la suscripción y lo que seguía). */
  async unsubscribe(): Promise<void> {
    const ref = this.ref();
    if (ref) {
      try {
        await firstValueFrom(this.api.post<void>('/push/subscriptions/unsubscribe', ref));
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 404) throw e;
      }
    }
    this.registeredAs = null;
    try {
      await this.sw.unsubscribe();
    } catch {
      /* ya no estaba suscrito */
    }
    this.subscription.set(null);
  }
}
