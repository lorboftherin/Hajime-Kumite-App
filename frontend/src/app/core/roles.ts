// Lectura de roles del usuario (GET /auth/me los devuelve). Solo presentación: el servidor valida.
import { User } from './models';

/** Admin u organizador (de cualquier ámbito): administra personas, dojos y plantillas. */
export function isStaff(user: User | null | undefined): boolean {
  return !!user?.is_admin || (user?.roles ?? []).some((r) => r.role === 'organizer');
}

/** Tatamis donde el usuario es operador de mesa con ámbito «tatami». */
export function tatamiScopes(user: User | null | undefined): number[] {
  return (user?.roles ?? [])
    .filter((r) => r.role === 'table_operator' && r.scope_type === 'tatami' && r.scope_id !== null)
    .map((r) => r.scope_id as number);
}

/** Cuenta de competidor (o de padre, madre o apoderado): sin roles de gestión. */
export function isCompetitorOnly(user: User | null | undefined): boolean {
  return !!user && !user.is_admin && !(user.roles ?? []).length;
}

/** Revisa solicitudes de perfil: Admin, organizadores y el dojo (sensei o administrador del dojo). */
export function canReviewClaims(user: User | null | undefined): boolean {
  return (
    isStaff(user) ||
    (user?.roles ?? []).some((r) => (r.role === 'sensei' || r.role === 'dojo_admin') && r.scope_type === 'dojo')
  );
}

/**
 * Pantalla de inicio: el operador de mesa de un tatami (que no es staff) entra directo a
 * «Mi tatami»; una cuenta de competidor, a «Mis perfiles»; los demás, a la lista de torneos.
 */
export function homePath(user: User | null | undefined): string {
  if (isCompetitorOnly(user)) return '/mis-perfiles';
  return !isStaff(user) && tatamiScopes(user).length ? '/mi-tatami' : '/torneos';
}
