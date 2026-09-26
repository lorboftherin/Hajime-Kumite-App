import { beforeEach, describe, expect, it } from 'vitest';
import {
  CLOCK_EVENTS,
  Pending,
  SeqGuard,
  TimerCues,
  enqueueFinish,
  foldClock,
  isFinish,
  loadPending,
  methodsFor,
  pendingKey,
  pendingPath,
  pendingPayload,
  retryDecision,
  retryDelay,
  sanctionAbbr,
  savePending,
  timeUpAt,
} from './mesa-logic';

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
  it('otra tablet lleva la mesa (409 CONFLICT_DEVICE): conserva la cola en solo lectura', () => {
    expect(retryDecision({ status: 409, code: 'CONFLICT_DEVICE' }, 1)).toBe('device');
    expect(retryDecision({ status: 409, code: 'WARNINGS' }, 1)).toBe('drop');
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

describe('cierre en cola (sin señal)', () => {
  const finish = (id: string, winner: 'aka' | 'ao' | 'draw' = 'aka') => ({
    id,
    at: '2026-01-01T10:00:00Z',
    winner,
    method: 'points',
    reason: null,
    time_over: true,
  });

  it('va después de los eventos pendientes y se envía a /finish con el formato del cierre', () => {
    const q: Pending[] = [{ matchId: 5, body: { id: 'e1', type: 'point', at: 'x', color: 'ao', value: 2 }, attempts: 0 }];
    const out = enqueueFinish(q, 5, finish('f1'));
    expect(out.map((p) => p.body.id)).toEqual(['e1', 'f1']);
    expect(pendingPath(out[0])).toBe('/matches/5/events');
    expect(pendingPath(out[1])).toBe('/matches/5/finish');
    expect(isFinish(out[1])).toBe(true);
    expect(pendingPayload(out[1])).toEqual({
      id: 'f1',
      at: '2026-01-01T10:00:00Z',
      winner: 'aka',
      method: 'points',
      reason: null,
      time_over: true,
    });
    // Con motivo de advertencias aceptadas, el reenvío lleva el override.
    out[1].body.override = { reason: 'planilla' };
    expect(pendingPayload(out[1])['override']).toEqual({ reason: 'planilla' });
  });

  it('un segundo cierre del mismo combate reemplaza al primero; otros combates no se tocan', () => {
    let q = enqueueFinish([], 5, finish('f1'));
    q = enqueueFinish(q, 6, finish('g1'));
    q = enqueueFinish(q, 5, finish('f2', 'draw'));
    expect(q.map((p) => p.body.id)).toEqual(['g1', 'f2']);
    expect(q[1].body.method).toBe('draw');
    expect(q[1].body.color).toBeNull();
  });

  it('se guarda y se restaura como cualquier evento', () => {
    localStorage.clear();
    const q = enqueueFinish([], 11, finish('f9', 'ao'));
    savePending(q, new Set());
    const back = loadPending(11);
    expect(back).toHaveLength(1);
    expect(pendingPath(back[0])).toBe('/matches/11/finish');
    expect(pendingPayload(back[0])['winner']).toBe('ao');
  });

  it('los eventos del reloj se reconocen para avisar al descartarlos', () => {
    expect(CLOCK_EVENTS.has('pause')).toBe(true);
    expect(CLOCK_EVENTS.has('time_adjust')).toBe(true);
    expect(CLOCK_EVENTS.has('point')).toBe(false);
  });
});

describe('TimerCues (atoshi baraku y fin del tiempo)', () => {
  it('suena el aviso al cruzar 15 s y el final al llegar a 0:00, una sola vez', () => {
    const c = new TimerCues();
    expect(c.update(20, true, 120)).toBeNull(); // primera lectura: solo toma referencia
    expect(c.update(15.4, true, 120)).toBeNull();
    expect(c.update(14.9, true, 120)).toBe('warn');
    expect(c.update(14.7, true, 120)).toBeNull();
    expect(c.update(0.1, true, 120)).toBeNull();
    expect(c.update(0, true, 120)).toBe('end');
    expect(c.update(0, true, 120)).toBeNull();
  });

  it('no suena al abrir la mesa con el tiempo ya corrido ni en pausa', () => {
    const c = new TimerCues();
    expect(c.update(10, true, 120)).toBeNull();
    expect(c.update(9, true, 120)).toBeNull();
    const p = new TimerCues();
    p.update(16, false, 120);
    expect(p.update(14, false, 120)).toBeNull(); // ajuste en pausa: sin aviso
  });

  it('se rearma si el tiempo vuelve a subir (ajuste) y con reset()', () => {
    const c = new TimerCues();
    c.update(16, true, 120);
    expect(c.update(14, true, 120)).toBe('warn');
    expect(c.update(0, true, 120)).toBe('end');
    expect(c.update(20, false, 120)).toBeNull(); // +20 s por ajuste
    expect(c.update(16, true, 120)).toBeNull();
    expect(c.update(14, true, 120)).toBe('warn');
    c.reset();
    expect(c.update(0, true, 120)).toBeNull();
  });

  it('sin duración o combates de 15 s o menos no hay aviso de 15 s', () => {
    const c = new TimerCues();
    c.update(15, true, 15);
    expect(c.update(14, true, 15)).toBeNull();
    expect(c.update(0, true, 15)).toBe('end');
    const k = new TimerCues();
    k.update(1, true, 0);
    expect(k.update(0, true, 0)).toBeNull();
  });

  it('calcula el instante exacto del fin para el yame automático', () => {
    expect(timeUpAt(10_000, 120.3, 120)).toBeCloseTo(9_700, 5);
    expect(timeUpAt(10_000, 119, 120)).toBe(10_000);
  });
});

describe('presentación de la mesa', () => {
  it('abrevia las sanciones para el celular', () => {
    expect(sanctionAbbr('Chui 1')).toBe('C1');
    expect(sanctionAbbr('Hansoku-chui')).toBe('HC');
    expect(sanctionAbbr('Hansoku')).toBe('H');
    expect(sanctionAbbr('Keikoku')).toBe('K');
  });

  it('ofrece métodos de cierre según la modalidad', () => {
    expect(methodsFor('kata')).toContain('flags');
    expect(methodsFor('kata')).not.toContain('senshu');
    expect(methodsFor('kumite')).toContain('senshu');
    expect(methodsFor('kumite')).not.toContain('flags');
  });
});
