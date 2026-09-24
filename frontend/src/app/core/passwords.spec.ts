import { describe, expect, it } from 'vitest';
import { MIN_PASSWORD, passwordFormError, randomPassword } from './passwords';

describe('passwords', () => {
  it('valida el formulario de cambio de contraseña', () => {
    expect(passwordFormError('', 'nuevaclave1', 'nuevaclave1')).toContain('actual');
    expect(passwordFormError('vieja123', 'corta', 'corta')).toContain('8');
    expect(passwordFormError('vieja1234', 'vieja1234', 'vieja1234')).toContain('distinta');
    expect(passwordFormError('vieja1234', 'nuevaclave1', 'nuevaclave2')).toContain('no coinciden');
    expect(passwordFormError('vieja1234', 'nuevaclave1', 'nuevaclave1')).toBe('');
  });

  it('genera contraseñas temporales legibles y suficientemente largas', () => {
    const p = randomPassword();
    expect(p.length).toBeGreaterThanOrEqual(MIN_PASSWORD);
    expect(p).not.toMatch(/[0O1lI]/);
    expect(randomPassword()).not.toBe(p);
  });
});
