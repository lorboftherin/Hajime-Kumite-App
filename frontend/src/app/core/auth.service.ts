import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { TokenOut, User } from './models';

const TOKEN_KEY = 'hajime.token';
const USER_KEY = 'hajime.user';

function read<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
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

  async login(username: string, password: string): Promise<User> {
    const res = await firstValueFrom(this.api.post<TokenOut>('/auth/login', { username, password }));
    localStorage.setItem(TOKEN_KEY, JSON.stringify(res.access_token));
    localStorage.setItem(USER_KEY, JSON.stringify(res.user));
    this.token.set(res.access_token);
    this.user.set(res.user);
    return res.user;
  }

  /** Refresca los datos del usuario (p. ej. al iniciar la app). */
  async refreshMe(): Promise<void> {
    if (!this.token()) return;
    try {
      const u = await firstValueFrom(this.api.get<User>('/auth/me'));
      this.user.set(u);
      localStorage.setItem(USER_KEY, JSON.stringify(u));
    } catch {
      /* el interceptor maneja 401 */
    }
  }

  logout(redirect = true): void {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    this.token.set(null);
    this.user.set(null);
    if (redirect) {
      const returnUrl = this.router.url.startsWith('/login') ? undefined : this.router.url;
      this.router.navigate(['/login'], { queryParams: returnUrl ? { returnUrl } : {} });
    }
  }
}
