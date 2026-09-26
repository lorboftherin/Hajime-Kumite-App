import { describe, expect, it } from 'vitest';
import { SessionExpiredService } from './session-expired.service';

describe('SessionExpiredService', () => {
  it('sin pantalla retenida, el vencimiento sigue el camino normal (ir a /login)', () => {
    const s = new SessionExpiredService();
    expect(s.notifyExpired()).toBe(false);
    expect(s.expired()).toBe(false);
  });

  it('con la mesa abierta, marca el vencimiento y no navega; al soltar se limpia', () => {
    const s = new SessionExpiredService();
    const release = s.hold();
    expect(s.notifyExpired()).toBe(true);
    expect(s.expired()).toBe(true);
    s.resolved();
    expect(s.expired()).toBe(false);
    s.notifyExpired();
    release();
    release(); // soltar dos veces no descuenta de más
    expect(s.held()).toBe(false);
    expect(s.expired()).toBe(false);
  });
});
