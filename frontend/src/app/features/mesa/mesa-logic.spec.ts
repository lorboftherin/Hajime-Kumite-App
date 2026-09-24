import { beforeEach, describe, expect, it } from 'vitest';
import { SeqGuard, foldClock, loadPending, pendingKey, retryDecision, retryDelay, savePending } from './mesa-logic';

describe('SeqGuard', () => {
  it('descarta un GET lento que llega después de un POST más nuevo', () => {
    const g = new SeqGuard();
    const slowGet = g.next();
    const post = g.next();
    expect(g.accept(post)).toBe(true); // el POST responde primero y se aplica
    expect(g.accept(slowGet)).toBe(false); // el GET viejo no debe revertir el punto
    expect(g.lastApplied).toBe(post);
  });

  it('acepta respuestas en orden y rechaza repetidas', () => {
    const g = new SeqGuard();
    const a = g.next();
    const b = g.next();
    expect(g.accept(a)).toBe(true);
    expect(g.accept(b)).toBe(true);
    expect(g.accept(b)).toBe(false);
  });
});

describe('retryDecision', () => {
  it('reintenta sin límite ante errores de red', () => {
    expect(retryDecision({ status: 0 }, 1)).toBe('retry');
    expect(retryDecision({ status: 0 }, 500)).toBe('retry');
    expect(retryDecision({ status: -1, code: 'TIMEOUT' }, 50)).toBe('retry');
  });
  it('limita los 5xx a 5 intentos y luego bloquea', () => {
    expect(retryDecision({ status: 500 }, 1)).toBe('retry');
    expect(retryDecision({ status: 503 }, 4)).toBe('retry');
    expect(retryDecision({ status: 500 }, 5)).toBe('stuck');
    expect(retryDecision({ status: 502 }, 9)).toBe('stuck');
  });
  it('conserva la cola ante 401 y descarta el resto de 4xx', () => {
    expect(retryDecision({ status: 401 }, 1)).toBe('auth');
    expect(retryDecision({ status: 409 }, 1)).toBe('drop');
    expect(retryDecision({ status: 422 }, 1)).toBe('drop');
  });
  it('backoff exponencial con tope de 15 s', () => {
    expect(retryDelay(1)).toBe(1000);
    expect(retryDelay(3)).toBe(4000);
    expect(retryDelay(10)).toBe(15000);
  });
});

describe('foldClock', () => {
  const t0 = Date.parse('2026-01-01T10:00:00Z');
  const iso = (ms: number) => new Date(ms).toISOString();

  it('un punto pendiente pausa el reloj en tiempo efectivo (como el servidor)', () => {
    const anchor = { elapsed: 10, running: true, at: t0 };
    const pending = [{ type: 'point', at: iso(t0 + 5000), value: 1 }];
    const c = foldClock(anchor, pending, t0 + 20000, { time_mode: 'effective', auto_pause_on_point: true });
    expect(c.running).toBe(false);
    expect(c.elapsed).toBeCloseTo(15, 3);
  });

  it('no pausa en tiempo corrido ni con auto_pause desactivado', () => {
    const anchor = { elapsed: 10, running: true, at: t0 };
    const pending = [{ type: 'point', at: iso(t0 + 5000), value: 1 }];
    expect(foldClock(anchor, pending, t0 + 20000, { time_mode: 'running', auto_pause_on_point: true })).toEqual({ elapsed: 30, running: true });
    expect(foldClock(anchor, pending, t0 + 20000, { time_mode: 'effective', auto_pause_on_point: false })).toEqual({ elapsed: 30, running: true });
  });

  it('sin reglas asume el valor por defecto del servidor (pausa automática)', () => {
    const c = foldClock({ elapsed: 0, running: true, at: t0 }, [{ type: 'point', at: iso(t0 + 1000), value: 3 }], t0 + 9000, null);
    expect(c).toEqual({ elapsed: 1, running: false });
  });

  it('pausa, reanuda y ajusta', () => {
    const pending = [
      { type: 'pause', at: iso(t0 + 2000) },
      { type: 'resume', at: iso(t0 + 4000) },
      { type: 'time_adjust', at: iso(t0 + 4500), value: -1 },
    ];
    const c = foldClock({ elapsed: 0, running: true, at: t0 }, pending, t0 + 6000, {});
    expect(c.running).toBe(true);
    expect(c.elapsed).toBeCloseTo(2 + 2 - 1, 3);
  });
});

describe('persistencia de la cola', () => {
  beforeEach(() => localStorage.clear());

  it('guarda por combate, restaura con attempts=0 y limpia claves vacías', () => {
    const known = new Set<number>();
    const q = [
      { matchId: 7, body: { id: 'a', type: 'point', at: 'x', color: 'aka' as const, value: 1 }, attempts: 3 },
      { matchId: 8, body: { id: 'b', type: 'pause', at: 'y' }, attempts: 0 },
    ];
    savePending(q, known);
    expect(known).toEqual(new Set([7, 8]));
    expect(loadPending(7)).toEqual([{ matchId: 7, body: q[0].body, attempts: 0 }]);
    savePending(q.slice(0, 1), known);
    expect(localStorage.getItem(pendingKey(8))).toBeNull();
    expect(known).toEqual(new Set([7]));
  });

  it('tolera almacenamiento roto o datos corruptos', () => {
    localStorage.setItem(pendingKey(9), '{no es json');
    expect(loadPending(9)).toEqual([]);
    const broken = {
      getItem: () => {
        throw new Error('bloqueado');
      },
      setItem: () => {
        throw new Error('bloqueado');
      },
      removeItem: () => {
        throw new Error('bloqueado');
      },
    };
    expect(loadPending(1, broken)).toEqual([]);
    expect(() => savePending([{ matchId: 1, body: { id: 'a', type: 'point', at: 'x' }, attempts: 0 }], new Set([2]), broken)).not.toThrow();
  });
});
