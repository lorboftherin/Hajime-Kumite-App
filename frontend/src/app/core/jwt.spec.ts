import { describe, expect, it } from 'vitest';
import { jwtExpiresAt } from './jwt';

function fakeJwt(payload: object): string {
  const b64 = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64('{"alg":"HS256"}')}.${b64(JSON.stringify(payload))}.firma`;
}

describe('jwtExpiresAt', () => {
  it('lee exp en milisegundos', () => {
    expect(jwtExpiresAt(fakeJwt({ sub: '1', exp: 1700000000 }))).toBe(1700000000 * 1000);
  });
  it('devuelve null sin exp o con token inválido', () => {
    expect(jwtExpiresAt(fakeJwt({ sub: '1' }))).toBeNull();
    expect(jwtExpiresAt('basura')).toBeNull();
    expect(jwtExpiresAt(null)).toBeNull();
  });
});
