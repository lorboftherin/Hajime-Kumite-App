import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiError } from '../../core/api-error';
import { ApiService } from '../../core/api.service';
import { DialogService } from '../../core/dialog.service';
import { METHOD_LABEL, newId } from '../../core/format';
import { Color, TeamBout, TeamMatch, TeamMember } from '../../core/models';
import { MutationService } from '../../core/mutation.service';
import { ToastService } from '../../core/toast.service';

interface DraftRow {
  aka: number | null;
  ao: number | null;
  /** Combate ya iniciado: su alineación no se cambia. */
  locked: boolean;
}

/**
 * Enfrentamiento de kumite por equipos (sección 15): marcador de victorias,
 * alineación y lista de combates individuales. Cada combate se opera en la
 * mesa normal (/mesa/:id); al cerrarlo el servidor recalcula el enfrentamiento.
 */
@Component({
  selector: 'app-team-match',
  imports: [FormsModule, RouterLink],
  template: `
    @if (team(); as t) {
      @let d = t.decision;
      <section class="team" aria-label="Enfrentamiento por equipos">
        <div class="tscore">
          @for (c of colors; track c) {
            <div class="tside {{ c }}" [class.win]="d.winner === c" [class.lose]="!!d.winner && d.winner !== c">
              <span class="tlabel">{{ c === 'aka' ? 'AKA' : 'AO' }} <span aria-hidden="true">{{ c === 'aka' ? '赤' : '青' }}</span></span>
              <span class="tname">{{ t[c]?.name ?? '—' }}</span>
              <span class="tdojo">{{ t[c]?.dojo_name }}</span>
              @if (d.winner === c) {
                <span class="seal" aria-hidden="true">勝</span>
              }
            </div>
            @if (c === 'aka') {
              <div class="twins" aria-label="Victorias">
                <div class="nums">
                  <span class="n">{{ d.wins.aka }}</span><span class="dash">–</span><span class="n">{{ d.wins.ao }}</span>
                </div>
                <span class="tsub">victorias</span>
                <span class="tsub">puntos {{ d.points.aka }}–{{ d.points.ao }}@if (d.draws) { · {{ d.draws }} empate(s) }</span>
              </div>
            }
          }
        </div>

        <p class="tstate {{ stateTone() }}" role="status">{{ stateText() }}</p>

        @if (editing()) {
          <div class="panel">
            <div class="panel-head">
              <h3>Alineación</h3>
              <p>
                Quién pelea cada combate.
                @if (t.settings.lock_order !== false) {
                  El orden queda fijo al empezar el primer combate.
                } @else {
                  Se puede cambiar mientras el combate no haya empezado.
                }
                @if (t.settings.empty_slot_walkover !== false) {
                  Un puesto vacío es walkover para el rival.
                }
                @if (t.settings.min_starters) {
                  Mínimo {{ t.settings.min_starters }} integrantes por equipo.
                }
              </p>
            </div>
            @for (row of draft(); track $index; let i = $index) {
              <div class="lrow" [class.locked]="row.locked">
                <span class="bn">{{ i + 1 }}</span>
                <select [(ngModel)]="row.aka" [disabled]="row.locked" [attr.aria-label]="'AKA, combate ' + (i + 1)">
                  <option [ngValue]="null">— Por definir —</option>
                  @for (m of t.aka?.members ?? []; track m.person_id) {
                    <option [ngValue]="m.person_id">{{ memberLabel(m) }}</option>
                  }
                </select>
                <span class="vs">vs</span>
                <select [(ngModel)]="row.ao" [disabled]="row.locked" [attr.aria-label]="'AO, combate ' + (i + 1)">
                  <option [ngValue]="null">— Por definir —</option>
                  @for (m of t.ao?.members ?? []; track m.person_id) {
                    <option [ngValue]="m.person_id">{{ memberLabel(m) }}</option>
                  }
                </select>
              </div>
            }
            <div class="actions">
              @if (t.bouts.length) {
                <button class="qbtn" (click)="editing.set(false)">Cancelar</button>
              }
              <button class="qbtn primary" [disabled]="busy()" (click)="saveLineup()">
                {{ t.bouts.length ? 'Guardar alineación' : 'Confirmar alineación' }}
              </button>
            </div>
          </div>
        } @else {
          <ol class="bouts">
            @for (b of t.bouts; track b.match.id) {
              <li class="bout st-{{ b.match.status }}" [class.extra]="b.is_extra" [class.next]="b.match.id === nextBoutId()">
                <span class="bn">{{ b.is_extra ? 'Extra' : 'Combate ' + b.match.bout_number }}</span>
                <span class="p aka" [class.won]="winnerOf(b) === 'aka'">{{ b.aka_name ?? 'Por definir' }}</span>
                <span class="res">{{ resultText(b) }}</span>
                <span class="p ao" [class.won]="winnerOf(b) === 'ao'">{{ b.ao_name ?? 'Por definir' }}</span>
                <a class="qbtn" [class.primary]="b.match.id === nextBoutId()" [routerLink]="['/mesa', b.match.id]" [queryParams]="linkParams()">
                  {{ b.match.status === 'finished' ? 'Ver' : 'Operar' }} <span aria-hidden="true">→</span>
                </a>
              </li>
            }
          </ol>
          <div class="actions">
            @if (canEditLineup()) {
              <button class="qbtn" (click)="startEdit()">Editar alineación</button>
            }
          </div>
        }

        @if (d.needs_extra_bout && !editing()) {
          <div class="panel extra">
            <div class="panel-head">
              <h3>Combate extra</h3>
              <p>{{ d.reason }}. Elige a los representantes de cada equipo.</p>
            </div>
            <div class="lrow">
              <span class="bn">X</span>
              <select [(ngModel)]="extraAka" aria-label="AKA, combate extra">
                <option [ngValue]="null">— Por definir —</option>
                @for (m of t.aka?.members ?? []; track m.person_id) {
                  <option [ngValue]="m.person_id">{{ memberLabel(m) }}</option>
                }
              </select>
              <span class="vs">vs</span>
              <select [(ngModel)]="extraAo" aria-label="AO, combate extra">
                <option [ngValue]="null">— Por definir —</option>
                @for (m of t.ao?.members ?? []; track m.person_id) {
                  <option [ngValue]="m.person_id">{{ memberLabel(m) }}</option>
                }
              </select>
            </div>
            <div class="actions">
              <button class="qbtn primary" [disabled]="busy()" (click)="addExtra()">Agregar combate extra</button>
            </div>
          </div>
        }

        @if (t.match.status !== 'finished') {
          <details class="rare">
            <summary>Un equipo no se presenta</summary>
            <p>Cierra el enfrentamiento por walkover sin combates individuales.</p>
            <div class="actions">
              <button class="qbtn" [disabled]="busy()" (click)="walkover('aka')">AKA no se presenta</button>
              <button class="qbtn" [disabled]="busy()" (click)="walkover('ao')">AO no se presenta</button>
            </div>
          </details>
        }
      </section>
    } @else if (error()) {
      <p class="tstate needs">{{ error() }}</p>
    }
  `,
  styleUrl: './team-match.scss',
})
export class TeamMatchPanel {
  private api = inject(ApiService);
  private mut = inject(MutationService);
  private dialog = inject(DialogService);
  private toast = inject(ToastService);

  readonly matchId = input.required<number>();
  readonly tatami = input<string | undefined>(undefined);
  /** Se emite cuando cambia el enfrentamiento (para que la mesa recargue su encabezado). */
  readonly changed = output<void>();

  readonly colors: Color[] = ['aka', 'ao'];
  readonly team = signal<TeamMatch | null>(null);
  readonly error = signal('');
  readonly editing = signal(false);
  readonly draft = signal<DraftRow[]>([]);
  readonly busy = signal(false);
  extraAka: number | null = null;
  extraAo: number | null = null;

  readonly linkParams = computed(() => (this.tatami() ? { tatami: this.tatami() } : {}));

  /** Primer combate sin cerrar: es el que la mesa debería operar ahora. */
  readonly nextBoutId = computed(() => {
    const t = this.team();
    if (!t || t.match.status === 'finished') return null;
    return t.bouts.find((b) => b.match.status !== 'finished')?.match.id ?? null;
  });

  readonly canEditLineup = computed(() => {
    const t = this.team();
    return !!t && t.match.status !== 'finished' && t.bouts.some((b) => !b.is_extra && b.match.status === 'ready');
  });

  readonly stateText = computed(() => {
    const t = this.team();
    if (!t) return '';
    const d = t.decision;
    if (t.match.status === 'finished' && t.match.winner_registration_id) {
      const color: Color = t.match.winner_registration_id === t.aka?.registration_id ? 'aka' : 'ao';
      const how = METHOD_LABEL[t.match.method ?? ''] ?? t.match.method;
      return `Gana ${color === 'aka' ? 'AKA' : 'AO'} · ${t[color]?.name ?? ''} por ${how}`;
    }
    if (!t.bouts.length) return `Define la alineación: ${t.settings.bouts} combates por enfrentamiento.`;
    if (d.needs_extra_bout) return d.reason ?? 'Empate: combate extra';
    if (d.extra_bout_needs_hantei) return d.reason ?? 'Combate extra empatado: decide por hantei';
    if (d.pending_bouts) return `Faltan ${d.pending_bouts} combate(s). Gana el equipo con más victorias.`;
    return 'Combate extra en curso';
  });

  readonly stateTone = computed(() => {
    const t = this.team();
    if (!t) return '';
    if (t.match.status === 'finished') return 'win';
    return t.decision.needs_extra_bout || !t.bouts.length ? 'needs' : 'info';
  });

  constructor() {
    effect(() => {
      const id = this.matchId();
      untracked(() => this.load(id));
    });
  }

  async load(id = this.matchId()): Promise<void> {
    try {
      const t = await firstValueFrom(this.api.get<TeamMatch>(`/matches/${id}/team`));
      this.set(t);
      this.error.set('');
    } catch (e) {
      this.error.set(ApiError.from(e).fullMessage);
    }
  }

  private set(t: TeamMatch): void {
    this.team.set(t);
    if (!t.bouts.length && t.match.status !== 'finished') this.startEdit();
    else if (!this.busy()) this.editing.set(false);
  }

  memberLabel(m: TeamMember): string {
    return m.role === 'substitute' ? `${m.name} (suplente)` : m.name;
  }

  startEdit(): void {
    const t = this.team();
    if (!t) return;
    const regular = t.bouts.filter((b) => !b.is_extra);
    if (regular.length) {
      this.draft.set(
        regular.map((b) => ({ aka: b.aka_person_id, ao: b.ao_person_id, locked: b.match.status !== 'ready' })),
      );
    } else {
      // Propuesta inicial: los titulares en el orden en que se inscribieron.
      const starters = (side: 'aka' | 'ao') => (t[side]?.members ?? []).filter((m) => m.role === 'starter');
      const a = starters('aka');
      const o = starters('ao');
      this.draft.set(
        Array.from({ length: t.settings.bouts }, (_, i) => ({
          aka: a[i]?.person_id ?? null,
          ao: o[i]?.person_id ?? null,
          locked: false,
        })),
      );
    }
    this.editing.set(true);
  }

  async saveLineup(): Promise<void> {
    const t = this.team();
    if (!t) return;
    this.busy.set(true);
    const res = await this.mut.put<TeamMatch>(
      `/matches/${t.match.id}/lineup`,
      { bouts: this.draft().map((r) => ({ aka_person_id: r.aka, ao_person_id: r.ao })), version: t.match.version },
      { success: 'Alineación guardada', onConflict: () => this.load() },
    );
    this.busy.set(false);
    if (!res) return;
    this.editing.set(false);
    this.set(res);
    this.changed.emit();
  }

  async addExtra(): Promise<void> {
    const t = this.team();
    if (!t) return;
    this.busy.set(true);
    const res = await this.mut.put<TeamMatch>(
      `/matches/${t.match.id}/lineup`,
      { bouts: [{ aka_person_id: this.extraAka, ao_person_id: this.extraAo }], extra: true, version: t.match.version },
      { success: 'Combate extra agregado', onConflict: () => this.load() },
    );
    this.busy.set(false);
    if (!res) return;
    this.extraAka = this.extraAo = null;
    this.set(res);
    this.changed.emit();
  }

  async walkover(absent: Color): Promise<void> {
    const t = this.team();
    if (!t) return;
    const winner: Color = absent === 'aka' ? 'ao' : 'aka';
    const ok = await this.dialog.confirm({
      title: 'Walkover del equipo',
      message: `${t[absent]?.name ?? absent.toUpperCase()} no se presenta. Gana ${t[winner]?.name ?? winner.toUpperCase()}.`,
      confirmText: 'Registrar walkover',
    });
    if (!ok) return;
    this.busy.set(true);
    const res = await this.mut.post(
      `/matches/${t.match.id}/finish`,
      { id: newId(), at: new Date().toISOString(), winner, method: 'walkover', time_over: true },
      { success: 'Enfrentamiento cerrado por walkover' },
    );
    this.busy.set(false);
    if (!res) return;
    await this.load();
    this.changed.emit();
  }

  winnerOf(b: TeamBout): Color | null {
    const m = b.match;
    if (m.status !== 'finished' || !m.winner_registration_id) return null;
    return m.winner_registration_id === m.aka_registration_id ? 'aka' : 'ao';
  }

  resultText(b: TeamBout): string {
    const m = b.match;
    const score = `${m.aka_score ?? 0}–${m.ao_score ?? 0}`;
    if (m.status === 'finished') {
      if (m.method === 'draw') return `Hikiwake ${score}`;
      return score;
    }
    if (m.status === 'in_progress') return `En curso · ${score}`;
    const t = this.team();
    return t?.match.status === 'finished' ? 'No disputado' : 'Por disputar';
  }
}
