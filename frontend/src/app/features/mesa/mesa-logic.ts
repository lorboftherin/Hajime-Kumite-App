// Lógica pura de la mesa (sin Angular): se prueba de forma aislada.
import { Color, EventIn } from '../../core/models';

/**
 * Cuerpo de un elemento de la cola. Casi siempre es un evento (POST /matches/{id}/events);
 * con `type: 'finish'` es el cierre del combate (POST /matches/{id}/finish), que el servidor
 * también trata como idempotente por `id`: se puede dejar en cola sin señal igual que un punto.
 */
export interface QueueBody extends EventIn {
  winner?: Color | 'draw' | null;
  method?: string | null;
  time_over?: boolean;
}

export interface Pending {
  matchId: number;
  body: QueueBody;
  attempts: number;
}

/** Datos del cierre tal como los arma la hoja «Confirmar ganador». */
export interface FinishData {
  id: string;
  at: string;
  winner: Color | 'draw';
  method: string;
  reason: string | null;
  time_over: boolean;
}

export function isFinish(p: Pending | QueueBody): boolean {
  return ('body' in p ? p.body : p).type === 'finish';
}

/** Ruta del POST de un elemento de la cola. */
export function pendingPath(p: Pending): string {
  return `/matches/${p.matchId}/${isFinish(p) ? 'finish' : 'events'}`;
}

/** Cuerpo que se envía: el cierre va con el formato de FinishIn (sin `type` ni `color`). */
export function pendingPayload(p: Pending): Record<string, unknown> {
  if (!isFinish(p)) return p.body as unknown as Record<string, unknown>;
  const b = p.body;
  return {
    id: b.id,
    at: b.at,
    winner: b.winner,
    method: b.method ?? 'points',
    reason: b.reason ?? null,
    time_over: b.time_over ?? true,
    ...(b.override ? { override: b.override } : {}),
  };
}

/**
 * Agrega el cierre al final de la cola (después de los eventos pendientes, que van primero).
 * Si ya había un cierre en cola para ese combate, se reemplaza: vale la última decisión.
 */
export function enqueueFinish(queue: Pending[], matchId: number, f: FinishData): Pending[] {
  const body: QueueBody = {
    id: f.id,
    type: 'finish',
    at: f.at,
    color: f.winner === 'draw' ? null : f.winner,
    winner: f.winner,
    method: f.winner === 'draw' ? 'draw' : f.method,
    reason: f.reason,
    time_over: f.time_over,
  };
  return [
    ...queue.filter((p) => !(p.matchId === matchId && isFinish(p))),
    { matchId, body, attempts: 0 },
  ];
}

/** Eventos del reloj: descartarlos desincroniza el reloj de la tablet con el del servidor. */
export const CLOCK_EVENTS = new Set(['start', 'resume', 'pause', 'time_adjust']);

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

export type RetryDecision = 'retry' | 'stuck' | 'auth' | 'device' | 'drop';

export const MAX_SERVER_ATTEMPTS = 5;

/**
 * Política de reintentos de la cola:
 * - sin conexión (status 0 / timeout): se reintenta indefinidamente con el MISMO id;
 * - 5xx: hasta MAX_SERVER_ATTEMPTS intentos y luego queda "bloqueado" (el operador decide);
 * - 401: se conserva la cola y se detiene hasta volver a iniciar sesión;
 * - 409 CONFLICT_DEVICE: otra tablet lleva la mesa; se conserva la cola y esta pasa a solo lectura;
 * - otros 4xx: rechazo de negocio, se descarta.
 * `attempts` es el número de intentos ya realizados, incluido el que acaba de fallar.
 */
export function retryDecision(
  err: { status: number; code?: string },
  attempts: number,
  maxServer = MAX_SERVER_ATTEMPTS,
): RetryDecision {
  if (err.status === 0 || err.code === 'TIMEOUT') return 'retry';
  if (err.status === 401) return 'auth';
  if (err.status === 409 && err.code === 'CONFLICT_DEVICE') return 'device';
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
export function foldClock(
  anchor: ClockAnchor,
  pending: Array<Pick<EventIn, 'type' | 'at' | 'value'>>,
  now: number,
  rules?: ClockRules | null,
) {
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

/**
 * Marcador que ve el operador: el confirmado por el servidor más los puntos que
 * siguen en la cola (sin señal o aún enviándose), con las anulaciones pendientes
 * («Deshacer último») aplicadas. Sin esto, sin red el marcador se quedaba en el
 * último valor confirmado aunque el punto ya figurara «pendiente» en el
 * historial, y el operador podía volver a marcarlo. Mismas reglas que
 * compute_scoreboard del backend para `point` y `annul`.
 */
export function scoreWithPending(
  score: Record<Color, number>,
  events: ReadonlyArray<{ id: string; type: string; color?: string | null; value?: number | null }>,
  annulledIds: ReadonlyArray<string>,
  pending: ReadonlyArray<Pick<EventIn, 'id' | 'type' | 'color' | 'value' | 'target_id'>>,
): Record<Color, number> {
  const out: Record<Color, number> = { aka: score.aka, ao: score.ao };
  if (!pending.length) return out;
  const annulled = new Set(annulledIds);
  const points = new Map<string, { color: Color; value: number }>();
  for (const e of events) {
    if (e.type === 'point' && (e.color === 'aka' || e.color === 'ao') && !annulled.has(e.id)) {
      points.set(e.id, { color: e.color, value: Number(e.value ?? 0) });
    }
  }
  for (const p of pending) {
    if (p.type === 'point' && (p.color === 'aka' || p.color === 'ao')) {
      const value = Number(p.value ?? 0);
      out[p.color] += value;
      points.set(p.id, { color: p.color, value });
    } else if (p.type === 'annul' && p.target_id) {
      const target = points.get(p.target_id);
      if (target) {
        out[target.color] = Math.max(0, out[target.color] - target.value);
        points.delete(p.target_id);
      }
    }
  }
  return out;
}

// --- Persistencia de la cola por combate ---
export const PENDING_KEY_PREFIX = 'hajime.mesa.pending.';

export function pendingKey(matchId: number): string {
  return PENDING_KEY_PREFIX + matchId;
}

export function loadPending(
  matchId: number,
  storage: Pick<Storage, 'getItem'> | null = defaultStorage(),
): Pending[] {
  try {
    const raw = storage?.getItem(pendingKey(matchId));
    if (!raw) return [];
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    return list
      .filter(
        (x): x is QueueBody =>
          !!x &&
          typeof x === 'object' &&
          typeof (x as EventIn).id === 'string' &&
          typeof (x as EventIn).type === 'string',
      )
      .map((body) => ({ matchId, body, attempts: 0 }));
  } catch {
    return [];
  }
}

/** Guarda la cola agrupada por combate; borra las claves de combates que ya no tienen pendientes. */
export function savePending(
  queue: Pending[],
  known: Set<number>,
  storage: Pick<Storage, 'setItem' | 'removeItem'> | null = defaultStorage(),
): void {
  const byMatch = new Map<number, QueueBody[]>();
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

// --- Avisos de tiempo (atoshi baraku y fin) ---

/** Aviso «atoshi baraku»: quedan 15 segundos. */
export const WARN_SECONDS = 15;

export type TimerCue = 'warn' | 'end';

/**
 * Decide cuándo sonar: solo al CRUZAR un umbral mientras se mira el combate (no al abrir la
 * mesa con el tiempo ya corrido). Si el tiempo vuelve a subir (ajuste), el aviso se rearma.
 */
export class TimerCues {
  private prev: number | null = null;
  private fired = new Set<TimerCue>();

  /** Olvida el estado (otro combate o se recargó la pantalla). */
  reset(): void {
    this.prev = null;
    this.fired.clear();
  }

  /**
   * `remaining`: segundos restantes; `running`: el reloj corre; `duration`: duración total.
   * Devuelve el aviso que corresponde disparar ahora, o null.
   */
  update(
    remaining: number,
    running: boolean,
    duration: number,
    warnAt = WARN_SECONDS,
  ): TimerCue | null {
    const prev = this.prev;
    this.prev = remaining;
    if (remaining > warnAt) this.fired.delete('warn');
    if (remaining > 0) this.fired.delete('end');
    if (prev === null || duration <= 0) return null;
    if (remaining <= 0 && prev > 0 && !this.fired.has('end')) {
      this.fired.add('end');
      this.fired.add('warn');
      return 'end';
    }
    if (
      running &&
      duration > warnAt &&
      remaining <= warnAt &&
      remaining > 0 &&
      prev > warnAt &&
      !this.fired.has('warn')
    ) {
      this.fired.add('warn');
      return 'warn';
    }
    return null;
  }
}

/**
 * Momento exacto (ms) en que el reloj llegó a 0:00, a partir de cuánto se pasó: así el yame
 * automático deja el tiempo justo en la duración aunque el tic llegue unos ms tarde.
 */
export function timeUpAt(now: number, elapsed: number, duration: number): number {
  return now - Math.max(0, elapsed - duration) * 1000;
}

// --- Presentación ---

/**
 * Abreviatura de una sanción para el celular: «Chui 1» → «C1», «Hansoku-chui» → «HC»,
 * «Hansoku» → «H», «Jogai 2» → «J2». El nombre completo queda en el título y la etiqueta accesible.
 */
export function sanctionAbbr(label: string): string {
  const parts = label
    .trim()
    .split(/[\s\-·.]+/)
    .filter(Boolean);
  return parts.map((p) => (/^\d+$/.test(p) ? p : p[0].toUpperCase())).join('') || label;
}

/** Métodos de victoria que ofrece la hoja de cierre según la modalidad. */
export const KUMITE_METHODS = [
  'points',
  'point_gap',
  'senshu',
  'hantei',
  'golden_point',
  'hansoku',
  'kiken',
  'shikkaku',
  'walkover',
  'decision',
];
export const KATA_METHODS = ['flags', 'decision', 'kiken', 'shikkaku', 'walkover'];

export function methodsFor(modality: string | null | undefined): string[] {
  return modality === 'kata' ? KATA_METHODS : KUMITE_METHODS;
}
