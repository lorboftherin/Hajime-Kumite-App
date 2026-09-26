import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { jwtExpiresAt } from './jwt';
import { TokenOut, User } from './models';

const TOKEN_KEY = 'hajime.token';
const USER_KEY = 'hajime.user';
/** Aviso no bloqueante cuando faltan menos de 10 minutos para que venza la sesión. */
export const EXPIRY_WARNING_MS = 10 * 60 * 1000;
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

  readonly token = signal<string | null>(read<string>(TOKEN_KEY));
  readonly user = signal<User | null>(read<User>(USER_KEY));
  readonly isLoggedIn = computed(() => !!this.token());
  readonly isAdmin = computed(() => !!this.user()?.is_admin);
  /** La contraseña la asignó el Admin: hay que cambiarla antes de seguir. */
  readonly mustChangePassword = computed(() => !!this.user()?.must_change_password);
  /** Solo Admin y organizadores ven documentos y fecha de nacimiento (el servidor los omite si no). */
  readonly canViewDocuments = computed(() => !!this.user()?.is_admin || !!this.user()?.can_view_documents);

  /** Vencimiento del JWT (ms UNIX) o null si no se puede leer. */
  readonly expiresAt = computed(() => jwtExpiresAt(this.token()));
  private readonly now = signal(Date.now());
  /** Faltan menos de 10 min para que venza la sesión (y aún no venció). */
  readonly expiringSoon = computed(() => {
    const exp = this.expiresAt();
    return exp !== null && exp > this.now() && exp - this.now() < EXPIRY_WARNING_MS;
  });
  readonly minutesLeft = computed(() => {
    const exp = this.expiresAt();
    return exp === null ? null : Math.max(0, Math.ceil((exp - this.now()) / 60000));
  });
  /** Diálogo de reingreso en el mismo lugar (no se pierde la página ni su estado). */
  readonly reloginOpen = signal(false);

  constructor() {
    if (typeof setInterval === 'function') setInterval(() => this.now.set(Date.now()), 30000);
  }

  async login(username: string, password: string): Promise<User> {
    const res = await firstValueFrom(this.api.post<TokenOut>('/auth/login', { username, password }));
    this.setSession(res);
    return res.user;
  }

  /**
   * Cambia la contraseña propia. El servidor invalida los tokens anteriores
   * y devuelve uno nuevo, que reemplaza al guardado.
   */
  async changePassword(currentPassword: string, newPassword: string): Promise<User> {
    const res = await firstValueFrom(
      this.api.post<TokenOut>('/auth/change-password', { current_password: currentPassword, new_password: newPassword }),
    );
    this.setSession(res);
    return res.user;
  }

  private setSession(res: TokenOut): void {
    write(TOKEN_KEY, res.access_token);
    write(USER_KEY, res.user);
    this.token.set(res.access_token);
    this.user.set(res.user);
    this.now.set(Date.now());
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
          queryParams: current && current !== '/' && !current.startsWith('/login') ? { returnUrl: current } : {},
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
    this.logout(false);
  }

  logout(redirect = true): void {
    remove(TOKEN_KEY);
    remove(USER_KEY);
    this.token.set(null);
    this.user.set(null);
    if (redirect) {
      // Al arrancar (401 en /auth/me) el router aún no navegó: se usa la URL real del navegador
      // para que una tablet con /mesa/123 en favoritos vuelva allí tras ingresar.
      const current = this.router.navigated ? this.router.url : this.currentLocation();
      const returnUrl = !current || current === '/' || current.startsWith('/login') ? undefined : current;
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
