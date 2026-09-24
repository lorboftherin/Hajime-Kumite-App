// Lógica pura de la mesa (sin Angular): se prueba de forma aislada.
import { EventIn } from '../../core/models';

export interface Pending {
  matchId: number;
  body: EventIn;
  attempts: number;
}

/**
 * Guardia de secuencia: cada petición (GET o POST) toma un número creciente al salir;
 * una respuesta solo se aplica si su número es mayor que el de la última aplicada.
 * Así un GET lento nunca pisa el marcador que ya mostró un POST posterior.
 */
export class SeqGuard {
  private issued = 0;
  private applied = 0;

  next(): number {
    return ++this.issued;
  }

  /** true si la respuesta con ese número es más fresca que la última aplicada (y la registra). */
  accept(seq: number): boolean {
    if (seq <= this.applied) return false;
    this.applied = seq;
    return true;
  }

  get lastApplied(): number {
    return this.applied;
  }
}

export type RetryDecision = 'retry' | 'stuck' | 'auth' | 'drop';

export const MAX_SERVER_ATTEMPTS = 5;

/**
 * Política de reintentos de la cola:
 * - sin conexión (status 0 / timeout): se reintenta indefinidamente con el MISMO id;
 * - 5xx: hasta MAX_SERVER_ATTEMPTS intentos y luego queda "bloqueado" (el operador decide);
 * - 401: se conserva la cola y se detiene hasta volver a iniciar sesión;
 * - otros 4xx: rechazo de negocio, se descarta.
 * `attempts` es el número de intentos ya realizados, incluido el que acaba de fallar.
 */
export function retryDecision(err: { status: number; code?: string }, attempts: number, maxServer = MAX_SERVER_ATTEMPTS): RetryDecision {
  if (err.status === 0 || err.code === 'TIMEOUT') return 'retry';
  if (err.status === 401) return 'auth';
  if (err.status >= 500) return attempts >= maxServer ? 'stuck' : 'retry';
  return 'drop';
}

/** Espera antes del siguiente reintento (backoff exponencial, máx. 15 s). */
export function retryDelay(attempts: number): number {
  return Math.min(15000, 1000 * 2 ** Math.min(Math.max(attempts - 1, 0), 4));
}

export interface ClockAnchor {
  elapsed: number;
  running: boolean;
  at: number;
}

export interface ClockRules {
  time_mode?: string;
  auto_pause_on_point?: boolean;
}

/** Igual que el servidor: en tiempo efectivo un punto detiene el reloj. */
export function autoPauseOnPoint(rules: ClockRules | null | undefined): boolean {
  const mode = rules?.time_mode ?? 'effective';
  return mode === 'effective' && (rules?.auto_pause_on_point ?? true);
}

/**
 * Pliega los eventos pendientes (aún no confirmados) sobre el ancla del servidor,
 * con las mismas reglas que compute_scoreboard del backend.
 */
export function foldClock(anchor: ClockAnchor, pending: Array<Pick<EventIn, 'type' | 'at' | 'value'>>, now: number, rules?: ClockRules | null) {
  const autoPause = autoPauseOnPoint(rules);
  let elapsed = anchor.elapsed;
  let runSince: number | null = anchor.running ? anchor.at : null;
  for (const p of pending) {
    const t = Date.parse(p.at);
    switch (p.type) {
      case 'start':
      case 'resume':
        if (runSince === null) runSince = t;
        break;
      case 'pause':
        if (runSince !== null) {
          elapsed += (t - runSince) / 1000;
          runSince = null;
        }
        break;
      case 'time_adjust':
        elapsed += Number(p.value ?? 0);
        break;
      case 'point':
        if (autoPause && runSince !== null) {
          elapsed += (t - runSince) / 1000;
          runSince = null;
        }
        break;
    }
  }
  if (runSince !== null) elapsed += Math.max(0, now - runSince) / 1000;
  return { elapsed: Math.max(0, elapsed), running: runSince !== null };
}

// --- Persistencia de la cola por combate ---
export const PENDING_KEY_PREFIX = 'hajime.mesa.pending.';

export function pendingKey(matchId: number): string {
  return PENDING_KEY_PREFIX + matchId;
}

export function loadPending(matchId: number, storage: Pick<Storage, 'getItem'> | null = defaultStorage()): Pending[] {
  try {
    const raw = storage?.getItem(pendingKey(matchId));
    if (!raw) return [];
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    return list
      .filter((x): x is EventIn => !!x && typeof x === 'object' && typeof (x as EventIn).id === 'string' && typeof (x as EventIn).type === 'string')
      .map((body) => ({ matchId, body, attempts: 0 }));
  } catch {
    return [];
  }
}

/** Guarda la cola agrupada por combate; borra las claves de combates que ya no tienen pendientes. */
export function savePending(queue: Pending[], known: Set<number>, storage: Pick<Storage, 'setItem' | 'removeItem'> | null = defaultStorage()): void {
  const byMatch = new Map<number, EventIn[]>();
  for (const p of queue) byMatch.set(p.matchId, [...(byMatch.get(p.matchId) ?? []), p.body]);
  for (const id of known) {
    if (!byMatch.has(id)) {
      try {
        storage?.removeItem(pendingKey(id));
      } catch {
        /* sin almacenamiento */
      }
      known.delete(id);
    }
  }
  for (const [id, bodies] of byMatch) {
    try {
      storage?.setItem(pendingKey(id), JSON.stringify(bodies));
      known.add(id);
    } catch {
      /* sin almacenamiento (modo privado, cuota) */
    }
  }
}

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}
