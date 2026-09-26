import { describe, expect, it } from 'vitest';
import { User } from './models';
import { homePath, isStaff, tatamiScopes } from './roles';

const base: User = { id: 1, username: 'ana', display_name: 'Ana', is_admin: false, person_id: 5 };
const op = (roles: User['roles']): User => ({ ...base, roles });

describe('roles', () => {
  it('reconoce al staff (admin u organizador)', () => {
    expect(isStaff({ ...base, is_admin: true })).toBe(true);
    expect(isStaff(op([{ id: 1, role: 'organizer', scope_type: 'tournament', scope_id: 3 }]))).toBe(true);
    expect(isStaff(op([{ id: 1, role: 'table_operator', scope_type: 'global', scope_id: null }]))).toBe(false);
    expect(isStaff(null)).toBe(false);
  });

  it('lleva al operador de un tatami a «Mi tatami» y a los demás a Torneos', () => {
    const tatamiOp = op([{ id: 1, role: 'table_operator', scope_type: 'tatami', scope_id: 7 }]);
    expect(tatamiScopes(tatamiOp)).toEqual([7]);
    expect(homePath(tatamiOp)).toBe('/mi-tatami');
    expect(homePath(op([{ id: 1, role: 'table_operator', scope_type: 'tournament', scope_id: 2 }]))).toBe('/torneos');
    expect(
      homePath(
        op([
          { id: 1, role: 'table_operator', scope_type: 'tatami', scope_id: 7 },
          { id: 2, role: 'organizer', scope_type: 'global', scope_id: null },
        ]),
      ),
    ).toBe('/torneos');
    expect(homePath(null)).toBe('/torneos');
  });
});
