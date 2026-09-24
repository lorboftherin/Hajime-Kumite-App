import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { CHANGE_PASSWORD_PATH, AuthService } from './auth.service';
import { User } from './models';

/**
 * Si la cuenta debe cambiar su contraseña (la asignó el Admin), toda ruta
 * protegida lleva primero a /cambiar-clave. Devuelve null si puede seguir.
 */
export function passwordChangeRedirect(user: User | null, url: string): string | null {
  if (!user?.must_change_password) return null;
  if (url.startsWith(CHANGE_PASSWORD_PATH)) return null;
  return CHANGE_PASSWORD_PATH;
}

export const authGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (!auth.isLoggedIn()) return router.createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
  const redirect = passwordChangeRedirect(auth.user(), state.url);
  if (redirect) {
    const keep = state.url && state.url !== '/' ? { returnUrl: state.url } : {};
    return router.createUrlTree([redirect], { queryParams: keep });
  }
  return true;
};

export const adminGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  return auth.isAdmin() ? true : inject(Router).createUrlTree(['/torneos']);
};
