// Lectura de roles del usuario (GET /auth/me los devuelve). Solo presentación: el servidor valida.
import { User } from './models';

/**
 * Admin, organizador (de cualquier ámbito) u owner/admin de una organización:
 * administra personas, dojos y plantillas.
 */
export function isStaff(user: User | null | undefined): boolean {
  return (
    !!user?.is_admin ||
    (user?.roles ?? []).some((r) => r.role === 'organizer') ||
    (user?.organizations ?? []).some((o) => o.role === 'owner' || o.role === 'admin')
  );
}

/** Tatamis donde el usuario es operador de mesa con ámbito «tatami». */
export function tatamiScopes(user: User | null | undefined): number[] {
  return (user?.roles ?? [])
    .filter((r) => r.role === 'table_operator' && r.scope_type === 'tatami' && r.scope_id !== null)
    .map((r) => r.scope_id as number);
}

/** Dojos que el usuario administra (rol dojo_admin): «Mis competidores». */
export function dojoAdminOf(user: User | null | undefined): number[] {
  if (user?.dojo_admin_of) return user.dojo_admin_of;
  return (user?.roles ?? [])
    .filter((r) => r.role === 'dojo_admin' && r.scope_type === 'dojo' && r.scope_id !== null)
    .map((r) => r.scope_id as number);
}

/** Tiene al menos una organización (o es Admin): ve la página «Organización». */
export function hasOrganizations(user: User | null | undefined): boolean {
  return !!user?.is_admin || (user?.organizations ?? []).length > 0;
}

/**
 * Pantalla de inicio: el operador de mesa de un tatami (que no es staff) entra directo a
 * «Mi tatami»; el sensei que solo administra su dojo, a «Mis competidores»; los demás, a
 * la lista de torneos.
 */
export function homePath(user: User | null | undefined): string {
  if (isStaff(user)) return '/torneos';
  if (tatamiScopes(user).length) return '/mi-tatami';
  if (dojoAdminOf(user).length) return '/mis-competidores';
  return '/torneos';
}
