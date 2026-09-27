import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiError } from '../../core/api-error';
import { ApiService } from '../../core/api.service';
import { DialogService } from '../../core/dialog.service';
import { FilesService } from '../../core/files.service';
import { FORMAT_LABEL, METHOD_LABEL, THIRD_PLACE_LABEL } from '../../core/format';
import {
  Bracket,
  BracketChange,
  BracketVersion,
  Category,
  KataCatalog,
  Match,
  Registration,
  SuggestedJudges,
  Tournament,
} from '../../core/models';
import { MutationService } from '../../core/mutation.service';
import { StatusBadge } from '../../shared/badge';
import { Hanko } from '../../shared/hanko';
import { Icon } from '../../shared/icon';
import { Modal } from '../../shared/modal';
import { MoreMenu } from '../../shared/more-menu';
import { PageHead } from '../../shared/page-head';
import { LabelPipe, LimaPipe } from '../../shared/pipes';
import { BracketGenerator } from '../checkin/bracket-absent';
import { etiquetas } from '../../core/i18n/etiquetas';

function fmtScore(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  return isNaN(n) ? String(v) : n.toFixed(1);
}

const PLACE: Record<number, string> = { 1: '🥇', 2: '🥈', 3: '🥉' };
const KIND_LABEL: Record<string, string> = etiquetas(() => ({
  third_place: $localize`:@@llave.combate-3-puesto:Combate por el 3.º puesto`,
  repechage: $localize`:@@llave.repechaje-2:Repechaje`,
}));

const CHANGE_TEXT: Record<string, string> = etiquetas(() => ({
  bye: $localize`:@@llave.ocupa-bye-primera-ronda:ocupa un bye de primera ronda`,
  round_robin: $localize`:@@llave.agregaron-combates:se agregaron sus combates`,
  kata_rounds: $localize`:@@llave.entra-final-orden-salida:entra al final del orden de salida`,
  walkover: $localize`:@@llave.pierde-walkover-combate:pierde por walkover su combate pendiente`,
  walkover_pending: $localize`:@@llave.perdera-walkover-cuanto-conozca:perderá por walkover en cuanto se conozca a su rival`,
  none: $localize`:@@llave.no-tenia-combates-disputar:no tenía combates por disputar`,
}));

@Component({
  selector: 'app-bracket-page',
  imports: [FormsModule, NgTemplateOutlet, RouterLink, StatusBadge, Modal, LabelPipe, LimaPipe, PageHead, Icon, MoreMenu, Hanko],
  templateUrl: './bracket-page.html',
  styleUrl: './bracket-page.scss',
})
export class BracketPage {
  private brackets = inject(BracketGenerator);
  private api = inject(ApiService);
  private mut = inject(MutationService);
  private dialog = inject(DialogService);
  private router = inject(Router);
  readonly files = inject(FilesService);

  readonly id = input.required<string>();
  readonly formatLabel = FORMAT_LABEL;
  readonly thirdLabel = THIRD_PLACE_LABEL;
  readonly methodLabel = METHOD_LABEL;
  readonly kindLabel = KIND_LABEL;
  readonly textoNotaDescartada = $localize`:@@llave.nota-descartada:Nota descartada`;
  readonly textoAbrirMesa = $localize`:@@llave.abrir-mesa:Abrir mesa`;
  readonly textoRegenerarLlave = $localize`:@@llave.titulo-regenerar-llave:Regenerar llave`;
  readonly textoGenerarLlave = $localize`:@@llave.titulo-generar-llave:Generar llave`;
  readonly textoAnadirLlave = $localize`:@@llave.titulo-anadir-llave:Añadir a la llave`;
  readonly textoQuitarLlave = $localize`:@@llave.titulo-quitar-llave:Quitar de la llave`;
  readonly textoEjTardia = $localize`:@@llave.ej-inscripcion-tardia:Ej.: inscripción tardía`;
  readonly textoEjLesion = $localize`:@@llave.ej-lesion:Ej.: lesión`;
  ariaNotaAtletica = (juez: number) => $localize`:@@llave.nota-atletica-juez:Nota atlética del juez ${juez}:juez:`;
  ariaQuienJuez = (juez: number) => $localize`:@@llave.quien-juez:Quién es el juez ${juez}:juez:`;

  readonly category = signal<Category | null>(null);
  readonly tournament = signal<Tournament | null>(null);
  readonly bracket = signal<Bracket | null>(null);
  readonly loading = signal(true);
  readonly noBracket = signal(false);

  // Intercambio de posiciones
  readonly swapMode = signal(false);
  readonly swapA = signal<number | null>(null);

  // Regenerar
  readonly regenOpen = signal(false);
  regen = { seed: '' as string | number, format: '' as string, third_place_rule: '' as string, reason: '' };

  // Historial
  readonly versions = signal<BracketVersion[] | null>(null);

  // Añadir o quitar de la llave ya generada
  readonly entrantMode = signal<'add' | 'remove' | null>(null);
  readonly categoryRegs = signal<Registration[]>([]);
  entrant = { registration_id: null as number | null, reason: '' };

  // Catálogo de katas (autocompletar)
  readonly catalog = signal<string[]>([]);
  /** Notas atléticas (con notas técnico / atléticas). */
  athleticInputs: Array<number | null> = [];

  // Kata por puntuación
  readonly scoring = signal<number | null>(null); // registration_id en edición
  scoreInputs: Array<number | null> = [];
  /** Qué juez dio cada nota (opcional, sección 20). */
  judgeInputs: Array<number | null> = [];
  readonly judgeOptions = signal<SuggestedJudges | null>(null);
  kataName = '';
  readonly tieOrder = signal<number[]>([]);
  tieReason = '';

  readonly catId = computed(() => Number(this.id()));

  readonly mainRounds = computed(() => {
    const b = this.bracket();
    if (!b || !['single_elimination', 'groups_knockout'].includes(b.format)) return [];
    const main = b.matches.filter((m) => m.kind === 'main');
    const n = Math.max(0, ...main.map((m) => m.round));
    const rounds: Array<{ round: number; label: string; matches: Match[] }> = [];
    for (let r = 1; r <= n; r++) {
      rounds.push({
        round: r,
        label: this.roundLabel(r, n),
        matches: main.filter((m) => m.round === r).sort((a, b) => a.position - b.position),
      });
    }
    return rounds;
  });

  readonly extraMatches = computed(() =>
    (this.bracket()?.matches ?? [])
      .filter((m) => m.kind !== 'main' && m.kind !== 'group')
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.round - b.round || a.position - b.position),
  );

  readonly rrMatches = computed(() =>
    [...(this.bracket()?.matches ?? [])].sort((a, b) => a.round - b.round || a.position - b.position),
  );

  readonly kataRows = computed(() => {
    const b = this.bracket();
    if (!b || b.format !== 'kata_rounds') return [];
    return [...(b.standings ?? [])].sort((a, b) => (a['order'] ?? 0) - (b['order'] ?? 0));
  });

  readonly tiedRows = computed(() => this.kataRows().filter((r) => r['tied']));

  /** Grupos (formato grupos + eliminación) con sus combates. */
  readonly groupTables = computed(() => {
    const b = this.bracket();
    if (!b?.groups) return [];
    const matches = b.matches.filter((m) => m.kind === 'group');
    return b.groups.map((g) => ({
      ...g,
      matches: matches
        .filter((m) => m.code.startsWith('G' + g.letter))
        .sort((a, b) => a.round - b.round || a.position - b.position),
    }));
  });

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
    return {
      method,
      judges,
      discard: discard === undefined || discard === null || discard === '' ? (judges === 3 ? 0 : 1) : Number(discard),
      split,
    };
  });

  readonly judges = computed(() => this.kataCfg().judges);

  /** Notas descartadas por lado; igual que el backend: 0 con 3 jueces, si no 1 (o la configuración). */
  readonly discards = computed(() => this.kataCfg().discard);

  /** Rondas de kata: la ronda en curso ya empezó si alguien tiene nota. */
  readonly roundStarted = computed(() => this.kataRows().some((r) => (r['scores'] ?? []).length));
  readonly previousRounds = computed(() => {
    const kr = this.bracket()?.kata_rounds;
    return kr ? kr.rounds.filter((r) => r.round < kr.current) : [];
  });

  /** Notas en orden de juez, con un decimal y marcando las descartadas (las k más bajas y las k más altas). */
  scoreCells(scores: Array<number | string> | null | undefined): Array<{ text: string; discarded: boolean }> {
    const vals = (scores ?? []).map((x) => Number(x));
    const k = this.discards();
    const out = vals.map((v) => ({ text: fmtScore(v), discarded: false }));
    if (k > 0 && vals.length > 2 * k) {
      const order = vals.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v || a.i - b.i);
      for (const { i } of [...order.slice(0, k), ...order.slice(-k)]) out[i].discarded = true;
    }
    return out;
  }

  readonly fmtScore = fmtScore;

  readonly podium = computed(() => {
    const b = this.bracket();
    return (b?.podium.places ?? []).map((p) => ({ ...p, medal: PLACE[p.place] ?? p.place + '.º' }));
  });

  constructor() {
    effect(() => {
      const id = this.catId();
      if (id) this.load();
    });
    effect(() => {
      // Orden inicial del desempate: el que ya propone la clasificación.
      const tied = this.tiedRows();
      this.tieOrder.set(
        [...tied].sort((a, b) => (a['rank'] ?? 0) - (b['rank'] ?? 0)).map((r) => r['registration_id'] as number),
      );
    });
  }

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      const c = await firstValueFrom(this.api.get<Category>(`/categories/${this.catId()}`));
      this.category.set(c);
      if (this.tournament()?.id !== c.tournament_id) {
        this.api.get<Tournament>(`/tournaments/${c.tournament_id}`).subscribe({ next: (t) => this.tournament.set(t), error: () => {} });
      }
      try {
        this.bracket.set(await firstValueFrom(this.api.get<Bracket>(`/categories/${this.catId()}/bracket`)));
        this.noBracket.set(false);
      } catch (e) {
        if (ApiError.from(e).status === 404) {
          this.bracket.set(null);
          this.noBracket.set(true);
        } else throw e;
      }
    } catch (e) {
      this.dialog.alert($localize`:@@llave.error:Error`, ApiError.from(e).fullMessage);
    } finally {
      this.loading.set(false);
    }
  }

  roundLabel(r: number, n: number): string {
    const fromEnd = n - r;
    if (fromEnd === 0) return $localize`:@@llave.final-2:Final`;
    if (fromEnd === 1) return $localize`:@@llave.semifinal:Semifinal`;
    if (fromEnd === 2) return $localize`:@@llave.cuartos-final:Cuartos de final`;
    if (fromEnd === 3) return $localize`:@@llave.octavos-final:Octavos de final`;
    return $localize`:@@llave.ronda-2:Ronda ${r}:r:`;
  }

  pname(rid: number | null | undefined): string {
    if (!rid) return '';
    return this.bracket()?.participants[rid]?.name ?? `#${rid}`;
  }

  pdojo(rid: number | null | undefined): string {
    if (!rid) return '';
    return this.bracket()?.participants[rid]?.dojo_name ?? '';
  }

  /** Posición de llave (slot) si la fuente es "slot:N". */
  slotOf(source: string): number | null {
    const [kind, ref] = source.split(':');
    return kind === 'slot' ? Number(ref) : null;
  }

  sourceHint(source: string): string {
    const [kind, ref] = source.split(':');
    if (kind === 'slot') return '';
    if (kind === 'winner' || kind === 'W') return $localize`:@@llave.ganador:Ganador ${ref}:ref:`;
    if (kind === 'loser' || kind === 'L') return $localize`:@@llave.perdedor:Perdedor ${ref}:ref:`;
    return ref ?? '';
  }

  isBye(m: Match, color: 'aka' | 'ao'): boolean {
    const src = color === 'aka' ? m.aka_source : m.ao_source;
    const rid = color === 'aka' ? m.aka_registration_id : m.ao_registration_id;
    const slot = this.slotOf(src);
    return slot !== null && !rid && this.bracket()?.slots[slot] == null;
  }

  canOpen(m: Match): boolean {
    return !!m.aka_registration_id && !!m.ao_registration_id && ['ready', 'in_progress', 'finished', 'needs_review'].includes(m.status);
  }

  openMatch(m: Match): void {
    if (this.swapMode()) return;
    const c = this.category();
    // Un combate de kumite individual cerrado abre su hoja (línea de tiempo, técnicas, compartir);
    // desde ahí se puede ir a la mesa para corregir.
    if (m.status === 'finished' && c?.modality === 'kumite' && !c.is_team && m.method !== 'bye') {
      this.router.navigate(['/combates', m.id]);
      return;
    }
    if (this.canOpen(m)) this.router.navigate(['/mesa', m.id]);
  }

  /** Teclado: Enter o Espacio abren el combate (como el clic). */
  onMatchKey(ev: Event, m: Match): void {
    if (ev.target !== ev.currentTarget || this.swapMode() || !this.canOpen(m)) return;
    ev.preventDefault();
    this.openMatch(m);
  }

  matchLabel(m: Match): string {
    const who = (rid: number | null) => (rid ? this.pname(rid) : $localize`:@@llave.definir:por definir`);
    return $localize`:@@llave.combate-contra-abrir:Combate ${m.code}:code:: ${who(m.aka_registration_id)}:aka: contra ${who(m.ao_registration_id)}:ao:. Abrir`;
  }

  /** Teclado: Enter o Espacio eligen la posición para intercambiar. */
  onSlotKey(ev: Event, slot: number | null): void {
    if (!this.swapMode() || slot === null) return;
    ev.preventDefault();
    this.clickSlot(ev, slot);
  }

  slotLabel(slot: number, rid: number | null): string {
    const who = rid ? this.pname(rid) : $localize`:@@llave.vacia:vacía`;
    const picked = this.swapA();
    if (picked === slot) return $localize`:@@llave.posicion-elegida-elige-otra-para:Posición ${slot + 1}:posicion: (${who}:who:), elegida. Elige otra para intercambiar o pulsa de nuevo para soltarla`;
    return picked === null
      ? $localize`:@@llave.posicion-elegir-para:Posición ${slot + 1}:posicion: (${who}:who:). Elegir para intercambiar`
      : $localize`:@@llave.posicion-intercambiar-posicion:Posición ${slot + 1}:posicion: (${who}:who:). Intercambiar con la posición ${picked + 1}:otra:`;
  }

  // --- Intercambio de posiciones ---
  toggleSwap(): void {
    this.swapMode.set(!this.swapMode());
    this.swapA.set(null);
  }

  async clickSlot(ev: Event, slot: number | null): Promise<void> {
    if (!this.swapMode() || slot === null) return;
    ev.stopPropagation();
    const a = this.swapA();
    if (a === null) {
      this.swapA.set(slot);
      return;
    }
    if (a === slot) {
      this.swapA.set(null);
      return;
    }
    const b = this.bracket()!;
    const res = await this.mut.patch<Bracket>(
      `/brackets/${b.id}/slots`,
      { version: b.version, a, b: slot, reason: '' },
      { success: $localize`:@@llave.posiciones-intercambiadas:Posiciones ${a + 1}:posicion: y ${slot + 1}:otra: intercambiadas`, onConflict: () => this.load() },
    );
    this.swapA.set(null);
    if (res) this.bracket.set(res);
  }

  // --- Generar / regenerar ---
  openRegen(): void {
    const b = this.bracket();
    this.regen = {
      seed: '',
      format: b?.format === 'kata_rounds' ? '' : '',
      third_place_rule: '',
      reason: '',
    };
    this.regenOpen.set(true);
  }

  async doRegen(): Promise<void> {
    const body: Record<string, unknown> = { reason: this.regen.reason };
    if (this.regen.seed !== '' && this.regen.seed !== null) body['seed'] = Number(this.regen.seed);
    if (this.regen.format) body['format'] = this.regen.format;
    if (this.regen.third_place_rule) body['third_place_rule'] = this.regen.third_place_rule;
    const res = await this.brackets.generate(this.catId(), body, { success: $localize`:@@llave.llave-generada:Llave generada` });
    if (res) {
      this.regenOpen.set(false);
      this.bracket.set(res);
      this.noBracket.set(false);
      this.load();
    }
  }

  async showVersions(): Promise<void> {
    try {
      this.versions.set(await firstValueFrom(this.api.get<BracketVersion[]>(`/categories/${this.catId()}/bracket/versions`)));
    } catch (e) {
      this.dialog.alert($localize`:@@llave.error:Error`, ApiError.from(e).fullMessage);
    }
  }

  printPdf(blank: boolean): void {
    this.files.open(`/categories/${this.catId()}/bracket.pdf`, blank ? { blank: true } : undefined);
  }

  // --- Kata por puntuación ---
  startScore(row: Record<string, any>): void {
    const n = this.judges();
    const prev = (row['scores'] as number[] | null) ?? [];
    this.scoreInputs = Array.from({ length: n }, (_, i) => prev[i] ?? null);
    const prevAth = (row['athletic_scores'] as number[] | null) ?? [];
    this.athleticInputs = Array.from({ length: n }, (_, i) => prevAth[i] ?? null);
    this.loadCatalog();
    const prevJudges = (row['judge_person_ids'] as Array<number | null> | null) ?? [];
    const assigned = this.judgeOptions()?.assigned ?? [];
    this.judgeInputs = Array.from({ length: n }, (_, i) => prevJudges[i] ?? assigned[i]?.person_id ?? null);
    if (!this.judgeOptions()) {
      this.api.get<SuggestedJudges>(`/categories/${this.catId()}/referees`).subscribe({
        next: (j) => {
          this.judgeOptions.set(j);
          this.judgeInputs = this.judgeInputs.map((x, i) => x ?? j.assigned[i]?.person_id ?? null);
        },
        error: () => {},
      });
    }
    this.kataName = row['kata_name'] ?? '';
    this.scoring.set(row['registration_id']);
  }

  async saveScore(row: Record<string, any>): Promise<void> {
    const scores = this.scoreInputs.map((x) => Math.round(Number(x) * 10) / 10);
    const athletic = this.athleticInputs.map((x) => Math.round(Number(x) * 10) / 10);
    const split = this.kataCfg().split;
    if (
      [...scores, ...(split ? athletic : [])].some((x) => isNaN(x) || x === null) ||
      this.scoreInputs.some((x) => x === null) ||
      (split && this.athleticInputs.some((x) => x === null))
    ) {
      this.dialog.alert($localize`:@@llave.notas-incompletas:Notas incompletas`, $localize`:@@llave.ingresa-nota-cada-juez-decimal:Ingresa la nota de cada juez (un decimal).`);
      return;
    }
    const res = await this.mut.post<Bracket>(
      `/categories/${this.catId()}/kata-scores`,
      {
        registration_id: row['registration_id'],
        scores,
        athletic_scores: split ? athletic : null,
        round_number: row['round_number'] ?? null,
        judge_person_ids: this.judgeInputs.some((x) => x !== null) ? this.judgeInputs : null,
        kata_name: this.kataName || null,
        version: row['version'],
      },
      { success: $localize`:@@llave.notas-registradas:Notas registradas`, onConflict: () => this.load() },
    );
    if (res) {
      this.bracket.set(res);
      this.scoring.set(null);
    }
  }

  private loadCatalog(): void {
    if (this.catalog().length) return;
    this.api.get<KataCatalog>('/kata-catalog').subscribe({ next: (c) => this.catalog.set(c.katas), error: () => {} });
  }

  /** Orden de salida de la ronda en curso: subir o bajar a alguien. */
  async moveOrder(i: number, dir: -1 | 1): Promise<void> {
    const ids = this.kataRows().map((r) => r['registration_id'] as number);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    const res = await this.mut.put<Bracket>(`/categories/${this.catId()}/kata-order`, { registration_ids: ids });
    if (res) this.bracket.set(res);
  }

  // --- Añadir o quitar de la llave ya generada ---
  async openEntrants(mode: 'add' | 'remove'): Promise<void> {
    const c = this.category();
    if (!c) return;
    this.entrant = { registration_id: null, reason: '' };
    try {
      this.categoryRegs.set(
        await firstValueFrom(
          this.api.get<Registration[]>(`/tournaments/${c.tournament_id}/registrations`, {
            category_id: c.id,
            include_withdrawn: false,
          }),
        ),
      );
    } catch (e) {
      this.dialog.alert($localize`:@@llave.error:Error`, ApiError.from(e).fullMessage);
      return;
    }
    this.entrantMode.set(mode);
  }

  /** Para añadir: inscritos activos que no están en la llave; para quitar: los que sí están. */
  readonly entrantChoices = computed(() => {
    const b = this.bracket();
    const inBracket = new Set<number>([
      ...((b?.slots ?? []).filter((x) => x !== null) as number[]),
      ...(b?.standings ?? []).map((s) => s['registration_id'] as number),
    ]);
    const regs = this.categoryRegs();
    return this.entrantMode() === 'add'
      ? regs.filter((r) => !inBracket.has(r.id))
      : regs.filter((r) => inBracket.has(r.id));
  });

  async saveEntrant(): Promise<void> {
    const mode = this.entrantMode();
    const b = this.bracket();
    if (!mode || !b || !this.entrant.registration_id) return;
    const path = `/categories/${this.catId()}/bracket/entrants${mode === 'remove' ? '/remove' : ''}`;
    const res = await this.mut.post<BracketChange>(
      path,
      { registration_id: this.entrant.registration_id, reason: this.entrant.reason, version: b.version },
      { onConflict: () => this.load() },
    );
    if (res) {
      const who = this.categoryRegs().find((r) => r.id === this.entrant.registration_id)?.person_name ?? '';
      this.dialog.alert(
        mode === 'add' ? $localize`:@@llave.anadido-llave:Añadido a la llave` : $localize`:@@llave.quitado-llave:Quitado de la llave`,
        $localize`:@@llave.guardo-version-v:${who}:who:: ${CHANGE_TEXT[res.result.mode] ?? res.result.mode}:cambio:. Se guardó la versión v${res.bracket.version_number}:version_number:.`,
      );
      this.entrantMode.set(null);
      this.bracket.set(res.bracket);
      this.load();
    }
  }

  moveTie(i: number, dir: -1 | 1): void {
    const o = [...this.tieOrder()];
    const j = i + dir;
    if (j < 0 || j >= o.length) return;
    [o[i], o[j]] = [o[j], o[i]];
    this.tieOrder.set(o);
  }

  async resolveTie(): Promise<void> {
    if (this.tieReason.trim().length < 3) {
      this.dialog.alert($localize`:@@llave.falta-motivo:Falta el motivo`, $localize`:@@llave.indica-motivo-desempate-min-3:Indica el motivo del desempate (mín. 3 caracteres).`);
      return;
    }
    const res = await this.mut.post<Bracket>(
      `/categories/${this.catId()}/kata-tie-break`,
      { registration_ids_in_order: this.tieOrder(), reason: this.tieReason.trim() },
      { success: $localize`:@@llave.desempate-registrado:Desempate registrado` },
    );
    if (res) {
      this.bracket.set(res);
      this.tieReason = '';
    }
  }
}
