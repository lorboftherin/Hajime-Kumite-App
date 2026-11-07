// Reglas de contraseña del lado del cliente (el servidor valida igual: mínimo 8).

export const MIN_PASSWORD = 8;

/** Valida el formulario de cambio de contraseña; devuelve el primer problema o ''. */
export function passwordFormError(current: string, next: string, confirm: string): string {
  if (!current) return $localize`:@@clave.ingresa-contrasena-actual:Ingresa tu contraseña actual`;
  if (next.length < MIN_PASSWORD)
    return $localize`:@@clave.nueva-contrasena-debe-tener:La nueva contraseña debe tener al menos ${MIN_PASSWORD}:MIN_PASSWORD: caracteres`;
  if (next === current)
    return $localize`:@@clave.nueva-contrasena-debe-ser:La nueva contraseña debe ser distinta de la actual`;
  if (next !== confirm)
    return $localize`:@@clave.contrasenas-nuevas-no-coinciden:Las contraseñas nuevas no coinciden`;
  return '';
}

/** Contraseña temporal legible (sin 0/O/1/l/I) para entregar en persona. */
export function randomPassword(length = 10): string {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = new Uint32Array(length);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => chars[n % chars.length]).join('');
}
