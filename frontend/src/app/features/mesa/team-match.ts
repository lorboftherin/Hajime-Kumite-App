import {
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
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
      <section
        i18n-aria-label="@@mesa.equipos.enfrentamiento-equipos"
        class="team"
        aria-label="Enfrentamiento por equipos"
      >
        <div class="tscore">
          @for (c of colors; track c) {
            <div
              class="tside {{ c }}"
              [class.win]="d.winner === c"
              [class.lose]="!!d.winner && d.winner !== c"
            >
              <span class="tlabel"
                >{{ c === 'aka' ? 'AKA' : 'AO' }}
                <span aria-hidden="true">{{ c === 'aka' ? '赤' : '青' }}</span></span
              >
              <span class="tname">{{ t[c]?.name ?? '—' }}</span>
              <span class="tdojo">{{ t[c]?.dojo_name }}</span>
              @if (d.winner === c) {
                <span class="seal" aria-hidden="true">勝</span>
              }
            </div>
            @if (c === 'aka') {
              <div i18n-aria-label="@@mesa.equipos.victorias" class="twins" aria-label="Victorias">
                <div class="nums">
                  <span class="n">{{ d.wins.aka }}</span
                  ><span class="dash">–</span><span class="n">{{ d.wins.ao }}</span>
                </div>
                <span i18n="@@mesa.equipos.victorias-2" class="tsub">victorias</span>
                <span class="tsub"
                  ><ng-container i18n="@@mesa.equipos.puntos"
                    >puntos {{ d.points.aka }}–{{ d.points.ao }}</ng-container
                  >
                  @if (d.draws) {
                    ·
                    <ng-container i18n="@@mesa.equipos.n-empates">{d.draws, plural,
                      =1 {1 empate}
                      other {{{ d.draws }} empates}
                    }</ng-container>
                  }
                </span>
              </div>
            }
          }
        </div>

        <p class="tstate {{ stateTone() }}" role="status">{{ stateText() }}</p>

        @if (editing()) {
          <div class="panel">
            <div class="panel-head">
              <h3 i18n="@@mesa.equipos.alineacion">Alineación</h3>
              <p
                ><ng-container i18n="@@mesa.equipos.quien-pelea-cada-combate">
                  Quién pelea cada combate.
                </ng-container>
                @if (t.settings.lock_order !== false) {
                  <ng-container i18n="@@mesa.equipos.orden-queda-fijo-empezar-primer">
                    El orden queda fijo al empezar el primer combate.
                  </ng-container>
                } @else {
                  <ng-container i18n="@@mesa.equipos.puede-cambiar-mientras-combate">
                    Se puede cambiar mientras el combate no haya empezado.
                  </ng-container>
                }
                @if (t.settings.empty_slot_walkover !== false) {
                  <ng-container i18n="@@mesa.equipos.puesto-vacio-walkover-para-rival">
                    Un puesto vacío es walkover para el rival.
                  </ng-container>
                }
                @if (t.settings.min_starters) {
                  <ng-container i18n="@@mesa.equipos.minimo-integrantes-equipo">
                    Mínimo {{ t.settings.min_starters }} integrantes por equipo.
                  </ng-container>
                }
              </p>
            </div>
            @for (row of draft(); track $index; let i = $index) {
              <div class="lrow" [class.locked]="row.locked">
                <span class="bn">{{ i + 1 }}</span>
                <select
                  [(ngModel)]="row.aka"
                  [disabled]="row.locked"
                  [attr.aria-label]="ariaCombate('AKA', i + 1)"
                >
                  <option i18n="@@mesa.equipos.definir" [ngValue]="null">— Por definir —</option>
                  @for (m of t.aka?.members ?? []; track m.person_id) {
                    <option [ngValue]="m.person_id">{{ memberLabel(m) }}</option>
                  }
                </select>
                <span i18n="@@mesa.equipos.vs" class="vs">vs</span>
                <select
                  [(ngModel)]="row.ao"
                  [disabled]="row.locked"
                  [attr.aria-label]="ariaCombate('AO', i + 1)"
                >
                  <option i18n="@@mesa.equipos.definir" [ngValue]="null">— Por definir —</option>
                  @for (m of t.ao?.members ?? []; track m.person_id) {
                    <option [ngValue]="m.person_id">{{ memberLabel(m) }}</option>
                  }
                </select>
              </div>
            }
            <div class="actions">
              @if (t.bouts.length) {
                <button i18n="@@mesa.equipos.cancelar" class="qbtn" (click)="editing.set(false)"
                  >Cancelar</button
                >
              }
              <button
                i18n="@@mesa.equipos.guardar-confirmar-alineacion"
                class="qbtn primary"
                [disabled]="busy()"
                (click)="saveLineup()"
              >
                @if (t.bouts.length) {
                  Guardar alineación
                } @else {
                  Confirmar alineación
                }
              </button>
            </div>
          </div>
        } @else {
          <ol class="bouts">
            @for (b of t.bouts; track b.match.id) {
              <li
                class="bout st-{{ b.match.status }}"
                [class.extra]="b.is_extra"
                [class.next]="b.match.id === nextBoutId()"
              >
                <span class="bn">
                  @if (b.is_extra) {
                    <ng-container i18n="@@mesa.equipos.extra">Extra</ng-container>
                  } @else {
                    <ng-container i18n="@@mesa.combate-n"
                      >Combate {{ b.match.bout_number }}</ng-container
                    >
                  }
                </span>
                <span class="p aka" [class.won]="winnerOf(b) === 'aka'">{{
                  b.aka_name ?? txtPorDefinir
                }}</span>
                <span class="res">{{ resultText(b) }}</span>
                <span class="p ao" [class.won]="winnerOf(b) === 'ao'">{{
                  b.ao_name ?? txtPorDefinir
                }}</span>
                <a
                  class="qbtn"
                  [class.primary]="b.match.id === nextBoutId()"
                  [routerLink]="['/mesa', b.match.id]"
                  [queryParams]="linkParams()"
                >
                  <ng-container i18n="@@mesa.equipos.ver-operar">{b.match.status, select,
                    finished {Ver}
                    other {Operar}
                  }</ng-container>
                  <span aria-hidden="true">→</span>
                </a>
              </li>
            }
          </ol>
          <div class="actions">
            @if (canEditLineup()) {
              <button i18n="@@mesa.equipos.editar-alineacion" class="qbtn" (click)="startEdit()"
                >Editar alineación</button
              >
            }
          </div>
        }

        @if (d.needs_extra_bout && !editing()) {
          <div class="panel extra">
            <div class="panel-head">
              <h3 i18n="@@mesa.equipos.combate-extra">Combate extra</h3>
              <p i18n="@@mesa.equipos.elige-representantes-cada-equipo"
                >{{ d.reason }}. Elige a los representantes de cada equipo.</p
              >
            </div>
            <div class="lrow">
              <span i18n="@@mesa.equipos.x" class="bn">X</span>
              <select
                i18n-aria-label="@@mesa.equipos.aka-combate-extra"
                [(ngModel)]="extraAka"
                aria-label="AKA, combate extra"
              >
                <option i18n="@@mesa.equipos.definir" [ngValue]="null">— Por definir —</option>
                @for (m of t.aka?.members ?? []; track m.person_id) {
                  <option [ngValue]="m.person_id">{{ memberLabel(m) }}</option>
                }
              </select>
              <span i18n="@@mesa.equipos.vs" class="vs">vs</span>
              <select
                i18n-aria-label="@@mesa.equipos.ao-combate-extra"
                [(ngModel)]="extraAo"
                aria-label="AO, combate extra"
              >
                <option i18n="@@mesa.equipos.definir" [ngValue]="null">— Por definir —</option>
                @for (m of t.ao?.members ?? []; track m.person_id) {
                  <option [ngValue]="m.person_id">{{ memberLabel(m) }}</option>
                }
              </select>
            </div>
            <div class="actions">
              <button
                i18n="@@mesa.equipos.agregar-combate-extra"
                class="qbtn primary"
                [disabled]="busy()"
                (click)="addExtra()"
                >Agregar combate extra</button
              >
            </div>
          </div>
        }

        @if (t.match.status !== 'finished') {
          <details class="rare">
            <summary i18n="@@mesa.equipos.equipo-no-presenta">Un equipo no se presenta</summary>
            <p i18n="@@mesa.equipos.cierra-enfrentamiento-walkover"
              >Cierra el enfrentamiento por walkover sin combates individuales.</p
            >
            <div class="actions">
              <button
                i18n="@@mesa.equipos.aka-no-presenta"
                class="qbtn"
                [disabled]="busy()"
                (click)="walkover('aka')"
                >AKA no se presenta</button
              >
              <button
                i18n="@@mesa.equipos.ao-no-presenta"
                class="qbtn"
                [disabled]="busy()"
                (click)="walkover('ao')"
                >AO no se presenta</button
              >
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
  readonly txtPorDefinir = $localize`:@@comun.por-definir:Por definir`;
  ariaCombate = (color: string, n: number) =>
    $localize`:@@mesa.equipos.color-combate:${color}:color:, combate ${n}:n:`;
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
    return (
      !!t &&
      t.match.status !== 'finished' &&
      t.bouts.some((b) => !b.is_extra && b.match.status === 'ready')
    );
  });

  readonly stateText = computed(() => {
    const t = this.team();
    if (!t) return '';
    const d = t.decision;
    if (t.match.status === 'finished' && t.match.winner_registration_id) {
      const color: Color = t.match.winner_registration_id === t.aka?.registration_id ? 'aka' : 'ao';
      const how = METHOD_LABEL[t.match.method ?? ''] ?? t.match.method;
      return $localize`:@@mesa.equipos.gana:Gana ${color.toUpperCase()}:color: · ${t[color]?.name ?? ''}:equipo: por ${how}:metodo:`;
    }
    if (!t.bouts.length)
      return $localize`:@@mesa.equipos.define-alineacion-combates:Define la alineación: ${t.settings.bouts}:bouts: combates por enfrentamiento.`;
    if (d.needs_extra_bout)
      return d.reason ?? $localize`:@@mesa.equipos.empate-combate-extra:Empate: combate extra`;
    if (d.extra_bout_needs_hantei)
      return (
        d.reason ??
        $localize`:@@mesa.equipos.combate-extra-empatado-decide:Combate extra empatado: decide por hantei`
      );
    if (d.pending_bouts === 1)
      return $localize`:@@mesa.equipos.falta-1-combate:Falta 1 combate. Gana el equipo con más victorias.`;
    if (d.pending_bouts)
      return $localize`:@@mesa.equipos.faltan-combates:Faltan ${d.pending_bouts}:faltan: combates. Gana el equipo con más victorias.`;
    return $localize`:@@mesa.equipos.combate-extra-curso:Combate extra en curso`;
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
        regular.map((b) => ({
          aka: b.aka_person_id,
          ao: b.ao_person_id,
          locked: b.match.status !== 'ready',
        })),
      );
    } else {
      // Propuesta inicial: los titulares en el orden en que se inscribieron.
      const starters = (side: 'aka' | 'ao') =>
        (t[side]?.members ?? []).filter((m) => m.role === 'starter');
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
      {
        bouts: this.draft().map((r) => ({ aka_person_id: r.aka, ao_person_id: r.ao })),
        version: t.match.version,
      },
      {
        success: $localize`:@@mesa.equipos.alineacion-guardada:Alineación guardada`,
        onConflict: () => this.load(),
      },
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
      {
        bouts: [{ aka_person_id: this.extraAka, ao_person_id: this.extraAo }],
        extra: true,
        version: t.match.version,
      },
      {
        success: $localize`:@@mesa.equipos.combate-extra-agregado:Combate extra agregado`,
        onConflict: () => this.load(),
      },
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
      title: $localize`:@@mesa.equipos.walkover-equipo:Walkover del equipo`,
      message: $localize`:@@mesa.equipos.no-presenta-gana:${t[absent]?.name ?? absent.toUpperCase()}:ausente: no se presenta. Gana ${t[winner]?.name ?? winner.toUpperCase()}:ganador:.`,
      confirmText: $localize`:@@mesa.equipos.registrar-walkover:Registrar walkover`,
    });
    if (!ok) return;
    this.busy.set(true);
    const res = await this.mut.post(
      `/matches/${t.match.id}/finish`,
      { id: newId(), at: new Date().toISOString(), winner, method: 'walkover', time_over: true },
      {
        success: $localize`:@@mesa.equipos.enfrentamiento-cerrado-walkover:Enfrentamiento cerrado por walkover`,
      },
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
      if (m.method === 'draw') return $localize`:@@mesa.equipos.hikiwake:Hikiwake ${score}:score:`;
      return score;
    }
    if (m.status === 'in_progress')
      return $localize`:@@mesa.equipos.curso:En curso · ${score}:score:`;
    const t = this.team();
    return t?.match.status === 'finished'
      ? $localize`:@@mesa.equipos.no-disputado:No disputado`
      : $localize`:@@mesa.equipos.disputar:Por disputar`;
  }
}
