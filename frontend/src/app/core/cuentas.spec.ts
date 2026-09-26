import { describe, expect, it } from 'vitest';
import { personLink } from '../shared/person-link';
import { tokenFromUrl } from './cuentas';
import { User } from './models';
import { canReviewClaims, homePath, isCompetitorOnly } from './roles';

const base: User = {
  id: 1,
  username: 'ana',
  display_name: 'Ana',
  is_admin: false,
  person_id: null,
  roles: [],
};

describe('cuentas de competidor', () => {
  it('lleva a una cuenta sin roles a «Mis perfiles»', () => {
    expect(isCompetitorOnly(base)).toBe(true);
    expect(homePath(base)).toBe('/mis-perfiles');
    expect(isCompetitorOnly({ ...base, is_admin: true })).toBe(false);
    expect(
      homePath({
        ...base,
        roles: [{ id: 1, role: 'organizer', scope_type: 'global', scope_id: null }],
      }),
    ).toBe('/torneos');
  });

  it('deja revisar solicitudes al staff y al dojo', () => {
    expect(canReviewClaims(base)).toBe(false);
    expect(
      canReviewClaims({
        ...base,
        roles: [{ id: 1, role: 'sensei', scope_type: 'dojo', scope_id: 4 }],
      }),
    ).toBe(true);
    expect(
      canReviewClaims({
        ...base,
        roles: [{ id: 1, role: 'dojo_admin', scope_type: 'dojo', scope_id: 4 }],
      }),
    ).toBe(true);
    expect(
      canReviewClaims({
        ...base,
        roles: [{ id: 1, role: 'referee', scope_type: 'global', scope_id: null }],
      }),
    ).toBe(false);
  });

  it('lee el token del enlace del correo', () => {
    const tok = 'a'.repeat(43);
    expect(tokenFromUrl(tok, null)).toBe(tok);
    expect(tokenFromUrl(`token=${tok}`, null)).toBe(tok);
    expect(tokenFromUrl(null, tok)).toBe(tok);
    expect(tokenFromUrl('corto', null)).toBe('');
    expect(tokenFromUrl('<script>', null)).toBe('');
  });

  it('arma el enlace al perfil público solo si hay identificador', () => {
    expect(personLink('Ab3_x-9')).toEqual(['/competidor', 'Ab3_x-9']);
    expect(personLink(null)).toBeNull();
    expect(personLink(undefined)).toBeNull();
  });
});
