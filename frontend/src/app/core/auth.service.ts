import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiError } from './api-error';
import { ApiService } from './api.service';
import { jwtExpiresAt } from './jwt';
import { TokenOut, User } from './models';
import { SessionExpiredService } from './session-expired.service';

const TOKEN_KEY = 'hajime.token';
const REFRESH_KEY = 'hajime.refresh';
const USER_KEY = 'hajime.user';
/**
 * Aviso no bloqueante cuando faltan menos de 10 minutos para que venza la sesión.
 * Con token de renovación la sesión se renueva sola: el aviso solo aparece si
 * no hay token de renovación (sesión antigua) o si la renovación no pudo hacerse.
 */
export const EXPIRY_WARNING_MS = 10 * 60 * 1000;
/** Se renueva el token de acceso cuando le quedan menos de 2 minutos. */
export const REFRESH_AHEAD_MS = 2 * 60 * 1000;
/** Resultado de una renovación: hecha, rechazada por el servidor o sin conexión. */
export type RefreshResult = 'ok' | 'invalid' | 'network';
/** Pantalla de cambio de contraseña (obligatoria si must_change_password). */
export const CHANGE_PASSWORD_PATH = '/cambiar-clave';

function read<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* sin almacenamiento */
  }
}

function remove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* sin almacenamiento */
  }
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private api = inject(ApiService);
  private router = inject(Router);
  private sessionExpired = inject(SessionExpiredService);

  readonly token = signal<string | null>(read<string>(TOKEN_KEY));
  /** Token de renovación (mismo almacenamiento que el de acceso). */
  readonly refreshToken = signal<string | null>(read<string>(REFRESH_KEY));
  /** La última renovación silenciosa no se pudo hacer (p. ej. sin conexión). */
  readonly refreshFailed = signal(false);
  readonly user = signal<User | null>(read<User>(USER_KEY));
  readonly isLoggedIn = computed(() => !!this.token());
  readonly isAdmin = computed(() => !!this.user()?.is_admin);
  /** La contraseña la asignó el Admin: hay que cambiarla antes de seguir. */
  readonly mustChangePassword = computed(() => !!this.user()?.must_change_password);
  /** Solo Admin y organizadores ven documentos y fecha de nacimiento (el servidor los omite si no). */
  readonly canViewDocuments = computed(
    () => !!this.user()?.is_admin || !!this.user()?.can_view_documents,
  );

  /** Vencimiento del JWT (ms UNIX) o null si no se puede leer. */
  readonly expiresAt = computed(() => jwtExpiresAt(this.token()));
  private readonly now = signal(Date.now());
  /**
   * Faltan menos de 10 min para que venza la sesión (y aún no venció) y no se
   * renovará sola: sin token de renovación o tras un intento fallido.
   */
  readonly expiringSoon = computed(() => {
    const exp = this.expiresAt();
    const willRenew = !!this.refreshToken() && !this.refreshFailed();
    return !willRenew && exp !== null && exp > this.now() && exp - this.now() < EXPIRY_WARNING_MS;
  });
  readonly minutesLeft = computed(() => {
    const exp = this.expiresAt();
    return exp === null ? null : Math.max(0, Math.ceil((exp - this.now()) / 60000));
  });
  /** Diálogo de reingreso en el mismo lugar (no se pierde la página ni su estado). */
  readonly reloginOpen = signal(false);

  /** Renovación en curso: todas las peticiones que fallan a la vez esperan la misma. */
  private refreshing: Promise<RefreshResult> | null = null;

  constructor() {
    if (typeof setInterval === 'function') {
      setInterval(() => {
        this.now.set(Date.now());
        this.refreshIfExpiring();
      }, 30000);
    }
    // Otra pestaña renovó o cerró la sesión: se adoptan sus tokens.
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('storage', (e) => {
        if (e.key === TOKEN_KEY || e.key === REFRESH_KEY || e.key === USER_KEY) this.adoptStored();
      });
    }
  }

  async login(username: string, password: string): Promise<User> {
    const res = await firstValueFrom(
      this.api.post<TokenOut>('/auth/login', { username, password }),
    );
    this.setSession(res);
    return res.user;
  }

  /**
   * Cambia la contraseña propia. El servidor invalida los tokens anteriores
   * y devuelve uno nuevo, que reemplaza al guardado.
   */
  async changePassword(currentPassword: string, newPassword: string): Promise<User> {
    const res = await firstValueFrom(
      this.api.post<TokenOut>('/auth/change-password', {
        current_password: currentPassword,
        new_password: newPassword,
      }),
    );
    this.setSession(res);
    return res.user;
  }

  private setSession(res: TokenOut): void {
    write(TOKEN_KEY, res.access_token);
    write(USER_KEY, res.user);
    if (res.refresh_token) write(REFRESH_KEY, res.refresh_token);
    else remove(REFRESH_KEY);
    this.token.set(res.access_token);
    this.refreshToken.set(res.refresh_token ?? null);
    this.user.set(res.user);
    this.refreshFailed.set(false);
    this.now.set(Date.now());
  }

  /** Toma los tokens guardados (por otra pestaña o por una renovación ya hecha). */
  private adoptStored(): void {
    this.token.set(read<string>(TOKEN_KEY));
    this.refreshToken.set(read<string>(REFRESH_KEY));
    const u = read<User>(USER_KEY);
    if (u || !this.token()) this.user.set(u);
    this.refreshFailed.set(false);
    this.now.set(Date.now());
  }

  /**
   * Renueva el token de acceso con el de renovación, de forma silenciosa y
   * única: si varias peticiones fallan a la vez, todas esperan la misma
   * renovación (una sola llamada a /auth/refresh).
   */
  refresh(): Promise<RefreshResult> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => (this.refreshing = null));
    }
    return this.refreshing;
  }

  /** Renueva si el token de acceso vence pronto (lo llama el temporizador). */
  refreshIfExpiring(): void {
    const exp = this.expiresAt();
    if (!this.refreshToken() || exp === null || this.refreshing) return;
    if (exp - Date.now() < REFRESH_AHEAD_MS) {
      void this.refresh().then((r) => {
        // Con la mesa abierta, ella muestra su panel de reingreso en vez de ir al login.
        if (r === 'invalid') this.logout(!this.sessionExpired.notifyExpired(), false);
      });
    }
  }

  private async doRefresh(): Promise<RefreshResult> {
    // Se lee del almacenamiento: otra pestaña pudo haberlo rotado ya.
    const used = read<string>(REFRESH_KEY) ?? this.refreshToken();
    if (!used) return 'invalid';
    try {
      const res = await firstValueFrom(
        this.api.post<TokenOut>('/auth/refresh', { refresh_token: used }),
      );
      this.setSession(res);
      return 'ok';
    } catch (e) {
      const err = ApiError.from(e);
      if (err.code === 'REFRESH_RACE') await delay(1500); // otra pestaña está guardando el suyo
      const stored = read<string>(REFRESH_KEY);
      if (stored && stored !== used) {
        this.adoptStored();
        return 'ok';
      }
      if (err.isNetwork || err.status < 400) {
        this.refreshFailed.set(true);
        return 'network';
      }
      return 'invalid';
    }
  }

  /** Refresca los datos del usuario (p. ej. al iniciar la app). */
  async refreshMe(): Promise<void> {
    if (!this.token()) return;
    try {
      const u = await firstValueFrom(this.api.get<User>('/auth/me'));
      this.user.set(u);
      write(USER_KEY, u);
      if (u.must_change_password && !this.currentPath().startsWith(CHANGE_PASSWORD_PATH)) {
        const current = this.currentPath();
        this.router.navigate([CHANGE_PASSWORD_PATH], {
          queryParams:
            current && current !== '/' && !current.startsWith('/login')
              ? { returnUrl: current }
              : {},
        });
      }
    } catch {
      /* el interceptor maneja 401 */
    }
  }

  requestRelogin(): void {
    this.reloginOpen.set(true);
  }

  /** Borra la propia cuenta (confirmando con la contraseña) y cierra la sesión. */
  async deleteAccount(password: string): Promise<void> {
    await firstValueFrom(this.api.post<void>('/auth/delete-account', { password }));
    this.logout(false, false);
  }

  /**
   * Cierra la sesión local y, si `notifyServer`, la revoca en el servidor
   * (sin esperar respuesta: sin conexión igual se sale).
   */
  logout(redirect = true, notifyServer = true): void {
    const refreshToken = this.refreshToken();
    if (notifyServer && (this.token() || refreshToken)) {
      this.api
        .post<void>('/auth/logout', { refresh_token: refreshToken })
        .subscribe({ error: () => {} });
    }
    remove(TOKEN_KEY);
    remove(REFRESH_KEY);
    remove(USER_KEY);
    this.token.set(null);
    this.refreshToken.set(null);
    this.refreshFailed.set(false);
    this.user.set(null);
    if (redirect) {
      // Al arrancar (401 en /auth/me) el router aún no navegó: se usa la URL real del navegador
      // para que una tablet con /mesa/123 en favoritos vuelva allí tras ingresar.
      const current = this.router.navigated ? this.router.url : this.currentLocation();
      const returnUrl =
        !current || current === '/' || current.startsWith('/login') ? undefined : current;
      this.router.navigate(['/login'], { queryParams: returnUrl ? { returnUrl } : {} });
    }
  }

  private currentPath(): string {
    return this.router.navigated ? this.router.url : this.currentLocation();
  }

  private currentLocation(): string {
    try {
      return location.pathname + location.search + location.hash;
    } catch {
      return '';
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
