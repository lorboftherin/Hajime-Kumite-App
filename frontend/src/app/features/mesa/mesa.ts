import {
  Component,
  DestroyRef,
  HostListener,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiError } from '../../core/api-error';
import { ApiService } from '../../core/api.service';
import { apiBase } from '../../core/server';
import { AuthService } from '../../core/auth.service';
import { DialogService } from '../../core/dialog.service';
import { homePath, isStaff } from '../../core/roles';
import { SessionExpiredService } from '../../core/session-expired.service';
import {
  EVENT_LABEL,
  MATCH_STATUS,
  METHOD_LABEL,
  POINT_LABEL,
  fmtTime,
  mmss,
  newId,
} from '../../core/format';
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
import { FocusTrap } from '../../shared/focus-trap';
import { LabelPipe } from '../../shared/pipes';
import { joinList } from '../../shared/plural';
import {
  CLOCK_EVENTS,
  FinishData,
  Pending,
  SeqGuard,
  TimerCue,
  TimerCues,
  enqueueFinish,
  foldClock,
  isFinish,
  loadPending,
  methodsFor,
  pendingPath,
  pendingPayload,
  retryDecision,
  retryDelay,
  sanctionAbbr,
  savePending,
  scoreWithPending,
  timeUpAt,
} from './mesa-logic';
import { KataMatchScores } from './kata-match-scores';
import { HanteiSheet, InfractionSheet } from './rules-sheets';
import { Beeper, MESA_PREFS, VIBRATION, readFlag, writeFlag } from './mesa-sound';
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
/** Con la mesa en solo lectura el marcador se refresca más seguido (marcador en vivo). */
const READONLY_REFRESH_MS = 3000;

/** Identificador estable de esta tablet (la que lleva la mesa y las que solo miran). */
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

const UNDO_SKIP = new Set(['annul', 'finish']);

/**
 * Mesa de kumite. Cada acción es un evento inmutable con UUID del cliente y hora del dispositivo.
 * El POST es idempotente: ante un error de red se reintenta con el MISMO id (cola con backoff).
 * La cola se guarda en localStorage por combate (hajime.mesa.pending.<id>) y se restaura al volver.
 */
/** Vibración breve al tocar (celulares que la tienen): confirma el toque sin mirar. */
function buzz(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* sin vibración */
  }
}

@Component({
  selector: 'app-mesa',
  imports: [
    FormsModule,
    RouterLink,
    LabelPipe,
    TeamMatchPanel,
    FocusTrap,
    KataMatchScores,
    InfractionSheet,
    HanteiSheet,
  ],
  templateUrl: './mesa.html',
  styleUrls: [
    './mesa.scss',
    './mesa-stage.scss',
    './mesa-center.scss',
    './mesa-kata.scss',
    './mesa-sheet.scss',
    './mesa-alerts.scss',
    './mesa-phone.scss',
  ],
})
export class MesaPage {
  // Textos de atributos enlazados de la plantilla (mesa.html).
  readonly txtCombate = $localize`:@@mesa.combate:Combate`;
  readonly txtSancion = $localize`:@@mesa.sancion:Sanción`;
  readonly txtAvisosTiempo = $localize`:@@mesa.avisos-tiempo:Avisos de tiempo`;
  readonly txtAvisosTiempoApagado = $localize`:@@mesa.avisos-tiempo-sonido-apagado:Avisos de tiempo (sonido apagado)`;
  readonly txtSonidoApagado = $localize`:@@mesa.sonido-apagado:Sonido apagado`;
  readonly txtNadaDeshacer = $localize`:@@mesa.nada-deshacer:Nada que deshacer`;
  readonly txtCorregirResultado = $localize`:@@mesa.corregir-resultado:Corregir resultado`;
  readonly txtConfirmarGanador = $localize`:@@mesa.confirmar-ganador:Confirmar ganador`;
  ariaMasAcciones = (c: 'aka' | 'ao') =>
    $localize`:@@mesa.mas-acciones-para:Más acciones para ${c.toUpperCase()}:color:`;
  ariaPuntaje = (c: string, v: number) =>
    $localize`:@@mesa.puntaje-color:Puntaje ${c}:color:: ${v}:puntaje:`;
  ariaFaltasC2 = (c: string) =>
    $localize`:@@mesa.faltas-categoria-2:Faltas de categoría 2 de ${c.toUpperCase()}:color:`;
  ariaSanciones = (c: string) =>
    $localize`:@@mesa.sanciones-de:Sanciones de ${c.toUpperCase()}:color:`;
  tituloAplicar = (sancion: string) =>
    $localize`:@@mesa.aplicar-sancion:Aplicar ${sancion}:sancion:`;
  ariaBanderas = (c: string, v: number) =>
    $localize`:@@mesa.banderas-color:Banderas ${c}:color:: ${v}:votos:`;
  ariaBanderasJueces = (n: number) =>
    $localize`:@@mesa.banderas-jueces:Banderas de ${n}:jueces: jueces`;
  ariaQuienJuez = (n: number) => $localize`:@@mesa.quien-juez:Quién es el juez ${n}:juez:`;

  private api = inject(ApiService);
  private mut = inject(MutationService);
  private dialog = inject(DialogService);
  private toast = inject(ToastService);
  private router = inject(Router);
  private auth = inject(AuthService);
  readonly session = inject(SessionExpiredService);

  readonly matchId = input.required<string>();
  readonly tatami = input<string | undefined>(undefined);

  readonly methodLabel = METHOD_LABEL;
  readonly matchStatus = MATCH_STATUS;
  readonly sanctionAbbr = sanctionAbbr;
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
  /** Estado de la red según el navegador (eventos online/offline de window). */
  readonly online = signal(typeof navigator === 'undefined' ? true : navigator.onLine !== false);
  /** Sin señal: el navegador no tiene red o el último envío falló por red. */
  readonly noSignal = computed(() => this.offline() || !this.online());
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
  finishForm = {
    winner: null as Color | 'draw' | null,
    method: 'points',
    reason: '',
    time_over: true,
  };
  private finishId = '';
  readonly finishing = signal(false);

  /** Menú «Más» abierto (acciones raras) por lado. Solo presentación. */
  readonly moreOpen = signal<Color | null>(null);
  /** Tatami de origen (número y número de combate en la cola), solo para el encabezado. */
  readonly tatamiInfo = signal<{ number: number; name: string; matchNumber: string | null } | null>(
    null,
  );

  // Kata por banderas
  readonly votes = signal<Array<Color | null>>([]);
  readonly headVote = signal<Color | null>(null);
  readonly needsHead = signal(false);
  readonly flagsBusy = signal(false);
  /** id del evento de banderas: uno por apertura del panel (idempotente ante reintentos). */
  private flagsId = newId();

  readonly isKata = computed(() => this.category()?.modality === 'kata');
  /** Métodos de victoria de la hoja de cierre según la modalidad (kata: banderas, decisión…). */
  readonly methods = computed(() => methodsFor(this.category()?.modality));

  /** Otras tablets con este mismo combate abierto. */
  readonly others = signal<PresenceOut['others']>([]);
  private readonly device = deviceId();
  /** Cabecera que identifica a esta tablet: el servidor rechaza eventos de la que no lleva la mesa. */
  private readonly deviceOpts = { headers: { 'X-Device-Id': this.device } };
  /** Esta tablet lleva la mesa (dueña). Si otra la tomó, esta queda en solo lectura. */
  readonly primary = signal(true);
  readonly owner = signal<PresenceOut['owner']>(null);
  readonly readOnly = computed(() => !this.primary());
  readonly taking = signal(false);
  readonly ownerText = computed(() => {
    const o = this.owner();
    if (!o) return $localize`:@@mesa.otra-tablet:otra tablet`;
    return o.same_user
      ? $localize`:@@mesa.otra-tablet-usuario:otra tablet con tu usuario`
      : $localize`:@@mesa.tablet:la tablet de ${o.user}:user:`;
  });
  readonly othersText = computed(() => {
    const o = this.others();
    if (!o.length || this.readOnly()) return '';
    const names = joinList([
      ...new Set(
        o.map((x) => (x.same_user ? $localize`:@@mesa.otra-sesion-tuya:otra sesión tuya` : x.user)),
      ),
    ]);
    return $localize`:@@mesa.este-combate-tambien-esta:Este combate también está abierto en: ${names}:names:. Esta tablet lleva la mesa; la otra solo ve el marcador.`;
  });

  /** Kata: qué juez dio cada bandera (opcional, sección 20). */
  readonly judgeOptions = signal<SuggestedJudges | null>(null);
  readonly judgeIds = signal<Array<number | null>>([]);
  /** Kata: configuración efectiva (torneo → categoría, con el preset WKF), igual que el backend. */
  readonly kataCfg = computed(() => {
    const c = this.category();
    const explicit = {
      ...((this.tournament()?.kata_defaults ?? {}) as Record<string, any>),
      ...((c?.kata_rules ?? {}) as Record<string, any>),
    };
    const method = c?.kata_method ?? explicit['method'] ?? 'flags';
    let judges = Number(c?.kata_judges ?? explicit['judges'] ?? (method === 'scores' ? 5 : 3));
    let discard = explicit['discard_each_side'];
    let split = !!explicit['split'];
    if (explicit['preset'] === 'wkf') {
      if (!c?.kata_judges && explicit['judges'] === undefined) judges = 7;
      if (discard === undefined || discard === null) discard = 2;
      if (explicit['split'] === undefined) split = true;
    }
    const d =
      discard === undefined || discard === null || discard === ''
        ? judges === 3
          ? 0
          : 1
        : Number(discard);
    return { method, judges, discard: d, split };
  });
  /** Kata por puntuación en llave: la mesa registra notas en vez de banderas. */
  readonly kataScores = computed(() => this.isKata() && this.kataCfg().method === 'scores');
  readonly judges = computed(() => {
    const cfg = this.kataCfg();
    // Banderas en una categoría por puntuación (excepción con override): 3 jueces.
    return cfg.method === 'flags' ? cfg.judges : 3;
  });

  // Reglas configurables de kumite: tipo de falta, hantei con votos, shikkaku de torneo.
  readonly infractionFor = signal<{ color: Color; level: number } | null>(null);
  readonly hanteiFor = signal<Color | null | undefined>(undefined);

  readonly match = computed(() => this.sb()?.match ?? null);
  readonly finished = computed(() => this.match()?.status === 'finished');
  readonly playable = computed(() => {
    const m = this.match();
    return (
      !!m &&
      !!m.aka_registration_id &&
      !!m.ao_registration_id &&
      !['pending', 'bye', 'void'].includes(m.status)
    );
  });
  readonly pendingHere = computed(() => this.pending().filter((p) => p.matchId === this.id()));
  /** Cierre dejado en cola sin señal: el combate se cerrará al volver la conexión. */
  readonly finishQueued = computed(() => this.pendingHere().find((p) => isFinish(p)) ?? null);

  readonly locked = computed(
    () =>
      !this.playable() ||
      this.readOnly() ||
      !!this.finishQueued() ||
      (this.finished() && !this.unlocked()),
  );

  /** Cronómetro: estado del servidor + eventos aún pendientes, con las mismas reglas que el servidor. */
  readonly clock = computed(() =>
    foldClock(
      this.anchor(),
      this.pendingHere().map((p) => p.body),
      this.now(),
      this.sb()?.rules ?? null,
    ),
  );
  /** En punto de oro el periodo se alarga (period_seconds; null = sin límite). */
  readonly duration = computed(() => {
    const s = this.sb();
    if (!s) return 0;
    return s.golden_point ? (s.period_seconds ?? 0) : s.duration_seconds;
  });
  readonly remaining = computed(() => Math.max(0, this.duration() - this.clock().elapsed));
  readonly timeOver = computed(
    () => this.duration() > 0 && this.clock().elapsed >= this.duration(),
  );
  readonly timerText = computed(() => mmss(Math.ceil(this.remaining())));
  /** Marcador en pantalla: el del servidor más los puntos que siguen en la cola (sin señal). */
  readonly score = computed<Record<Color, number>>(() => {
    const s = this.sb();
    if (!s) return { aka: 0, ao: 0 };
    return scoreWithPending(
      s.score,
      s.events,
      s.annulled_event_ids,
      this.pendingHere().map((p) => p.body),
    );
  });
  readonly started = computed(
    () => !!this.sb()?.started || this.pendingHere().some((p) => p.body.type === 'start'),
  );

  readonly suggestionText = computed(() => {
    const s = this.sb()?.suggestion;
    if (!s) return '';
    if (s.winner)
      return $localize`:@@mesa.sugerencia-gana:Sugerencia: gana ${s.winner === 'aka' ? 'AKA' : 'AO'}:color: por ${METHOD_LABEL[s.method ?? ''] ?? s.method}:metodo:`;
    if (s.needs === 'hantei')
      return $localize`:@@mesa.empate-necesita-hantei-decision:Empate: se necesita hantei (decisión de jueces)`;
    if (s.needs === 'golden_point')
      return $localize`:@@mesa.empate-punto-oro-senshu:Empate: punto de oro (senshu)`;
    return s.reason ?? '';
  });

  readonly log = computed<LogRow[]>(() => {
    const sb = this.sb();
    if (!sb) return [];
    const annulled = new Set(sb.annulled_event_ids);
    const labelOf = (e: {
      type: string;
      color?: string | null;
      value?: number | null;
      method?: string | null;
      target_id?: string | null;
      reason?: string | null;
    }): string => this.describe(e, sb);
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
        return $localize`:@@mesa.tiempo:¡Tiempo!`;
      case 'running':
        return this.sb()?.golden_point
          ? $localize`:@@mesa.punto-oro-2:Punto de oro`
          : $localize`:@@mesa.juego:En juego`;
      case 'paused':
        return 'Yame';
      default:
        return $localize`:@@mesa.sin-iniciar:Sin iniciar`;
    }
  });
  readonly durationText = computed(() => mmss(this.duration()));
  readonly clockWarn = computed(
    () => !this.timeOver() && this.remaining() <= 15 && this.clock().running,
  );

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
    if (aka >= majority)
      return {
        tone: 'aka',
        text: $localize`:@@mesa.gana-aka-banderas:Gana AKA · ${aka}:aka: de ${n}:n: banderas`,
      };
    if (ao >= majority)
      return {
        tone: 'ao',
        text: $localize`:@@mesa.gana-ao-banderas:Gana AO · ${ao}:ao: de ${n}:n: banderas`,
      };
    if (missing)
      return {
        tone: 'wait',
        text:
          missing === 1
            ? $localize`:@@mesa.falta-1-voto:Falta 1 voto · sin mayoría todavía`
            : $localize`:@@mesa.faltan-votos:Faltan ${missing}:faltan: votos · sin mayoría todavía`,
      };
    return {
      tone: 'tie',
      text: $localize`:@@mesa.sin-mayoria-decide-juez:Sin mayoría: decide el juez principal`,
    };
  });

  constructor() {
    const tick = setInterval(() => this.now.set(Date.now()), 200);
    const presence = setInterval(() => this.heartbeat(), PRESENCE_MS);
    let ticks = 0;
    const refresh = setInterval(() => {
      // En solo lectura el marcador se sigue en vivo (cada 3 s); si no, cada 15 s.
      ticks++;
      if (!this.readOnly() && ticks % 5 !== 0) return;
      // No se refresca mientras hay envíos en curso o pendientes: un GET lento no debe pisar un POST.
      if (!this.pending().length && !this.sending() && !this.finishOpen()) this.reload(true);
    }, READONLY_REFRESH_MS);
    this.keepAwake();
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
    // Políticas de audio del navegador: el sonido se desbloquea con el primer toque en la mesa.
    document.addEventListener('pointerdown', this.unlockAudio, { capture: true });
    document.addEventListener('keydown', this.unlockAudio, { capture: true });
    // La mesa se encarga del reingreso si vence la sesión (no se sale a /login a mitad de combate).
    const releaseSession = this.session.hold();
    const u = this.auth.user();
    if (u) this.reloginUser.set(u.username);
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      document.removeEventListener('visibilitychange', this.onVisibility);
      window.removeEventListener('online', this.onOnline);
      window.removeEventListener('offline', this.onOffline);
      document.removeEventListener('pointerdown', this.unlockAudio, { capture: true });
      document.removeEventListener('keydown', this.unlockAudio, { capture: true });
      releaseSession();
      this.beeper.close();
      this.wakeLock?.release().catch(() => {});
      clearInterval(tick);
      clearInterval(refresh);
      clearInterval(presence);
      if (this.flashTimer) clearTimeout(this.flashTimer);
      this.leave(this.id());
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;
    });
    // Avisos de tiempo: 15 s (atoshi baraku) y fin (0:00), con sonido, vibración y parpadeo.
    effect(() => {
      const r = this.remaining();
      const running = this.clock().running;
      const d = this.duration();
      const active = !this.isKata() && this.playable() && !this.finished() && !!this.sb();
      untracked(() => {
        if (!active) {
          this.cues.reset();
          return;
        }
        const cue = this.cues.update(r, running, d);
        if (cue) this.onCue(cue);
      });
    });
    // Persistencia de la cola por combate.
    effect(() => savePending(this.pending(), this.savedKeys));
    effect(() => {
      const id = this.id();
      untracked(() => {
        this.cues.reset();
        this.flash.set(null);
        this.primary.set(true);
        this.owner.set(null);
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
      const t = this.tatamiId();
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
      this.tatamiInfo.set({
        number: q.tatami.number,
        name: q.tatami.name,
        matchNumber: item?.number ?? null,
      });
    } catch {
      /* solo informativo */
    }
  }

  // --- Avisos de tiempo (sonido, vibración, parpadeo) y yame automático ---
  private readonly beeper = new Beeper();
  private readonly cues = new TimerCues();
  /** Parpadeo del reloj tras un aviso. */
  readonly flash = signal<TimerCue | null>(null);
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  /** Preferencias guardadas en este dispositivo. */
  readonly muted = signal(readFlag(MESA_PREFS.mute));
  readonly autoYame = signal(readFlag(MESA_PREFS.autoYame));
  readonly optsOpen = signal(false);

  private readonly unlockAudio = () => this.beeper.unlock();

  private onCue(cue: TimerCue): void {
    if (!this.muted()) this.beeper.play(cue);
    buzz(VIBRATION[cue]);
    this.flash.set(cue);
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.flash.set(null), cue === 'end' ? 6000 : 2400);
    // Yame automático: solo la tablet que lleva la mesa detiene el reloj, con la hora exacta del fin.
    if (cue === 'end' && this.autoYame() && this.clock().running && !this.locked()) {
      const at = timeUpAt(Date.now(), this.clock().elapsed, this.duration());
      this.send('pause', { at: new Date(at).toISOString() });
    }
  }

  toggleMute(): void {
    this.muted.update((v) => !v);
    writeFlag(MESA_PREFS.mute, this.muted());
    if (!this.muted()) this.testSound();
  }

  toggleAutoYame(): void {
    this.autoYame.update((v) => !v);
    writeFlag(MESA_PREFS.autoYame, this.autoYame());
  }

  testSound(): void {
    this.beeper.unlock();
    this.beeper.play('warn');
  }

  /** Aviso del navegador al cerrar/recargar con eventos sin enviar (la cola igual queda guardada). */
  @HostListener('window:beforeunload', ['$event'])
  onBeforeUnload(ev: BeforeUnloadEvent): string | undefined {
    const n = this.pending().length;
    if (!n) return undefined;
    ev.preventDefault();
    const msg =
      n === 1
        ? $localize`:@@mesa.hay-1-evento-sin-enviar:Hay 1 evento sin enviar`
        : $localize`:@@mesa.hay-eventos-sin-enviar:Hay ${n}:n: eventos sin enviar`;
    ev.returnValue = msg;
    return msg;
  }

  /** Al cerrar la pestaña o la app, se avisa que esta tablet dejó el combate (keepalive). */
  @HostListener('window:pagehide')
  onPageHide(): void {
    const token = this.auth.token();
    try {
      fetch(
        `${apiBase()}/matches/${this.id()}/presence?device_id=${encodeURIComponent(this.device)}`,
        {
          method: 'DELETE',
          keepalive: true,
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        },
      );
    } catch {
      /* el latido caduca solo */
    }
  }

  /** Escape cierra el menú «Más» o la hoja de cierre (si no hay un diálogo encima). */
  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.dialog.stack().length) return;
    if (this.moreOpen()) this.closeMore(true);
    else if (this.optsOpen()) this.optsOpen.set(false);
    else if (this.finishOpen() && !this.finishing()) this.finishOpen.set(false);
  }

  /** Un toque fuera del menú «Más» (o de las opciones de aviso) lo cierra. */
  @HostListener('document:pointerdown', ['$event'])
  onDocPointer(ev: PointerEvent): void {
    const t = ev.target as HTMLElement | null;
    if (this.moreOpen() && !t?.closest?.('.more')) this.moreOpen.set(null);
    if (this.optsOpen() && !t?.closest?.('.opts')) this.optsOpen.set(false);
  }

  toggleMore(c: Color): void {
    this.moreOpen.update((v) => (v === c ? null : c));
    // Con el menú abierto, el foco pasa al primer ítem (se recorre con las flechas).
    if (this.moreOpen()) setTimeout(() => this.moreItems()[0]?.focus());
  }

  private moreItems(): HTMLElement[] {
    const menu = document.querySelector<HTMLElement>('app-mesa .more-menu');
    return menu
      ? Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'))
      : [];
  }

  private closeMore(returnFocus = false): void {
    const c = this.moreOpen();
    this.moreOpen.set(null);
    if (returnFocus && c) {
      document.querySelector<HTMLElement>(`app-mesa .side.${c} .more-btn`)?.focus();
    }
  }

  /** Flechas, Inicio y Fin recorren el menú «Más»; Tab lo cierra. */
  onMoreKey(ev: KeyboardEvent): void {
    const items = this.moreItems();
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (ev.key === 'ArrowDown') next = (i + 1) % items.length;
    else if (ev.key === 'ArrowUp') next = (i - 1 + items.length) % items.length;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = items.length - 1;
    else if (ev.key === 'Tab') {
      this.moreOpen.set(null);
      return;
    }
    if (next < 0) return;
    ev.preventDefault();
    items[next].focus();
  }

  rare(type: 'senshu_cancel' | 'kiken' | 'shikkaku' | 'walkover' | 'hantei', c: Color): void {
    this.moreOpen.set(null);
    if (type === 'hantei') {
      this.hanteiFor.set(c); // ganador y, opcionalmente, el voto de cada juez
      return;
    }
    this.special(type, c);
  }

  onHantei(h: { color: Color; votes: Array<Color | null> | null }): void {
    this.hanteiFor.set(undefined);
    this.send('hantei', { color: h.color, votes: h.votes });
  }

  onInfraction(p: { infraction: string; ladder: 'c1' | 'c2' }): void {
    const f = this.infractionFor();
    this.infractionFor.set(null);
    if (!f) return;
    buzz([12, 40, 12]);
    this.send('sanction', {
      color: f.color,
      value: f.level,
      infraction: p.infraction,
      ladder: p.ladder,
    });
  }

  /** Punto de oro: empieza el periodo extra; el primer punto sugiere el cierre. */
  async startGoldenPoint(): Promise<void> {
    const s = this.sb();
    const secs = s?.rules?.golden_point_seconds;
    const ok = await this.dialog.confirm({
      title: $localize`:@@mesa.punto-oro-2:Punto de oro`,
      message: secs
        ? $localize`:@@mesa.periodo-extra-segundos:Empieza el periodo extra de ${secs}:segundos: s: gana el primero que marque.`
        : $localize`:@@mesa.periodo-extra-sin-limite:Empieza el periodo extra sin límite de tiempo: gana el primero que marque.`,
      confirmText: $localize`:@@mesa.iniciar-punto-oro-2:Iniciar punto de oro`,
    });
    if (ok) this.send('golden_point');
  }

  /** Shikkaku con alcance de torneo (si el torneo lo propone): retira sus demás inscripciones. */
  private async offerDisqualify(color: Color): Promise<void> {
    const t = this.tournament();
    const c = this.category();
    const rules = {
      ...((t?.competition_rules ?? {}) as Record<string, any>),
      ...((c?.competition_rules ?? {}) as Record<string, any>),
    };
    const rid =
      color === 'aka' ? this.sb()?.match.aka_registration_id : this.sb()?.match.ao_registration_id;
    if (!rules['shikkaku_tournament_wide'] || !rid) return;
    const ok = await this.dialog.confirm({
      title: $localize`:@@mesa.descalificar-torneo:Descalificar del torneo`,
      message: $localize`:@@mesa.descalificar-tambien-torneo:${this.name(color)}:name:: ¿descalificar también del torneo completo? Se retiran sus demás inscripciones (bye o walkover en cada llave).`,
      confirmText: $localize`:@@mesa.descalificar-torneo:Descalificar del torneo`,
      danger: true,
    });
    if (!ok) return;
    const res = await this.mut.post(`/registrations/${rid}/disqualify`, {
      reason: $localize`:@@mesa.shikkaku-mesa:Shikkaku en la mesa`,
    });
    if (res) this.toast.show($localize`:@@mesa.descalificado-torneo:Descalificado del torneo`);
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
      const r = await firstValueFrom(
        this.api.post<PresenceOut>(`/matches/${id}/presence`, { device_id: this.device }),
      );
      if (this.destroyed || id !== this.id()) return;
      this.others.set(r.others);
      this.applyPresence(r);
    } catch {
      /* sin señal: se sigue como estaba */
    }
  }

  /** El servidor dice quién lleva la mesa (un servidor anterior no lo informa: se asume esta). */
  private applyPresence(r: PresenceOut): void {
    if (r.primary === undefined) return;
    const was = this.primary();
    this.primary.set(r.primary);
    this.owner.set(r.primary ? null : (r.owner ?? null));
    if (!was && r.primary) {
      this.toast.show(
        $localize`:@@mesa.esta-tablet-vuelve-llevar-mesa:Esta tablet vuelve a llevar la mesa`,
      );
      this.flush();
    }
  }

  /** Otra tablet lleva la mesa: esta pasa a solo lectura; la cola se conserva. */
  private toReadOnly(): void {
    if (this.primary())
      this.toast.warn(
        $localize`:@@mesa.otra-tablet-tomo-mesa-esta-queda:Otra tablet tomó la mesa: esta queda en solo lectura.`,
      );
    this.primary.set(false);
    this.moreOpen.set(null);
    this.heartbeat();
  }

  /** «Tomar la mesa»: esta tablet pasa a registrar; la otra queda en solo lectura. */
  async takeTable(): Promise<void> {
    if (this.taking()) return;
    const ok = await this.dialog.confirm({
      title: $localize`:@@mesa.tomar-mesa-2:Tomar la mesa`,
      message: $localize`:@@mesa.esta-tablet-pasara-registrar:Esta tablet pasará a registrar el combate y ${this.ownerText()}:ownerText: quedará en solo lectura. Háganlo solo si la otra tablet ya no se usa.`,
      confirmText: $localize`:@@mesa.tomar-mesa-2:Tomar la mesa`,
    });
    if (!ok) return;
    this.taking.set(true);
    try {
      const r = await firstValueFrom(
        this.api.post<PresenceOut>(`/matches/${this.id()}/presence/take`, {
          device_id: this.device,
        }),
      );
      this.others.set(r.others);
      this.primary.set(true);
      this.owner.set(null);
      this.toast.ok($localize`:@@mesa.esta-tablet-lleva-mesa:Esta tablet lleva la mesa`);
      await this.reload(true);
      this.flush();
    } catch (e) {
      this.toast.error(ApiError.from(e).fullMessage);
    } finally {
      this.taking.set(false);
    }
  }

  private leave(id: number): void {
    this.api
      .delete(`/matches/${id}/presence?device_id=${encodeURIComponent(this.device)}`)
      .subscribe({ error: () => {} });
  }

  // --- Kata: jueces (opcional) ---
  private async loadJudges(id: number): Promise<void> {
    try {
      const j = await firstValueFrom(this.api.get<SuggestedJudges>(`/matches/${id}/referees`));
      this.judgeOptions.set(j);
      // Los asignados al combate, la categoría o el tatami se proponen en orden.
      this.judgeIds.set(
        Array.from({ length: this.judges() }, (_, i) => j.assigned[i]?.person_id ?? null),
      );
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
        const c = await firstValueFrom(
          this.api.get<Category>(`/categories/${sb.match.category_id}`),
        );
        this.category.set(c);
        if (this.tournament()?.id !== c.tournament_id) {
          this.tournament.set(
            await firstValueFrom(this.api.get<Tournament>(`/tournaments/${c.tournament_id}`)),
          );
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
    this.toast.show(
      saved.length === 1
        ? $localize`:@@mesa.recupero-1-evento-sin-enviar:Se recuperó 1 evento sin enviar`
        : $localize`:@@mesa.recuperaron-sin-enviar:Se recuperaron ${saved.length}:n: eventos sin enviar`,
    );
    this.flush();
  }

  send(type: string, extra: Partial<EventIn> = {}): void {
    if (!this.sb() || this.readOnly()) return;
    const body: EventIn = { id: newId(), type, at: new Date().toISOString(), ...extra };
    this.pending.update((q) => [...q, { matchId: this.id(), body, attempts: 0 }]);
    this.flush();
  }

  private async flush(): Promise<void> {
    if (
      this.sending() ||
      this.destroyed ||
      this.stuck() ||
      this.authBlocked() ||
      this.session.expired() ||
      this.readOnly()
    )
      return;
    this.sending.set(true);
    try {
      while (this.pending().length && !this.destroyed) {
        const p = this.pending()[0];
        const seq = this.seq.next();
        try {
          // Eventos y cierre van con el MISMO id en cada reintento: el servidor no duplica.
          const res = await firstValueFrom(
            this.api.post<Scoreboard | FinishOut>(
              pendingPath(p),
              pendingPayload(p),
              undefined,
              this.deviceOpts,
            ),
          );
          if (this.destroyed) return;
          const finish = isFinish(p);
          const sb = finish ? (res as FinishOut).scoreboard : (res as Scoreboard);
          this.pending.update((q) => q.filter((x) => x !== p));
          this.offline.set(false);
          if (finish)
            this.toast.ok(
              $localize`:@@mesa.combate-cerrado-cierre-cola:Combate cerrado: el cierre en cola se envió`,
            );
          if (p.matchId === this.id()) {
            this.setScoreboard(sb, seq);
            if (finish) this.unlocked.set(false);
            if (p.body.type === 'annul') {
              const t = sb.events.find((x) => x.id === p.body.target_id);
              this.toast.show(
                t
                  ? $localize`:@@mesa.deshecho:Deshecho: ${this.describe(t, sb)}:evento:`
                  : $localize`:@@mesa.deshecho-evento:Deshecho: evento`,
              );
            }
            // Si la pantalla se abrió sin conexión, completa la carga (categoría, torneo).
            if (this.loadError() || !this.category()) this.load(this.id());
          }
          const affected = finish ? (res as FinishOut).affected_matches : [];
          if (affected?.length) {
            await this.dialog.alert(
              $localize`:@@mesa.combates-siguientes-afectados:Combates siguientes afectados`,
              $localize`:@@mesa.correccion-cambia-ganador:La corrección cambia el ganador de un combate que ya avanzó en la llave. Revisa estos combates:`,
              affected,
            );
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
              this.toast.show(
                $localize`:@@mesa.cancelado:${EVENT_LABEL[p.body.type] ?? p.body.type}:evento:: cancelado`,
              );
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
            this.toast.error(
              $localize`:@@mesa.servidor-falla-cola-queda:${EVENT_LABEL[p.body.type] ?? p.body.type}:evento:: el servidor falla (${err.fullMessage}:error:). La cola queda detenida.`,
            );
            return;
          }
          if (decision === 'auth') {
            // Sesión vencida: la cola queda guardada y se reanuda tras volver a ingresar.
            this.authBlocked.set(true);
            return;
          }
          if (decision === 'device') {
            // Otra tablet lleva la mesa: la cola se conserva hasta «Tomar la mesa».
            p.attempts = 0;
            this.toReadOnly();
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

  // --- Red: al volver la señal se reintenta al instante ---
  private readonly onOnline = () => {
    this.online.set(true);
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.heartbeat();
    if (this.pending().length) this.flush();
    else this.reload(true);
  };
  private readonly onOffline = () => this.online.set(false);

  // --- Sesión vencida: panel de ingreso dentro de la mesa ---
  readonly reloginUser = signal('');
  readonly reloginPass = signal('');
  readonly reloginBusy = signal(false);
  readonly reloginError = signal('');
  /** Hay que volver a ingresar: la cola se conserva y se reanuda al hacerlo. */
  readonly needsLogin = computed(() => this.authBlocked() || this.session.expired());

  async relogin(): Promise<void> {
    if (this.reloginBusy()) return;
    this.reloginBusy.set(true);
    this.reloginError.set('');
    try {
      await this.auth.login(this.reloginUser().trim(), this.reloginPass());
      this.reloginPass.set('');
      this.session.resolved();
      this.authBlocked.set(false);
      this.toast.ok(
        $localize`:@@mesa.sesion-iniciada-reanuda-envio:Sesión iniciada: se reanuda el envío`,
      );
      this.heartbeat();
      if (this.pending().length) this.retryNow();
      else this.reload(true);
    } catch (e) {
      this.reloginError.set(ApiError.from(e).fullMessage);
    } finally {
      this.reloginBusy.set(false);
    }
  }

  /** Descarta el evento bloqueado (con confirmación) y sigue con el resto de la cola. */
  async discardStuck(): Promise<void> {
    const p = this.stuck();
    if (!p) return;
    const clockNote = CLOCK_EVENTS.has(p.body.type)
      ? $localize`:@@mesa.atencion-evento-reloj: Atención: es un evento del reloj; al descartarlo, el tiempo de esta tablet y el del servidor dejarán de coincidir. Revisa el reloj y corrígelo con los ajustes de ±1 s y ±10 s.`
      : '';
    const ok = await this.dialog.confirm({
      title: $localize`:@@mesa.descartar-este-evento-2:Descartar este evento`,
      message: $localize`:@@mesa.descartara-no-quedara-registrado:Se descartará "${this.stuckText()}:stuckText:" y no quedará registrado en el combate. Los demás eventos pendientes se seguirán enviando.${clockNote}:clockNote:`,
      danger: true,
      confirmText: $localize`:@@mesa.descartar:Descartar`,
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
    buzz(18);
    this.send('point', { color, value });
  }

  sanction(color: Color, level: number): void {
    const s = this.sb();
    if (s?.rules?.sanction_preset === 'two_categories' && s.infractions) {
      // Dos escaleras: el tipo de falta decide a cuál va la sanción.
      this.infractionFor.set({ color, level });
      return;
    }
    buzz([12, 40, 12]);
    this.send('sanction', { color, value: level });
  }

  hajime(): void {
    buzz(30);
    this.send(this.started() ? 'resume' : 'start');
  }

  yame(): void {
    buzz([30, 40, 30]);
    this.send('pause');
  }

  /** En el celular, la pantalla no se apaga mientras la mesa está abierta (Wake Lock). */
  private wakeLock: WakeLockSentinel | null = null;
  private readonly onVisibility = () => {
    if (document.visibilityState === 'visible') this.keepAwake();
  };
  private async keepAwake(): Promise<void> {
    try {
      if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
      this.wakeLock = await navigator.wakeLock.request('screen');
    } catch {
      /* sin permiso o sin batería suficiente: la app sigue igual */
    }
  }

  adjust(seconds: number): void {
    // time_adjust suma segundos al tiempo transcurrido: +1 s transcurrido = -1 s restante.
    this.send('time_adjust', { value: seconds });
  }

  async special(
    type: 'senshu_cancel' | 'kiken' | 'shikkaku' | 'walkover' | 'hantei',
    color: Color,
  ): Promise<void> {
    const who = color === 'aka' ? 'AKA' : 'AO';
    const text: Record<string, string> = {
      senshu_cancel: $localize`:@@mesa.cancelar-senshu:Cancelar el senshu de ${who}:who:`,
      kiken: $localize`:@@mesa.abandona-kiken:${who}:who: abandona (kiken)`,
      shikkaku: $localize`:@@mesa.descalificado-shikkaku:${who}:who: es descalificado (shikkaku)`,
      walkover: $localize`:@@mesa.no-presenta-walkover:${who}:who: no se presenta (walkover)`,
      hantei: $localize`:@@mesa.hantei-jueces-dan-victoria:Hantei: los jueces dan la victoria a ${who}:who:`,
    };
    const ok = await this.dialog.confirm({
      title: EVENT_LABEL[type],
      message: text[type] + '.',
      confirmText: $localize`:@@mesa.registrar:Registrar`,
    });
    if (ok) this.send(type, { color });
    if (ok && type === 'shikkaku') this.offerDisqualify(color);
  }

  undo(): void {
    const t = this.undoTarget();
    if (!t) {
      this.toast.show($localize`:@@mesa.no-hay-eventos-para-deshacer:No hay eventos para deshacer`);
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
      winner:
        (this.finished() ? (s.winner ?? (s.method === 'draw' ? 'draw' : null)) : sug.winner) ??
        null,
      method:
        (this.finished() ? s.method : sug.method) ??
        (this.isKata() ? 'flags' : sug.needs === 'hantei' ? 'hantei' : 'points'),
      reason: '',
      time_over: this.timeOver(),
    };
    // El método debe existir en la lista de la modalidad (un kata no se cierra «por puntos»).
    if (!this.methods().includes(this.finishForm.method))
      this.finishForm.method = this.methods()[0];
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
    if (t.winner)
      return $localize`:@@mesa.sugerencia-si-termino-tiempo:Sugerencia (si terminó el tiempo): gana ${t.winner === 'aka' ? 'AKA' : 'AO'}:color: por ${METHOD_LABEL[t.method ?? ''] ?? t.method}:metodo:`;
    if (t.needs === 'hantei')
      return $localize`:@@mesa.si-termino-tiempo-empate:Si terminó el tiempo: empate, se necesita hantei (decisión de jueces)`;
    if (t.needs === 'golden_point')
      return $localize`:@@mesa.si-termino-tiempo-empate-punto:Si terminó el tiempo: empate, punto de oro`;
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

  /**
   * Sin señal (o con eventos aún sin enviar) el cierre se deja en cola: el servidor lo acepta
   * una sola vez por `id`, así que se envía al volver la conexión, después de los eventos.
   */
  readonly finishWillQueue = computed(() => this.noSignal() || this.pending().length > 0);

  private queueFinish(f: FinishData): void {
    this.pending.update((q) => enqueueFinish(q, this.id(), f));
    this.finishOpen.set(false);
    this.toast.warn(
      $localize`:@@mesa.cierre-cola-anota-resultado-2:Cierre en cola: anota el resultado en la planilla; el combate se cerrará cuando vuelva la señal.`,
    );
    this.flush();
  }

  async confirmFinish(): Promise<void> {
    const f = this.finishForm;
    if (!f.winner) {
      this.toast.warn(
        $localize`:@@mesa.elige-ganador-antes-confirmar:Elige el ganador antes de confirmar.`,
      );
      return;
    }
    const data: FinishData = {
      id: this.finishId,
      at: new Date().toISOString(),
      winner: f.winner,
      method: f.method,
      reason: f.reason.trim() || null,
      time_over: f.time_over,
    };
    if (this.finishWillQueue()) {
      this.queueFinish(data);
      return;
    }
    const body = { ...data };
    this.finishing.set(true);
    const seq = this.seq.next();
    let queued = false;
    const res = await this.mut.run<FinishOut>(
      (override) =>
        this.api.post<FinishOut>(
          `/matches/${this.id()}/finish`,
          override ? { ...body, override } : body,
          undefined,
          this.deviceOpts,
        ),
      {
        success: $localize`:@@mesa.combate-cerrado-2:Combate cerrado`,
        onConflict: () => this.reload(),
        onError: (err) => {
          if (err.isNetwork || err.code === 'TIMEOUT') {
            // Se cortó la señal al cerrar: el mismo cierre (mismo id) queda en cola.
            this.offline.set(true);
            queued = true;
            this.queueFinish(data);
            return true;
          }
          if (err.code === 'CONFLICT_DEVICE') {
            this.finishOpen.set(false);
            this.toReadOnly();
            return true;
          }
          return false;
        },
      },
    );
    this.finishing.set(false);
    if (!res || queued) return;
    this.finishOpen.set(false);
    this.unlocked.set(false);
    this.setScoreboard(res.scoreboard, seq);
    if (res.affected_matches.length) {
      await this.dialog.alert(
        $localize`:@@mesa.combates-siguientes-afectados:Combates siguientes afectados`,
        $localize`:@@mesa.correccion-cambia-ganador:La corrección cambia el ganador de un combate que ya avanzó en la llave. Revisa estos combates:`,
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
    // mut.run reenvía el MISMO cuerpo con override={reason} si el servidor responde 409 WARNINGS.
    const res = await this.mut.run<{
      winner: Color | null;
      needs_head_judge: boolean;
      affected?: string[];
    }>(
      (override) =>
        this.api.post(
          `/matches/${this.id()}/flags`,
          override ? { ...body, override } : body,
          undefined,
          this.deviceOpts,
        ),
      {
        onError: (err) => {
          if (err.code !== 'CONFLICT_DEVICE') return false;
          this.toReadOnly();
          return true;
        },
      },
    );
    this.flagsBusy.set(false);
    if (!res) return;
    if (res.needs_head_judge) {
      this.needsHead.set(true);
      this.toast.warn(
        $localize`:@@mesa.empate-banderas-decide-juez:Empate de banderas: decide el juez principal.`,
      );
      return;
    }
    this.needsHead.set(false);
    this.flagsId = newId(); // decisión registrada: la próxima es otro evento
    this.toast.ok(
      $localize`:@@mesa.gana-banderas:Gana ${res.winner === 'aka' ? 'AKA' : 'AO'}:color: por banderas`,
    );
    await this.reload();
    if (res.affected?.length) {
      await this.dialog.alert(
        $localize`:@@mesa.combates-siguientes-afectados:Combates siguientes afectados`,
        $localize`:@@mesa.revisa-estos-combates:Revisa estos combates:`,
        res.affected,
      );
    }
  }

  // --- Navegación ---
  /** Tatami del combate: el de la URL (?tatami=) o, si no viene, el de su categoría. */
  readonly tatamiId = computed(() => {
    const t = this.tatami();
    if (t) return t;
    const c = this.category()?.tatami_id;
    return c ? String(c) : undefined;
  });

  async nextMatch(): Promise<void> {
    const t = this.tatamiId();
    if (!t) return;
    try {
      const q = await firstValueFrom(this.api.get<TatamiQueue>(`/tatamis/${t}/queue`));
      const next =
        q.queue.find((it) => it.match.id !== this.id() && it.match.status === 'in_progress') ??
        q.queue.find((it) => it.match.id !== this.id());
      if (!next) {
        this.dialog.alert(
          $localize`:@@mesa.cola-vacia:Cola vacía`,
          $localize`:@@mesa.no-hay-mas-combates-cola-este:No hay más combates en la cola de este tatami.`,
        );
        return;
      }
      this.router.navigate(['/mesa', next.match.id], { queryParams: { tatami: t } });
    } catch (e) {
      this.toast.error(ApiError.from(e).fullMessage);
    }
  }

  tatamiParams(): Record<string, string> {
    const t = this.tatamiId();
    return t ? { tatami: t } : {};
  }

  backLink(): unknown[] {
    const bout = this.sb()?.bout;
    if (bout) return ['/mesa', bout.parent_match_id];
    // El operador de un tatami (sin rol de organizador) vuelve a «Mi tatami».
    const u = this.auth.user();
    if (!isStaff(u) && homePath(u) === '/mi-tatami') return ['/mi-tatami'];
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
    return lvl ? (s.sanction_labels[lvl - 1] ?? $localize`:@@mesa.nivel:Nivel ${lvl}:lvl:`) : '';
  }

  describe(
    e: {
      type: string;
      color?: string | null;
      value?: number | null;
      method?: string | null;
      target_id?: string | null;
      reason?: string | null;
    },
    sb: Scoreboard,
  ): string {
    const who = e.color ? e.color.toUpperCase() + ' · ' : '';
    switch (e.type) {
      case 'point':
        return `${who}${POINT_LABEL[Number(e.value)] ?? $localize`:@@mesa.punto:Punto`} +${e.value}`;
      case 'sanction':
        return `${who}${sb.sanction_labels[Number(e.value) - 1] ?? $localize`:@@mesa.sancion-nivel:Sanción ${e.value}:nivel:`}`;
      case 'time_adjust': {
        // value suma al tiempo transcurrido; se muestra como cambio del tiempo restante.
        const r = -Number(e.value ?? 0);
        const ajuste = `${r > 0 ? '+' : ''}${r}`;
        return $localize`:@@mesa.ajuste-tiempo-s-restante:Ajuste de tiempo: ${ajuste}:ajuste: s al restante`;
      }
      case 'annul': {
        const t =
          sb.events.find((x) => x.id === e.target_id) ??
          this.pending().find((p) => p.body.id === e.target_id)?.body;
        return t
          ? $localize`:@@mesa.deshacer-evento:Deshacer: ${this.describe(t, sb)}:evento:`
          : $localize`:@@mesa.deshacer-evento-generico:Deshacer: evento`;
      }
      case 'finish':
        return $localize`:@@mesa.gana:${who}:who:Gana por ${METHOD_LABEL[e.method ?? ''] ?? e.method ?? ''}:metodo:${e.reason ? ' — ' + e.reason : ''}:motivo:`;
      default:
        return `${who}${EVENT_LABEL[e.type] ?? e.type}`;
    }
  }

  trackEvent(_: number, e: MatchEvent): string {
    return e.id;
  }
}
