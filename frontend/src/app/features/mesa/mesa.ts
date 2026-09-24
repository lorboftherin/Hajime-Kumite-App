import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiError } from '../../core/api-error';
import { ApiService } from '../../core/api.service';
import { DialogService } from '../../core/dialog.service';
import { EVENT_LABEL, METHOD_LABEL, POINT_LABEL, fmtTime, mmss, newId } from '../../core/format';
import { Category, Color, EventIn, FinishOut, MatchEvent, Scoreboard, TatamiQueue, Tournament } from '../../core/models';
import { MutationService } from '../../core/mutation.service';
import { ToastService } from '../../core/toast.service';
import { StatusBadge } from '../../shared/badge';
import { Modal } from '../../shared/modal';
import { LabelPipe } from '../../shared/pipes';

interface Pending {
  matchId: number;
  body: EventIn;
  attempts: number;
}

interface LogRow {
  id: string;
  type: string;
  color: string | null;
  text: string;
  time: string;
  annulled: boolean;
  pending: boolean;
}

const METHODS = ['points', 'point_gap', 'senshu', 'hantei', 'golden_point', 'hansoku', 'kiken', 'shikkaku', 'walkover', 'decision'];
const UNDO_SKIP = new Set(['annul', 'finish']);

/**
 * Mesa de kumite. Cada acción es un evento inmutable con UUID del cliente y hora del dispositivo.
 * El POST es idempotente: ante un error de red se reintenta con el MISMO id (cola con backoff).
 */
@Component({
  selector: 'app-mesa',
  imports: [FormsModule, RouterLink, StatusBadge, Modal, LabelPipe],
  templateUrl: './mesa.html',
  styleUrl: './mesa.scss',
})
export class MesaPage {
  private api = inject(ApiService);
  private mut = inject(MutationService);
  private dialog = inject(DialogService);
  private toast = inject(ToastService);
  private router = inject(Router);

  readonly matchId = input.required<string>();
  readonly tatami = input<string | undefined>(undefined);

  readonly methodLabel = METHOD_LABEL;
  readonly methods = METHODS;
  readonly colors: Color[] = ['aka', 'ao'];

  readonly id = computed(() => Number(this.matchId()));
  readonly sb = signal<Scoreboard | null>(null);
  readonly category = signal<Category | null>(null);
  readonly tournament = signal<Tournament | null>(null);
  readonly loadError = signal('');

  /** Ancla del cronómetro: estado confirmado por el servidor y hora local de recepción. */
  private readonly anchor = signal({ elapsed: 0, running: false, at: Date.now() });
  readonly now = signal(Date.now());

  // Cola de eventos pendientes (en memoria).
  readonly pending = signal<Pending[]>([]);
  readonly offline = signal(false);
  private sending = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  readonly unlocked = signal(false);
  readonly finishOpen = signal(false);
  finishForm = { winner: 'aka' as Color, method: 'points', reason: '', time_over: true };
  private finishId = '';
  readonly finishing = signal(false);

  // Kata por banderas
  readonly votes = signal<Array<Color | null>>([]);
  readonly headVote = signal<Color | null>(null);
  readonly needsHead = signal(false);

  readonly isKata = computed(() => this.category()?.modality === 'kata');
  readonly judges = computed(() => {
    const c = this.category();
    const d = (this.tournament()?.kata_defaults ?? {}) as Record<string, any>;
    return Number(c?.kata_judges ?? d['judges'] ?? 3);
  });

  readonly match = computed(() => this.sb()?.match ?? null);
  readonly finished = computed(() => this.match()?.status === 'finished');
  readonly playable = computed(() => {
    const m = this.match();
    return !!m && !!m.aka_registration_id && !!m.ao_registration_id && !['pending', 'bye', 'void'].includes(m.status);
  });
  readonly locked = computed(() => !this.playable() || (this.finished() && !this.unlocked()));

  /** Cronómetro: estado del servidor + eventos de tiempo aún pendientes, calculado en el cliente. */
  readonly clock = computed(() => {
    const a = this.anchor();
    const now = this.now();
    let elapsed = a.elapsed;
    let runSince: number | null = a.running ? a.at : null;
    for (const p of this.pending()) {
      if (p.matchId !== this.id()) continue;
      const t = Date.parse(p.body.at);
      switch (p.body.type) {
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
          elapsed += Number(p.body.value ?? 0);
          break;
      }
    }
    if (runSince !== null) elapsed += Math.max(0, now - runSince) / 1000;
    return { elapsed: Math.max(0, elapsed), running: runSince !== null };
  });
  readonly duration = computed(() => this.sb()?.duration_seconds ?? 0);
  readonly remaining = computed(() => Math.max(0, this.duration() - this.clock().elapsed));
  readonly timeOver = computed(() => this.duration() > 0 && this.clock().elapsed >= this.duration());
  readonly timerText = computed(() => mmss(Math.ceil(this.remaining())));
  readonly started = computed(
    () => !!this.sb()?.started || this.pending().some((p) => p.matchId === this.id() && p.body.type === 'start'),
  );

  readonly pendingHere = computed(() => this.pending().filter((p) => p.matchId === this.id()));

  readonly suggestionText = computed(() => {
    const s = this.sb()?.suggestion;
    if (!s) return '';
    if (s.winner) return `Sugerencia: gana ${s.winner === 'aka' ? 'AKA' : 'AO'} por ${METHOD_LABEL[s.method ?? ''] ?? s.method}`;
    if (s.needs === 'hantei') return 'Empate: se necesita hantei (decisión de jueces)';
    if (s.needs === 'golden_point') return 'Empate: punto de oro (senshu)';
    return s.reason ?? '';
  });

  readonly log = computed<LogRow[]>(() => {
    const sb = this.sb();
    if (!sb) return [];
    const annulled = new Set(sb.annulled_event_ids);
    const labelOf = (e: { type: string; color?: string | null; value?: number | null; method?: string | null; target_id?: string | null; reason?: string | null }): string =>
      this.describe(e, sb);
    const rows: LogRow[] = [...sb.events]
      .sort((a, b) => a.device_at.localeCompare(b.device_at))
      .map((e) => ({
        id: e.id,
        type: e.type,
        color: e.color,
        text: labelOf(e),
        time: fmtTime(e.device_at),
        annulled: annulled.has(e.id),
        pending: false,
      }));
    for (const p of this.pendingHere()) {
      rows.push({
        id: p.body.id,
        type: p.body.type,
        color: p.body.color ?? null,
        text: labelOf(p.body),
        time: fmtTime(p.body.at),
        annulled: false,
        pending: true,
      });
    }
    return rows.reverse();
  });

  /** Último evento activo (no anulado, no anulación) que se puede deshacer, incluidos los pendientes. */
  readonly undoTarget = computed(() => {
    const sb = this.sb();
    if (!sb) return null;
    const annulled = new Set(sb.annulled_event_ids);
    const pend = this.pendingHere().map((p) => p.body);
    for (const p of pend) if (p.type === 'annul' && p.target_id) annulled.add(p.target_id);
    const all: Array<{ id: string; type: string; color?: string | null; value?: number | null }> = [
      ...[...sb.events].sort((a, b) => a.device_at.localeCompare(b.device_at)),
      ...pend,
    ];
    for (let i = all.length - 1; i >= 0; i--) {
      const e = all[i];
      if (!UNDO_SKIP.has(e.type) && !annulled.has(e.id)) return e;
    }
    return null;
  });

  constructor() {
    const tick = setInterval(() => this.now.set(Date.now()), 200);
    const refresh = setInterval(() => {
      if (!this.pending().length && !this.finishOpen()) this.reload(true);
    }, 15000);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(tick);
      clearInterval(refresh);
      if (this.retryTimer) clearTimeout(this.retryTimer);
    });
    effect(() => {
      const id = this.id();
      untracked(() => {
        this.unlocked.set(false);
        this.needsHead.set(false);
        this.headVote.set(null);
        this.load(id);
      });
    });
  }

  // --- Carga ---
  async load(id: number): Promise<void> {
    this.loadError.set('');
    try {
      const sb = await firstValueFrom(this.api.get<Scoreboard>(`/matches/${id}`));
      this.setScoreboard(sb);
      if (this.category()?.id !== sb.match.category_id) {
        const c = await firstValueFrom(this.api.get<Category>(`/categories/${sb.match.category_id}`));
        this.category.set(c);
        if (this.tournament()?.id !== c.tournament_id) {
          this.tournament.set(await firstValueFrom(this.api.get<Tournament>(`/tournaments/${c.tournament_id}`)));
        }
      }
      this.votes.set(Array.from({ length: this.judges() }, () => null));
    } catch (e) {
      this.loadError.set(ApiError.from(e).fullMessage);
    }
  }

  async reload(silent = false): Promise<void> {
    try {
      this.setScoreboard(await firstValueFrom(this.api.get<Scoreboard>(`/matches/${this.id()}`)));
      this.offline.set(false);
    } catch (e) {
      if (!silent) this.toast.error(ApiError.from(e).fullMessage);
    }
  }

  private setScoreboard(sb: Scoreboard): void {
    if (sb.match.id !== this.id()) return;
    this.sb.set(sb);
    this.anchor.set({ elapsed: sb.elapsed_seconds, running: sb.running, at: Date.now() });
  }

  // --- Envío de eventos con reintentos ---
  send(type: string, extra: Partial<EventIn> = {}): void {
    if (!this.sb()) return;
    const body: EventIn = { id: newId(), type, at: new Date().toISOString(), ...extra };
    this.pending.update((q) => [...q, { matchId: this.id(), body, attempts: 0 }]);
    this.flush();
  }

  private async flush(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.pending().length) {
        const p = this.pending()[0];
        try {
          const sb = await firstValueFrom(this.api.post<Scoreboard>(`/matches/${p.matchId}/events`, p.body));
          this.pending.update((q) => q.filter((x) => x !== p));
          this.offline.set(false);
          if (p.matchId === this.id()) this.setScoreboard(sb);
        } catch (e) {
          const err = ApiError.from(e);
          if (err.isNetwork || err.status >= 500) {
            // Sin conexión: se reintenta el MISMO evento (mismo id) con backoff.
            this.offline.set(true);
            p.attempts++;
            const delay = Math.min(15000, 1000 * 2 ** Math.min(p.attempts - 1, 4));
            this.retryTimer = setTimeout(() => {
              this.retryTimer = null;
              this.flush();
            }, delay);
            return;
          }
          // Rechazo de negocio: se descarta ese evento y se informa.
          this.pending.update((q) => q.filter((x) => x !== p));
          this.toast.error(`${EVENT_LABEL[p.body.type] ?? p.body.type}: ${err.fullMessage}`);
          if (p.matchId === this.id()) this.reload(true);
        }
      }
    } finally {
      this.sending = false;
    }
  }

  retryNow(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.flush();
  }

  // --- Acciones de mesa ---
  point(color: Color, value: number): void {
    this.send('point', { color, value });
  }

  sanction(color: Color, level: number): void {
    this.send('sanction', { color, value: level });
  }

  hajime(): void {
    this.send(this.started() ? 'resume' : 'start');
  }

  yame(): void {
    this.send('pause');
  }

  adjust(seconds: number): void {
    // time_adjust suma segundos al tiempo transcurrido: +1 s transcurrido = -1 s restante.
    this.send('time_adjust', { value: seconds });
  }

  async special(type: 'senshu_cancel' | 'kiken' | 'shikkaku' | 'walkover' | 'hantei', color: Color): Promise<void> {
    const who = color === 'aka' ? 'AKA' : 'AO';
    const text: Record<string, string> = {
      senshu_cancel: `Cancelar el senshu de ${who}`,
      kiken: `${who} abandona (kiken)`,
      shikkaku: `${who} es descalificado (shikkaku)`,
      walkover: `${who} no se presenta (walkover)`,
      hantei: `Hantei: los jueces dan la victoria a ${who}`,
    };
    const ok = await this.dialog.confirm({ title: EVENT_LABEL[type], message: text[type] + '.', confirmText: 'Registrar' });
    if (ok) this.send(type, { color });
  }

  undo(): void {
    const t = this.undoTarget();
    if (!t) {
      this.toast.show('No hay eventos para deshacer');
      return;
    }
    this.send('annul', { target_id: t.id });
    this.toast.show(`Deshecho: ${this.describe(t, this.sb()!)}`);
  }

  // --- Cierre ---
  openFinish(): void {
    const s = this.sb();
    if (!s) return;
    const sug = s.suggestion;
    this.finishForm = {
      winner: (this.finished() ? s.winner : sug.winner) ?? (s.score.aka >= s.score.ao ? 'aka' : 'ao'),
      method: (this.finished() ? s.method : sug.method) ?? (sug.needs === 'hantei' ? 'hantei' : 'points'),
      reason: '',
      time_over: this.timeOver(),
    };
    this.finishId = newId();
    this.finishOpen.set(true);
  }

  async confirmFinish(): Promise<void> {
    if (this.pending().length) {
      this.toast.warn('Hay eventos pendientes de enviar. Espera la conexión antes de cerrar.');
      return;
    }
    const f = this.finishForm;
    const body = {
      id: this.finishId,
      at: new Date().toISOString(),
      winner: f.winner,
      method: f.method,
      reason: f.reason.trim() || null,
      time_over: f.time_over,
    };
    this.finishing.set(true);
    const res = await this.mut.run<FinishOut>(
      (override) => this.api.post<FinishOut>(`/matches/${this.id()}/finish`, override ? { ...body, override } : body),
      { success: 'Combate cerrado', onConflict: () => this.reload() },
    );
    this.finishing.set(false);
    if (!res) return;
    this.finishOpen.set(false);
    this.unlocked.set(false);
    this.setScoreboard(res.scoreboard);
    if (res.affected_matches.length) {
      await this.dialog.alert(
        'Combates siguientes afectados',
        'La corrección cambia el ganador de un combate que ya avanzó en la llave. Revisa estos combates:',
        res.affected_matches,
      );
    }
  }

  // --- Kata: banderas ---
  vote(i: number, c: Color): void {
    this.votes.update((v) => v.map((x, j) => (j === i ? (x === c ? null : c) : x)));
  }

  readonly voteCount = computed(() => {
    const v = this.votes();
    return { aka: v.filter((x) => x === 'aka').length, ao: v.filter((x) => x === 'ao').length };
  });

  async submitFlags(): Promise<void> {
    const body = {
      votes: this.votes(),
      head_judge_vote: this.headVote(),
      event_id: newId(),
      at: new Date().toISOString(),
    };
    const res = await this.mut.post<{ winner: Color | null; needs_head_judge: boolean; affected?: string[] }>(
      `/matches/${this.id()}/flags`,
      body,
    );
    if (!res) return;
    if (res.needs_head_judge) {
      this.needsHead.set(true);
      this.toast.warn('Empate de banderas: decide el juez principal.');
      return;
    }
    this.needsHead.set(false);
    this.toast.ok(`Gana ${res.winner === 'aka' ? 'AKA' : 'AO'} por banderas`);
    await this.reload();
    if (res.affected?.length) {
      await this.dialog.alert('Combates siguientes afectados', 'Revisa estos combates:', res.affected);
    }
  }

  // --- Navegación ---
  async nextMatch(): Promise<void> {
    const t = this.tatami();
    if (!t) return;
    try {
      const q = await firstValueFrom(this.api.get<TatamiQueue>(`/tatamis/${t}/queue`));
      const next =
        q.queue.find((it) => it.match.id !== this.id() && it.match.status === 'in_progress') ??
        q.queue.find((it) => it.match.id !== this.id());
      if (!next) {
        this.dialog.alert('Cola vacía', 'No hay más combates en la cola de este tatami.');
        return;
      }
      this.router.navigate(['/mesa', next.match.id], { queryParams: { tatami: t } });
    } catch (e) {
      this.toast.error(ApiError.from(e).fullMessage);
    }
  }

  backLink(): unknown[] {
    const c = this.category();
    if (this.tatami() && c) return ['/torneos', c.tournament_id, 'tatamis'];
    if (c) return ['/categorias', c.id, 'llave'];
    return ['/torneos'];
  }

  // --- Presentación ---
  name(color: Color): string {
    return this.sb()?.[color]?.name ?? '—';
  }

  dojo(color: Color): string {
    return this.sb()?.[color]?.dojo_name ?? '';
  }

  sanctionText(color: Color): string {
    const s = this.sb();
    if (!s) return '';
    const lvl = s.sanction[color];
    return lvl ? s.sanction_labels[lvl - 1] ?? `Nivel ${lvl}` : '';
  }

  describe(
    e: { type: string; color?: string | null; value?: number | null; method?: string | null; target_id?: string | null; reason?: string | null },
    sb: Scoreboard,
  ): string {
    const who = e.color ? e.color.toUpperCase() + ' · ' : '';
    switch (e.type) {
      case 'point':
        return `${who}${POINT_LABEL[Number(e.value)] ?? 'Punto'} +${e.value}`;
      case 'sanction':
        return `${who}${sb.sanction_labels[Number(e.value) - 1] ?? 'Sanción ' + e.value}`;
      case 'time_adjust': {
        // value suma al tiempo transcurrido; se muestra como cambio del tiempo restante.
        const r = -Number(e.value ?? 0);
        return `Ajuste de tiempo: ${r > 0 ? '+' : ''}${r} s al restante`;
      }
      case 'annul': {
        const t = sb.events.find((x) => x.id === e.target_id) ?? this.pending().find((p) => p.body.id === e.target_id)?.body;
        return `Deshacer: ${t ? this.describe(t, sb) : 'evento'}`;
      }
      case 'finish':
        return `${who}Gana por ${METHOD_LABEL[e.method ?? ''] ?? e.method ?? ''}${e.reason ? ' — ' + e.reason : ''}`;
      default:
        return `${who}${EVENT_LABEL[e.type] ?? e.type}`;
    }
  }

  trackEvent(_: number, e: MatchEvent): string {
    return e.id;
  }
}
