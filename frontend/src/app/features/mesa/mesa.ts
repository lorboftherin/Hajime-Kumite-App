import { Component, DestroyRef, HostListener, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiError } from '../../core/api-error';
import { ApiService } from '../../core/api.service';
import { DialogService } from '../../core/dialog.service';
import { EVENT_LABEL, MATCH_STATUS, METHOD_LABEL, POINT_LABEL, fmtTime, mmss, newId } from '../../core/format';
import {
  Category,
  Color,
  EventIn,
  FinishOut,
  MatchEvent,
  PresenceOut,
  Scoreboard,
  Suggestion,
  SuggestedJudges,
  TatamiQueue,
  Tournament,
} from '../../core/models';
import { MutationService } from '../../core/mutation.service';
import { ToastService } from '../../core/toast.service';
import { LabelPipe } from '../../shared/pipes';
import { Pending, SeqGuard, foldClock, loadPending, retryDecision, retryDelay, savePending } from './mesa-logic';
import { TeamMatchPanel } from './team-match';

interface LogRow {
  id: string;
  type: string;
  color: string | null;
  text: string;
  time: string;
  annulled: boolean;
  pending: boolean;
}

const PRESENCE_MS = 15000;

/** Identificador estable de esta tablet (para avisar si otra abre el mismo combate). */
function deviceId(): string {
  try {
    let id = localStorage.getItem('hajime.device');
    if (!id) {
      id = newId();
      localStorage.setItem('hajime.device', id);
    }
    return id;
  } catch {
    return newId();
  }
}

const METHODS = ['points', 'point_gap', 'senshu', 'hantei', 'golden_point', 'hansoku', 'kiken', 'shikkaku', 'walkover', 'decision'];
const UNDO_SKIP = new Set(['annul', 'finish']);

/**
 * Mesa de kumite. Cada acción es un evento inmutable con UUID del cliente y hora del dispositivo.
 * El POST es idempotente: ante un error de red se reintenta con el MISMO id (cola con backoff).
 * La cola se guarda en localStorage por combate (hajime.mesa.pending.<id>) y se restaura al volver.
 */
@Component({
  selector: 'app-mesa',
  imports: [FormsModule, RouterLink, LabelPipe, TeamMatchPanel],
  templateUrl: './mesa.html',
  styleUrls: ['./mesa.scss', './mesa-stage.scss', './mesa-center.scss', './mesa-kata.scss', './mesa-sheet.scss'],
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
  readonly matchStatus = MATCH_STATUS;
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

  /** Secuencia de peticiones: una respuesta vieja nunca pisa una más nueva ya aplicada. */
  private readonly seq = new SeqGuard();

  // Cola de eventos pendientes (en memoria + localStorage).
  readonly pending = signal<Pending[]>([]);
  readonly offline = signal(false);
  /** Evento que agotó sus reintentos (5xx): bloquea la cola hasta que el operador decida. */
  readonly stuck = signal<Pending | null>(null);
  /** 401: la cola se conserva y se reanuda tras volver a iniciar sesión. */
  readonly authBlocked = signal(false);
  readonly sending = signal(false);
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private readonly savedKeys = new Set<number>();

  readonly unlocked = signal(false);
  readonly finishOpen = signal(false);
  finishForm = { winner: null as Color | 'draw' | null, method: 'points', reason: '', time_over: true };
  private finishId = '';
  readonly finishing = signal(false);

  /** Menú «Más» abierto (acciones raras) por lado. Solo presentación. */
  readonly moreOpen = signal<Color | null>(null);
  /** Tatami de origen (número y número de combate en la cola), solo para el encabezado. */
  readonly tatamiInfo = signal<{ number: number; name: string; matchNumber: string | null } | null>(null);

  // Kata por banderas
  readonly votes = signal<Array<Color | null>>([]);
  readonly headVote = signal<Color | null>(null);
  readonly needsHead = signal(false);
  readonly flagsBusy = signal(false);
  /** id del evento de banderas: uno por apertura del panel (idempotente ante reintentos). */
  private flagsId = newId();

  readonly isKata = computed(() => this.category()?.modality === 'kata');

  /** Otras tablets con este mismo combate abierto (aviso; no bloquea). */
  readonly others = signal<PresenceOut['others']>([]);
  private readonly device = deviceId();
  readonly othersText = computed(() => {
    const o = this.others();
    if (!o.length) return '';
    const names = [...new Set(o.map((x) => (x.same_user ? 'tu mismo usuario' : x.user)))].join(', ');
    return `Este combate también está abierto en otra tablet (${names}). Registren desde una sola para no duplicar puntos.`;
  });

  /** Kata: qué juez dio cada bandera (opcional, sección 20). */
  readonly judgeOptions = signal<SuggestedJudges | null>(null);
  readonly judgeIds = signal<Array<number | null>>([]);
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

  readonly pendingHere = computed(() => this.pending().filter((p) => p.matchId === this.id()));

  /** Cronómetro: estado del servidor + eventos aún pendientes, con las mismas reglas que el servidor. */
  readonly clock = computed(() =>
    foldClock(
      this.anchor(),
      this.pendingHere().map((p) => p.body),
      this.now(),
      this.sb()?.rules ?? null,
    ),
  );
  readonly duration = computed(() => this.sb()?.duration_seconds ?? 0);
  readonly remaining = computed(() => Math.max(0, this.duration() - this.clock().elapsed));
  readonly timeOver = computed(() => this.duration() > 0 && this.clock().elapsed >= this.duration());
  readonly timerText = computed(() => mmss(Math.ceil(this.remaining())));
  readonly started = computed(() => !!this.sb()?.started || this.pendingHere().some((p) => p.body.type === 'start'));

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

  /** Texto del evento bloqueado para el aviso. */
  readonly stuckText = computed(() => {
    const p = this.stuck();
    const sb = this.sb();
    if (!p) return '';
    return sb ? this.describe(p.body, sb) : (EVENT_LABEL[p.body.type] ?? p.body.type);
  });

  /** Estado visual del reloj. */
  readonly clockState = computed<'over' | 'running' | 'paused' | 'idle'>(() => {
    if (this.timeOver()) return 'over';
    if (this.clock().running) return 'running';
    return this.started() ? 'paused' : 'idle';
  });
  readonly clockLabel = computed(() => {
    switch (this.clockState()) {
      case 'over':
        return '¡Tiempo!';
      case 'running':
        return 'En juego';
      case 'paused':
        return 'Yame';
      default:
        return 'Sin iniciar';
    }
  });
  readonly durationText = computed(() => mmss(this.duration()));
  readonly clockWarn = computed(() => !this.timeOver() && this.remaining() <= 15 && this.clock().running);

  /** Tono del aviso del servidor: ganador sugerido (matcha) o decisión necesaria (yamabuki). */
  readonly suggestionTone = computed(() => {
    const s = this.sb()?.suggestion;
    if (!s) return '';
    return s.winner ? 'win' : s.needs ? 'needs' : 'info';
  });

  /** Qué deshará «Deshacer último». */
  readonly undoText = computed(() => {
    const t = this.undoTarget();
    const sb = this.sb();
    return t && sb ? this.describe(t, sb) : '';
  });

  readonly majority = computed(() => Math.floor(this.judges() / 2) + 1);

  /** Vista previa de banderas con la misma regla del servidor (mayoría del panel). */
  readonly kataPreview = computed(() => {
    const n = this.judges();
    const { aka, ao } = this.voteCount();
    const missing = this.votes().filter((v) => !v).length;
    const majority = this.majority();
    if (aka >= majority) return { tone: 'aka', text: `Gana AKA · ${aka} de ${n} banderas` };
    if (ao >= majority) return { tone: 'ao', text: `Gana AO · ${ao} de ${n} banderas` };
    if (missing) return { tone: 'wait', text: `Faltan ${missing} voto(s) · sin mayoría todavía` };
    return { tone: 'tie', text: 'Sin mayoría: decide el juez principal' };
  });

  constructor() {
    const tick = setInterval(() => this.now.set(Date.now()), 200);
    const presence = setInterval(() => this.heartbeat(), PRESENCE_MS);
    const refresh = setInterval(() => {
      // No se refresca mientras hay envíos en curso o pendientes: un GET lento no debe pisar un POST.
      if (!this.pending().length && !this.sending() && !this.finishOpen()) this.reload(true);
    }, 15000);
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      clearInterval(tick);
      clearInterval(refresh);
      clearInterval(presence);
      this.leave(this.id());
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;
    });
    // Persistencia de la cola por combate.
    effect(() => savePending(this.pending(), this.savedKeys));
    effect(() => {
      const id = this.id();
      untracked(() => {
        this.unlocked.set(false);
        this.needsHead.set(false);
        this.headVote.set(null);
        this.flagsId = newId();
        this.moreOpen.set(null);
        this.restorePending(id);
        this.load(id);
        this.others.set([]);
        this.heartbeat(id);
      });
    });
    effect(() => {
      const t = this.tatami();
      const id = this.id();
      untracked(() => {
        this.tatamiInfo.set(null);
        if (t) this.loadTatami(t, id);
      });
    });
  }

  /** Número de tatami para el encabezado (informativo; si falla no afecta a la mesa). */
  private async loadTatami(t: string, matchId: number): Promise<void> {
    try {
      const q = await firstValueFrom(this.api.get<TatamiQueue>(`/tatamis/${t}/queue`));
      if (this.destroyed) return;
      const item = [q.current, ...q.queue].find((it) => it?.match.id === matchId) ?? null;
      this.tatamiInfo.set({ number: q.tatami.number, name: q.tatami.name, matchNumber: item?.number ?? null });
    } catch {
      /* solo informativo */
    }
  }

  /** Aviso del navegador al cerrar/recargar con eventos sin enviar (la cola igual queda guardada). */
  @HostListener('window:beforeunload', ['$event'])
  onBeforeUnload(ev: BeforeUnloadEvent): string | undefined {
    const n = this.pending().length;
    if (!n) return undefined;
    ev.preventDefault();
    const msg = `Hay ${n} evento(s) sin enviar`;
    ev.returnValue = msg;
    return msg;
  }

  /** Escape cierra el menú «Más» o la hoja de cierre (si no hay un diálogo encima). */
  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.dialog.stack().length) return;
    if (this.moreOpen()) this.moreOpen.set(null);
    else if (this.finishOpen() && !this.finishing()) this.finishOpen.set(false);
  }

  /** Un toque fuera del menú «Más» lo cierra. */
  @HostListener('document:pointerdown', ['$event'])
  onDocPointer(ev: PointerEvent): void {
    if (!this.moreOpen()) return;
    const t = ev.target as HTMLElement | null;
    if (!t?.closest?.('.more')) this.moreOpen.set(null);
  }

  toggleMore(c: Color): void {
    this.moreOpen.update((v) => (v === c ? null : c));
  }

  rare(type: 'senshu_cancel' | 'kiken' | 'shikkaku' | 'walkover' | 'hantei', c: Color): void {
    this.moreOpen.set(null);
    this.special(type, c);
  }

  /** Gota de tinta desde el punto tocado (solo efecto visual; CSS la desactiva con reduced-motion). */
  ink(ev: PointerEvent): void {
    const btn = ev.currentTarget as HTMLElement | null;
    if (!btn || (btn as HTMLButtonElement).disabled) return;
    const r = btn.getBoundingClientRect();
    btn.style.setProperty('--ink-x', `${ev.clientX - r.left}px`);
    btn.style.setProperty('--ink-y', `${ev.clientY - r.top}px`);
    btn.classList.remove('inked');
    void btn.offsetWidth; // reinicia la animación
    btn.classList.add('inked');
  }

  onSheetBackdrop(ev: MouseEvent): void {
    if (ev.target === ev.currentTarget && !this.finishing()) this.finishOpen.set(false);
  }

  // --- Presencia: varias tablets en el mismo combate ---
  private previousId: number | null = null;

  private async heartbeat(id = this.id()): Promise<void> {
    if (this.previousId !== null && this.previousId !== id) this.leave(this.previousId);
    this.previousId = id;
    try {
      const r = await firstValueFrom(this.api.post<PresenceOut>(`/matches/${id}/presence`, { device_id: this.device }));
      if (!this.destroyed && id === this.id()) this.others.set(r.others);
    } catch {
      /* solo informativo */
    }
  }

  private leave(id: number): void {
    this.api.delete(`/matches/${id}/presence?device_id=${encodeURIComponent(this.device)}`).subscribe({ error: () => {} });
  }

  // --- Kata: jueces (opcional) ---
  private async loadJudges(id: number): Promise<void> {
    try {
      const j = await firstValueFrom(this.api.get<SuggestedJudges>(`/matches/${id}/referees`));
      this.judgeOptions.set(j);
      // Los asignados al combate, la categoría o el tatami se proponen en orden.
      this.judgeIds.set(Array.from({ length: this.judges() }, (_, i) => j.assigned[i]?.person_id ?? null));
    } catch {
      this.judgeOptions.set(null);
    }
  }

  setJudge(i: number, pid: number | null): void {
    this.judgeIds.update((v) => v.map((x, j) => (j === i ? pid : x)));
  }

  // --- Carga ---
  async load(id: number): Promise<void> {
    this.loadError.set('');
    const seq = this.seq.next();
    try {
      const sb = await firstValueFrom(this.api.get<Scoreboard>(`/matches/${id}`));
      if (this.destroyed) return;
      this.setScoreboard(sb, seq);
      if (this.category()?.id !== sb.match.category_id) {
        const c = await firstValueFrom(this.api.get<Category>(`/categories/${sb.match.category_id}`));
        this.category.set(c);
        if (this.tournament()?.id !== c.tournament_id) {
          this.tournament.set(await firstValueFrom(this.api.get<Tournament>(`/tournaments/${c.tournament_id}`)));
        }
      }
      this.votes.set(Array.from({ length: this.judges() }, () => null));
      if (this.isKata()) this.loadJudges(id);
    } catch (e) {
      this.loadError.set(ApiError.from(e).fullMessage);
    }
  }

  async reload(silent = false): Promise<void> {
    const seq = this.seq.next();
    try {
      const sb = await firstValueFrom(this.api.get<Scoreboard>(`/matches/${this.id()}`));
      if (this.destroyed) return;
      this.setScoreboard(sb, seq);
      this.offline.set(false);
    } catch (e) {
      if (!silent) this.toast.error(ApiError.from(e).fullMessage);
    }
  }

  /** Aplica un marcador solo si es del combate actual y más fresco que el último aplicado. */
  private setScoreboard(sb: Scoreboard, seq: number): void {
    if (sb.match.id !== this.id()) return;
    if (!this.seq.accept(seq)) return;
    this.sb.set(sb);
    this.anchor.set({ elapsed: sb.elapsed_seconds, running: sb.running, at: Date.now() });
  }

  // --- Cola de eventos con reintentos ---
  private restorePending(id: number): void {
    const saved = loadPending(id);
    if (!saved.length) return;
    this.pending.update((q) => {
      const have = new Set(q.map((p) => p.body.id));
      return [...q, ...saved.filter((p) => !have.has(p.body.id))];
    });
    this.toast.show(`Se recuperaron ${saved.length} evento(s) sin enviar`);
    this.flush();
  }

  send(type: string, extra: Partial<EventIn> = {}): void {
    if (!this.sb()) return;
    const body: EventIn = { id: newId(), type, at: new Date().toISOString(), ...extra };
    this.pending.update((q) => [...q, { matchId: this.id(), body, attempts: 0 }]);
    this.flush();
  }

  private async flush(): Promise<void> {
    if (this.sending() || this.destroyed || this.stuck() || this.authBlocked()) return;
    this.sending.set(true);
    try {
      while (this.pending().length && !this.destroyed) {
        const p = this.pending()[0];
        const seq = this.seq.next();
        try {
          const sb = await firstValueFrom(this.api.post<Scoreboard>(`/matches/${p.matchId}/events`, p.body));
          if (this.destroyed) return;
          this.pending.update((q) => q.filter((x) => x !== p));
          this.offline.set(false);
          if (p.matchId === this.id()) {
            this.setScoreboard(sb, seq);
            if (p.body.type === 'annul') {
              const t = sb.events.find((x) => x.id === p.body.target_id);
              this.toast.show(`Deshecho: ${t ? this.describe(t, sb) : 'evento'}`);
            }
            // Si la pantalla se abrió sin conexión, completa la carga (categoría, torneo).
            if (this.loadError() || !this.category()) this.load(this.id());
          }
        } catch (e) {
          if (this.destroyed) return;
          const err = ApiError.from(e);
          if (err.status === 409 && err.code === 'WARNINGS') {
            // Combate cerrado (MATCH_FINISHED) u otra advertencia: se pide motivo y se reenvía el MISMO evento.
            const reason = await this.dialog.warnings(err.warnings, err.message);
            if (this.destroyed) return;
            if (reason === null) {
              this.pending.update((q) => q.filter((x) => x !== p));
              this.toast.show(`${EVENT_LABEL[p.body.type] ?? p.body.type}: cancelado`);
              continue;
            }
            p.body.override = { reason };
            this.pending.update((q) => [...q]); // persiste el motivo
            continue;
          }
          p.attempts++;
          const decision = retryDecision(err, p.attempts);
          if (decision === 'retry') {
            // Se reintenta el MISMO evento (mismo id) con backoff.
            this.offline.set(true);
            this.retryTimer = setTimeout(() => {
              this.retryTimer = null;
              this.flush();
            }, retryDelay(p.attempts));
            return;
          }
          if (decision === 'stuck') {
            this.offline.set(true);
            this.stuck.set(p);
            this.toast.error(`${EVENT_LABEL[p.body.type] ?? p.body.type}: el servidor falla (${err.fullMessage}). La cola queda detenida.`);
            return;
          }
          if (decision === 'auth') {
            // Sesión vencida: la cola queda guardada y se reanuda tras volver a ingresar.
            this.authBlocked.set(true);
            return;
          }
          // Rechazo de negocio: se descarta ese evento y se informa.
          this.pending.update((q) => q.filter((x) => x !== p));
          this.toast.error(`${EVENT_LABEL[p.body.type] ?? p.body.type}: ${err.fullMessage}`);
          if (p.matchId === this.id()) this.reload(true);
        }
      }
    } finally {
      this.sending.set(false);
    }
  }

  retryNow(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const s = this.stuck();
    if (s) {
      s.attempts = 0;
      this.stuck.set(null);
    }
    this.authBlocked.set(false);
    this.flush();
  }

  /** Descarta el evento bloqueado (con confirmación) y sigue con el resto de la cola. */
  async discardStuck(): Promise<void> {
    const p = this.stuck();
    if (!p) return;
    const ok = await this.dialog.confirm({
      title: 'Descartar este evento',
      message: `Se descartará "${this.stuckText()}" y no quedará registrado en el combate. Los demás eventos pendientes se seguirán enviando.`,
      danger: true,
      confirmText: 'Descartar',
    });
    if (!ok) return;
    this.pending.update((q) => q.filter((x) => x !== p));
    this.stuck.set(null);
    // Sin pendientes no hay nada "sin conexión"; si quedan, flush lo vuelve a marcar si falla.
    if (!this.pending().length) this.offline.set(false);
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
    // El aviso "Deshecho" se muestra cuando el servidor confirma la anulación (ver flush).
    this.send('annul', { target_id: t.id });
  }

  // --- Cierre ---
  openFinish(): void {
    const s = this.sb();
    if (!s) return;
    const sug = s.suggestion;
    // Sin sugerencia del servidor no se preselecciona ganador: el operador debe elegir.
    this.finishForm = {
      winner: (this.finished() ? (s.winner ?? (s.method === 'draw' ? 'draw' : null)) : sug.winner) ?? null,
      method: (this.finished() ? s.method : sug.method) ?? (sug.needs === 'hantei' ? 'hantei' : 'points'),
      reason: '',
      time_over: this.timeOver(),
    };
    this.timeEndPick = null;
    if (this.finishForm.time_over) this.applyTimeEnd();
    this.finishId = newId();
    this.finishOpen.set(true);
  }

  /** Ganador preseleccionado por la sugerencia «si terminó el tiempo» (para poder quitarlo al desmarcar). */
  private timeEndPick: Color | null = null;

  /** Sugerencia a usar cuando el servidor no sugiere ganador pero el operador marca «Tiempo cumplido». */
  timeEndSuggestion(): Suggestion | null {
    const s = this.sb();
    if (!s || this.finished() || this.isKata() || s.suggestion.winner) return null;
    if (!this.finishForm.time_over) return null;
    return s.suggestion_at_time_end ?? null;
  }

  timeEndText(): string {
    const t = this.timeEndSuggestion();
    if (!t) return '';
    if (t.winner) return `Sugerencia (si terminó el tiempo): gana ${t.winner === 'aka' ? 'AKA' : 'AO'} por ${METHOD_LABEL[t.method ?? ''] ?? t.method}`;
    if (t.needs === 'hantei') return 'Si terminó el tiempo: empate, se necesita hantei (decisión de jueces)';
    if (t.needs === 'golden_point') return 'Si terminó el tiempo: empate, punto de oro';
    return t.reason ?? '';
  }

  onTimeOverChange(checked: boolean): void {
    this.finishForm.time_over = checked;
    if (checked) {
      this.applyTimeEnd();
    } else if (this.timeEndPick && this.finishForm.winner === this.timeEndPick) {
      // Se desmarcó: se quita lo que se había preseleccionado; el operador vuelve a elegir.
      this.finishForm.winner = null;
      this.finishForm.method = 'points';
      this.timeEndPick = null;
    }
  }

  private applyTimeEnd(): void {
    const t = this.timeEndSuggestion();
    if (!t?.winner || this.finishForm.winner) return;
    this.finishForm.winner = t.winner;
    this.finishForm.method = t.method ?? 'points';
    this.timeEndPick = t.winner;
  }

  async confirmFinish(): Promise<void> {
    if (this.pending().length) {
      this.toast.warn('Hay eventos pendientes de enviar. Espera la conexión antes de cerrar.');
      return;
    }
    const f = this.finishForm;
    if (!f.winner) {
      this.toast.warn('Elige el ganador antes de confirmar.');
      return;
    }
    const body = {
      id: this.finishId,
      at: new Date().toISOString(),
      winner: f.winner,
      method: f.method,
      reason: f.reason.trim() || null,
      time_over: f.time_over,
    };
    this.finishing.set(true);
    const seq = this.seq.next();
    const res = await this.mut.run<FinishOut>(
      (override) => this.api.post<FinishOut>(`/matches/${this.id()}/finish`, override ? { ...body, override } : body),
      { success: 'Combate cerrado', onConflict: () => this.reload() },
    );
    this.finishing.set(false);
    if (!res) return;
    this.finishOpen.set(false);
    this.unlocked.set(false);
    this.setScoreboard(res.scoreboard, seq);
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
    if (this.flagsBusy()) return;
    const ids = this.judgeIds();
    const body = {
      votes: this.votes(),
      judge_person_ids: ids.some((x) => x !== null) ? ids : null,
      head_judge_vote: this.headVote(),
      event_id: this.flagsId,
      at: new Date().toISOString(),
    };
    this.flagsBusy.set(true);
    // mut.post reenvía el MISMO cuerpo con override={reason} si el servidor responde 409 WARNINGS.
    const res = await this.mut.post<{ winner: Color | null; needs_head_judge: boolean; affected?: string[] }>(
      `/matches/${this.id()}/flags`,
      body,
    );
    this.flagsBusy.set(false);
    if (!res) return;
    if (res.needs_head_judge) {
      this.needsHead.set(true);
      this.toast.warn('Empate de banderas: decide el juez principal.');
      return;
    }
    this.needsHead.set(false);
    this.flagsId = newId(); // decisión registrada: la próxima es otro evento
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

  tatamiParams(): Record<string, string> {
    const t = this.tatami();
    return t ? { tatami: t } : {};
  }

  backLink(): unknown[] {
    const bout = this.sb()?.bout;
    if (bout) return ['/mesa', bout.parent_match_id];
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
