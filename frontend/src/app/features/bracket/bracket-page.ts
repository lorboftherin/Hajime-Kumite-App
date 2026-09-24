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
import { Bracket, BracketVersion, Category, Match, Tournament } from '../../core/models';
import { MutationService } from '../../core/mutation.service';
import { StatusBadge } from '../../shared/badge';
import { Hanko } from '../../shared/hanko';
import { Icon } from '../../shared/icon';
import { Modal } from '../../shared/modal';
import { MoreMenu } from '../../shared/more-menu';
import { PageHead } from '../../shared/page-head';
import { LabelPipe, LimaPipe } from '../../shared/pipes';

const PLACE: Record<number, string> = { 1: '🥇', 2: '🥈', 3: '🥉' };
const KIND_LABEL: Record<string, string> = {
  third_place: 'Combate por el 3.º puesto',
  repechage: 'Repechaje',
};

@Component({
  selector: 'app-bracket-page',
  imports: [FormsModule, NgTemplateOutlet, RouterLink, StatusBadge, Modal, LabelPipe, LimaPipe, PageHead, Icon, MoreMenu, Hanko],
  templateUrl: './bracket-page.html',
  styleUrl: './bracket-page.scss',
})
export class BracketPage {
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

  // Kata por puntuación
  readonly scoring = signal<number | null>(null); // registration_id en edición
  scoreInputs: Array<number | null> = [];
  kataName = '';
  readonly tieOrder = signal<number[]>([]);
  tieReason = '';

  readonly catId = computed(() => Number(this.id()));

  readonly mainRounds = computed(() => {
    const b = this.bracket();
    if (!b || b.format !== 'single_elimination') return [];
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
      .filter((m) => m.kind !== 'main')
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

  readonly judges = computed(() => {
    const c = this.category();
    const d = (this.tournament()?.kata_defaults ?? {}) as Record<string, any>;
    const method = c?.kata_method ?? d['method'] ?? 'flags';
    return Number(c?.kata_judges ?? d['judges'] ?? (method === 'scores' ? 5 : 3));
  });

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
      this.dialog.alert('Error', ApiError.from(e).fullMessage);
    } finally {
      this.loading.set(false);
    }
  }

  roundLabel(r: number, n: number): string {
    const fromEnd = n - r;
    if (fromEnd === 0) return 'Final';
    if (fromEnd === 1) return 'Semifinal';
    if (fromEnd === 2) return 'Cuartos de final';
    if (fromEnd === 3) return 'Octavos de final';
    return `Ronda ${r}`;
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
    if (kind === 'winner' || kind === 'W') return `Ganador ${ref}`;
    if (kind === 'loser' || kind === 'L') return `Perdedor ${ref}`;
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
    if (this.canOpen(m)) this.router.navigate(['/mesa', m.id]);
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
      { success: `Posiciones ${a + 1} y ${slot + 1} intercambiadas`, onConflict: () => this.load() },
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
    const res = await this.mut.post<Bracket>(`/categories/${this.catId()}/bracket`, body, { success: 'Llave generada' });
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
      this.dialog.alert('Error', ApiError.from(e).fullMessage);
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
    this.kataName = row['kata_name'] ?? '';
    this.scoring.set(row['registration_id']);
  }

  async saveScore(row: Record<string, any>): Promise<void> {
    const scores = this.scoreInputs.map((x) => Math.round(Number(x) * 10) / 10);
    if (scores.some((x) => isNaN(x) || x === null)) {
      this.dialog.alert('Notas incompletas', 'Ingresa la nota de cada juez (un decimal).');
      return;
    }
    const res = await this.mut.post<Bracket>(
      `/categories/${this.catId()}/kata-scores`,
      { registration_id: row['registration_id'], scores, kata_name: this.kataName || null, version: row['version'] },
      { success: 'Notas registradas', onConflict: () => this.load() },
    );
    if (res) {
      this.bracket.set(res);
      this.scoring.set(null);
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
      this.dialog.alert('Falta el motivo', 'Indica el motivo del desempate (mín. 3 caracteres).');
      return;
    }
    const res = await this.mut.post<Bracket>(
      `/categories/${this.catId()}/kata-tie-break`,
      { registration_ids_in_order: this.tieOrder(), reason: this.tieReason.trim() },
      { success: 'Desempate registrado' },
    );
    if (res) {
      this.bracket.set(res);
      this.tieReason = '';
    }
  }
}
