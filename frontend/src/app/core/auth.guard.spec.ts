import { describe, expect, it } from 'vitest';
import { passwordChangeRedirect } from './auth.guard';
import { User } from './models';

const user = (must: boolean): User => ({
  id: 1,
  username: 'ana',
  display_name: 'Ana',
  is_admin: false,
  person_id: null,
  must_change_password: must,
});

describe('passwordChangeRedirect', () => {
  it('obliga a cambiar la contraseña asignada por el Admin antes de cualquier ruta', () => {
    expect(passwordChangeRedirect(user(true), '/torneos')).toBe('/cambiar-clave');
    expect(passwordChangeRedirect(user(true), '/mesa/12')).toBe('/cambiar-clave');
  });

  it('no redirige en la propia pantalla ni si no hace falta', () => {
    expect(passwordChangeRedirect(user(true), '/cambiar-clave?returnUrl=%2Fmesa%2F1')).toBeNull();
    expect(passwordChangeRedirect(user(false), '/torneos')).toBeNull();
    expect(passwordChangeRedirect(null, '/torneos')).toBeNull();
  });
});
