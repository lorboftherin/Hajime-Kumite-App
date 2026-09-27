import { firstValueFrom } from 'rxjs';
import { ApiError } from '../../core/api-error';
import { ApiService } from '../../core/api.service';
import { apiBase } from '../../core/server';

/**
 * Actualización del portal público: Server-Sent Events con respaldo a sondeo.
 *
 * - Abre `GET {base}/stream` (EventSource). El servidor envía la instantánea
 *   (`live`, `people`, `overlay`) cada vez que cambia; EventSource se reconecta
 *   solo y manda `Last-Event-ID` para no volver a descargar lo que ya tiene.
 * - Si el servidor no acepta la conexión (503 por límite de conexiones, proxy
 *   que no deja pasar SSE, navegador sin EventSource) o mientras se reconecta,
 *   se consulta como siempre (`GET {base}`, `{base}/people`,
 *   `{base}/tatamis/{id}`) cada `pollMs`; cada minuto se vuelve a probar SSE.
 * - `gone`: el organizador desactivó o cambió el enlace.
 *
 * `ngsw-bypass`: el service worker de Angular no debe interceptar el stream.
 */
export interface FeedOptions<L = unknown, P = unknown, O = unknown> {
  /** `/public/<token>` o `/public/t/<slug>`. */
  base: string;
  live?: boolean;
  people?: boolean;
  tatami?: number | null;
  pollMs: number;
  /** El sondeo de «¿cuándo pelea?» es más espaciado (cambia menos). */
  peoplePollMs?: number;
  onLive?: (d: L) => void;
  onPeople?: (d: P) => void;
  onOverlay?: (d: O) => void;
  /** 404 o `gone`: el enlace ya no existe. */
  onGone?: (message: string) => void;
  /** true = actualizado; false = sin conexión por ahora. */
  onStatus?: (ok: boolean, mode: 'sse' | 'poll') => void;
}

const SSE_RETRY_MS = 60000;

export class PublicFeed<L = unknown, P = unknown, O = unknown> {
  private es: EventSource | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private lastPeoplePoll = 0;
  mode: 'sse' | 'poll' = 'poll';

  constructor(
    private api: ApiService,
    private o: FeedOptions<L, P, O>,
  ) {}

  start(): void {
    this.stopped = false;
    this.pollOnce(true); // la primera carga no espera a la conexión SSE
    this.openSse();
    this.timer = setInterval(() => this.tick(), this.o.pollMs);
  }

  stop(): void {
    this.stopped = true;
    this.es?.close();
    this.es = null;
    if (this.timer) clearInterval(this.timer);
    if (this.retry) clearTimeout(this.retry);
    this.timer = this.retry = null;
  }

  private streamUrl(): string {
    const q = new URLSearchParams({ 'ngsw-bypass': 'true' });
    q.set('live', String(this.o.live !== false));
    if (this.o.people) q.set('people', 'true');
    if (this.o.tatami != null) q.set('tatami', String(this.o.tatami));
    return `${apiBase()}${this.o.base}/stream?${q}`;
  }

  private openSse(): void {
    if (this.stopped || typeof EventSource === 'undefined') return;
    const es = new EventSource(this.streamUrl());
    this.es = es;
    const on = (name: string, fn?: (d: never) => void) =>
      es.addEventListener(name, (e) => {
        this.mode = 'sse';
        this.o.onStatus?.(true, 'sse');
        try {
          fn?.(JSON.parse((e as MessageEvent).data) as never);
        } catch {
          /* mensaje incompleto: llegará el siguiente */
        }
      });
    on('live', this.o.onLive);
    on('people', this.o.onPeople);
    on('overlay', this.o.onOverlay);
    es.addEventListener('gone', () => {
      this.o.onGone?.(
        $localize`:@@publico.feed.enlace-fue-desactivado:El enlace fue desactivado por la organización`,
      );
      this.stop();
    });
    es.onopen = () => (this.mode = 'sse');
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        // El servidor rechazó la conexión (503, 404, proxy): sondeo y se reintenta más tarde.
        this.es = null;
        this.mode = 'poll';
        if (!this.stopped) this.retry = setTimeout(() => this.openSse(), SSE_RETRY_MS);
      } else {
        this.mode = 'poll'; // reconectando: mientras tanto, sondeo
      }
    };
  }

  private tick(): void {
    if (this.stopped || document.visibilityState !== 'visible') return;
    if (this.es && this.es.readyState === EventSource.OPEN) return; // SSE al día
    this.pollOnce(false);
  }

  private async pollOnce(first: boolean): Promise<void> {
    const o = this.o;
    try {
      const jobs: Promise<unknown>[] = [];
      if (o.live !== false && o.onLive) jobs.push(this.get<L>(o.base).then((d) => o.onLive!(d)));
      const peopleDue = first || Date.now() - this.lastPeoplePoll >= (o.peoplePollMs ?? o.pollMs);
      if (o.people && o.onPeople && peopleDue) {
        this.lastPeoplePoll = Date.now();
        jobs.push(this.get<P>(`${o.base}/people`).then((d) => o.onPeople!(d)));
      }
      if (o.tatami != null && o.onOverlay) {
        jobs.push(
          this.get<O>(`${o.base}/tatamis/${encodeURIComponent(o.tatami)}`).then((d) =>
            o.onOverlay!(d),
          ),
        );
      }
      await Promise.all(jobs);
      if (!this.stopped) o.onStatus?.(true, 'poll');
    } catch (e) {
      const err = ApiError.from(e);
      if (err.status === 404) {
        o.onGone?.(err.message);
        this.stop();
      } else if (!this.stopped) {
        o.onStatus?.(false, 'poll');
      }
    }
  }

  private get<T>(path: string): Promise<T> {
    return firstValueFrom(this.api.get<T>(path));
  }
}
