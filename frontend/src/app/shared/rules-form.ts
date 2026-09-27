import { Component, Input, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../core/api.service';
import { RR_CRITERIA_LABEL } from '../core/format';
import { RulesDefaults } from '../core/models';

/**
 * Formularios de las reglas deportivas configurables (docs/reglas-configurables.md):
 * kumite, kumite por equipos, kata y llaves. En modo «category» cada campo
 * vacío hereda el valor del torneo; en modo «tournament» el valor por defecto
 * del sistema. Los objetos recibidos se editan en el lugar; quien los usa
 * limpia los vacíos con `cleanRules` / `kataPayload` al guardar.
 */
@Component({
  selector: 'app-rules-form',
  imports: [FormsModule],
  template: `
    @if (showKumite) {
      <fieldset>
        <legend i18n="@@reglas.kumite">Kumite</legend>
        <div class="grid-3">
          @if (mode === 'tournament') {
            <label class="field">
              <span i18n="@@reglas.duracion-seg">Duración (seg)</span>
              <input
                type="number"
                min="10"
                name="dur"
                [(ngModel)]="kumite['duration_seconds']"
                [placeholder]="ph('kumite', 'duration_seconds')"
              />
            </label>
          }
          <label class="field">
            <span i18n="@@reglas.tipo-tiempo">Tipo de tiempo</span>
            <select name="tm" [(ngModel)]="kumite['time_mode']">
              <option [ngValue]="undefined">{{ inherit }}</option>
              <option i18n="@@reglas.efectivo" value="effective">Efectivo</option>
              <option i18n="@@reglas.corrido" value="running">Corrido</option>
            </select>
          </label>
          <label class="field">
            <span i18n="@@reglas.victoria-diferencia">Victoria por diferencia</span>
            <input
              type="number"
              min="0"
              name="lv"
              [(ngModel)]="kumite['lead_victory']"
              [placeholder]="ph('kumite', 'lead_victory')"
            />
            <span i18n="@@reglas.0-desactivada" class="hint">0 = desactivada</span>
          </label>
          <label class="field">
            <span i18n="@@reglas.empate">Empate</span>
            <select name="tie" [(ngModel)]="kumite['tie_rule']">
              <option [ngValue]="undefined">{{ inherit }}</option>
              <option i18n="@@reglas.hantei-jueces" value="hantei">Hantei (jueces)</option>
              <option i18n="@@reglas.punto-oro" value="golden_point">Punto de oro</option>
              <option i18n="@@reglas.senshu-luego-hantei" value="senshu_hantei"
                >Senshu y luego hantei</option
              >
            </select>
          </label>
          <label class="field">
            <span i18n="@@reglas.punto-oro-seg">Punto de oro (seg)</span>
            <input
              type="number"
              min="0"
              name="gps"
              [(ngModel)]="kumite['golden_point_seconds']"
              [placeholder]="ph('kumite', 'golden_point_seconds')"
            />
            <span i18n="@@reglas.0-sin-limite-tiempo" class="hint">0 = sin límite de tiempo</span>
          </label>
          <div class="field">
            <span i18n="@@reglas.puntos-validos">Puntos válidos</span>
            <div class="row checks">
              @for (v of [1, 2, 3]; track v) {
                <label class="field inline small">
                  <input
                    type="checkbox"
                    [name]="'pv' + v"
                    [ngModel]="hasPoint(v)"
                    (ngModelChange)="togglePoint(v, $event)"
                  />
                  {{ pointName[v] }}
                </label>
              }
            </div>
            @if (mode === 'category' && !kumite['point_values']) {
              <span i18n="@@reglas.sin-marcar-hereda-torneo" class="hint"
                >Sin marcar: hereda del torneo</span
              >
            }
          </div>
          <label class="field">
            <span i18n="@@reglas.faltas">Faltas</span>
            <select name="sp" [(ngModel)]="kumite['sanction_preset']">
              <option [ngValue]="undefined">{{ inherit }}</option>
              <option i18n="@@reglas.escalera" value="single">Una escalera</option>
              <option i18n="@@reglas.dos-categorias-contacto-resto" value="two_categories"
                >Dos categorías (contacto / resto)</option
              >
            </select>
          </label>
          <label class="field">
            <span i18n="@@reglas.senshu-perdido-automaticamente"
              >Senshu perdido automáticamente</span
            >
            <select name="sal" [(ngModel)]="kumite['senshu_auto_loss']">
              <option [ngValue]="undefined">{{ inherit }}</option>
              <option i18n="@@reglas.si" [ngValue]="true">Sí</option>
              <option i18n="@@reglas.no-mesa-retira" [ngValue]="false"
                >No (la mesa lo retira)</option
              >
            </select>
          </label>
          <label class="field">
            <span i18n="@@reglas.sancion-desde-nivel">…con sanción desde el nivel</span>
            <input
              type="number"
              min="1"
              name="sll"
              [(ngModel)]="kumite['senshu_loss_level']"
              [placeholder]="ph('kumite', 'senshu_loss_level')"
            />
          </label>
          <label class="field">
            <span i18n="@@reglas.ultimos-seg">…en los últimos (seg)</span>
            <input
              type="number"
              min="1"
              name="sls"
              [(ngModel)]="kumite['senshu_loss_last_seconds']"
              [placeholder]="ph('kumite', 'senshu_loss_last_seconds')"
            />
          </label>
        </div>
      </fieldset>
      @if (showTeam) {
        <fieldset>
          <legend i18n="@@reglas.kumite-equipos">Kumite por equipos</legend>
          <div class="grid-3">
            <label class="field">
              <span i18n="@@reglas.combates-enfrentamiento">Combates por enfrentamiento</span>
              <select name="tb" [(ngModel)]="kumite['team_bouts']">
                <option [ngValue]="undefined">{{ inherit }}</option>
                <option [ngValue]="3">3</option>
                <option [ngValue]="5">5</option>
              </select>
            </label>
            <label class="field">
              <span i18n="@@reglas.empate-victorias">Empate en victorias</span>
              <select name="ttr" [(ngModel)]="kumite['team_tie_rule']">
                <option [ngValue]="undefined">{{ inherit }}</option>
                <option i18n="@@reglas.mas-puntos-si-empatan-combate" value="points"
                  >Más puntos; si empatan, combate extra</option
                >
                <option i18n="@@reglas.combate-extra" value="extra_bout">Combate extra</option>
              </select>
            </label>
            <label class="field">
              <span i18n="@@reglas.combate-extra-empatado">Combate extra empatado</span>
              <select name="tet" [(ngModel)]="kumite['team_extra_bout_tie']">
                <option [ngValue]="undefined">{{ inherit }}</option>
                <option i18n="@@reglas.hantei-ese-combate-wkf" value="hantei"
                  >Hantei en ese combate (WKF)</option
                >
                <option i18n="@@reglas.otro-combate-extra" value="repeat"
                  >Otro combate extra</option
                >
              </select>
            </label>
            <label class="field">
              <span i18n="@@reglas.puesto-vacio-alineacion">Puesto vacío en la alineación</span>
              <select name="tes" [(ngModel)]="kumite['team_empty_slot_walkover']">
                <option [ngValue]="undefined">{{ inherit }}</option>
                <option i18n="@@reglas.walkover-rival" [ngValue]="true">Walkover del rival</option>
                <option i18n="@@reglas.disputa-igual" [ngValue]="false">Se disputa igual</option>
              </select>
            </label>
            <label class="field">
              <span i18n="@@reglas.orden-declarado">Orden declarado</span>
              <select name="tlo" [(ngModel)]="kumite['team_lock_order']">
                <option [ngValue]="undefined">{{ inherit }}</option>
                <option i18n="@@reglas.bloqueado-empezar" [ngValue]="true"
                  >Bloqueado al empezar</option
                >
                <option i18n="@@reglas.editable" [ngValue]="false">Editable</option>
              </select>
            </label>
            <label class="field">
              <span i18n="@@reglas.minimo-titulares">Mínimo de titulares</span>
              <input
                i18n-placeholder="@@reglas.sin-minimo"
                type="number"
                min="1"
                name="tms"
                [(ngModel)]="kumite['team_min_starters']"
                placeholder="Sin mínimo"
              />
            </label>
          </div>
        </fieldset>
      }
    }

    @if (showKata) {
      <fieldset>
        <legend i18n="@@reglas.kata">Kata</legend>
        <div class="grid-3">
          <label class="field">
            <span i18n="@@reglas.metodo">Método</span>
            <select name="km" [(ngModel)]="kata['method']">
              <option [ngValue]="undefined">{{ inherit }}</option>
              <option i18n="@@reglas.banderas" value="flags">Banderas</option>
              <option i18n="@@reglas.puntuacion" value="scores">Puntuación</option>
            </select>
          </label>
          <label class="field">
            <span i18n="@@reglas.estructura">Estructura</span>
            <select name="ks" [(ngModel)]="kata['structure']">
              <option [ngValue]="undefined">{{ inherit }}</option>
              <option i18n="@@reglas.llave-aka-vs-ao" value="bracket">Llave (aka vs ao)</option>
              <option i18n="@@reglas.rondas" value="rounds">Rondas</option>
            </select>
          </label>
          <label class="field">
            <span i18n="@@reglas.preset">Preset</span>
            <select name="kp" [(ngModel)]="kata['preset']">
              <option [ngValue]="undefined">{{
                mode === 'category' ? inherit : txtNinguno
              }}</option>
              <option i18n="@@reglas.wkf-7-jueces-2-2-descartes" value="wkf"
                >WKF: 7 jueces, 2+2 descartes, técnico/atlético</option
              >
            </select>
          </label>
          <label class="field">
            <span i18n="@@reglas.jueces">Jueces</span>
            <select name="kj" [(ngModel)]="kata['judges']">
              <option [ngValue]="undefined">{{ inherit }}</option>
              <option [ngValue]="3">3</option>
              <option [ngValue]="5">5</option>
              <option [ngValue]="7">7</option>
            </select>
          </label>
          <label class="field">
            <span i18n="@@reglas.descartes-extremo">Descartes por extremo</span>
            <select name="kd" [(ngModel)]="kata['discard_each_side']">
              <option i18n="@@reglas.1-0-3-jueces" [ngValue]="undefined"
                >{{ inherit }} (1; 0 con 3 jueces)</option
              >
              <option [ngValue]="0">0</option>
              <option [ngValue]="1">1</option>
              <option [ngValue]="2">2</option>
            </select>
          </label>
          <label class="field">
            <span i18n="@@reglas.notas-tecnico-atleticas">Notas técnico / atléticas</span>
            <select name="ksp" [(ngModel)]="kata['split']">
              <option [ngValue]="undefined">{{ inherit }}</option>
              <option i18n="@@reglas.si-70-30" [ngValue]="true">Sí (70 / 30)</option>
              <option i18n="@@reglas.no-nota-juez" [ngValue]="false">No, una nota por juez</option>
            </select>
          </label>
          @if (mode === 'tournament') {
            <label class="field">
              <span i18n="@@reglas.nota-minima">Nota mínima</span>
              <input name="kmin" [(ngModel)]="kata['min_score']" placeholder="5.0" />
            </label>
            <label class="field">
              <span i18n="@@reglas.nota-maxima">Nota máxima</span>
              <input name="kmax" [(ngModel)]="kata['max_score']" placeholder="10.0" />
            </label>
          }
          <label class="field">
            <span i18n="@@reglas.rondas-cuantos-pasan">Rondas: cuántos pasan</span>
            <input
              i18n-placeholder="@@reglas.ronda-unica-p-ej-8-4"
              name="kr"
              [(ngModel)]="kata['_rounds_text']"
              placeholder="Ronda única · p. ej. 8, 4"
            />
            <span i18n="@@reglas.clasificados-ronda-antes-final" class="hint"
              >Clasificados por ronda antes de la final</span
            >
          </label>
          <label class="field">
            <span i18n="@@reglas.grupos-1-ronda">Grupos en la 1.ª ronda</span>
            <select name="kg" [(ngModel)]="kata['first_round_groups']">
              <option [ngValue]="undefined">{{ inherit }}</option>
              <option [ngValue]="1">1</option>
              <option [ngValue]="2">2</option>
              <option [ngValue]="4">4</option>
            </select>
          </label>
          <label class="field">
            <span i18n="@@reglas.orden-salida-2-ronda-adelante"
              >Orden de salida (2.ª ronda en adelante)</span
            >
            <select name="ko" [(ngModel)]="kata['round_order']">
              <option [ngValue]="undefined">{{ inherit }}</option>
              <option i18n="@@reglas.mejor-sale-ultimo-wkf" value="reverse_rank"
                >El mejor sale último (WKF)</option
              >
              <option i18n="@@reglas.mejor-sale-primero" value="rank">El mejor sale primero</option>
              <option i18n="@@reglas.sorteo" value="random">Sorteo</option>
            </select>
          </label>
          <label class="field">
            <span i18n="@@reglas.no-repetir-kata">No repetir kata</span>
            <select name="knr" [(ngModel)]="kata['no_repeat_kata']">
              <option [ngValue]="undefined">{{ inherit }}</option>
              <option i18n="@@reglas.advertir-si-repite" [ngValue]="true"
                >Advertir si repite</option
              >
              <option i18n="@@reglas.permite-repetir" [ngValue]="false">Se permite repetir</option>
            </select>
          </label>
        </div>
      </fieldset>
    }

    @if (showCompetition) {
      <fieldset>
        <legend i18n="@@reglas.llaves-clasificacion">Llaves y clasificación</legend>
        <div class="grid-2">
          <div class="field">
            <span i18n="@@reglas.desempate-round-robin-orden"
              >Desempate de round robin (en orden)</span
            >
            <ol class="criteria">
              @for (c of criteriaList(); track c.key; let i = $index; let l = $last) {
                <li [class.off]="!c.on">
                  <label class="field inline small">
                    <input
                      type="checkbox"
                      [name]="'rr' + c.key"
                      [ngModel]="c.on"
                      (ngModelChange)="toggleCriterion(c.key, $event)"
                    />
                    {{ criteriaLabel[c.key] }}
                  </label>
                  <span class="spacer"></span>
                  <button
                    i18n-aria-label="@@reglas.subir"
                    type="button"
                    class="btn sm ghost icon-only"
                    [disabled]="i === 0"
                    (click)="moveCriterion(i, -1)"
                    aria-label="Subir"
                  >
                    ↑
                  </button>
                  <button
                    i18n-aria-label="@@reglas.bajar"
                    type="button"
                    class="btn sm ghost icon-only"
                    [disabled]="l"
                    (click)="moveCriterion(i, 1)"
                    aria-label="Bajar"
                  >
                    ↓
                  </button>
                </li>
              }
            </ol>
            @if (mode === 'category' && !competition['round_robin_criteria']) {
              <span i18n="@@reglas.sin-cambios-hereda-orden-torneo" class="hint"
                >Sin cambios: hereda el orden del torneo</span
              >
            }
          </div>
          <div class="stack">
            <label class="field">
              <span i18n="@@reglas.bronces-round-robin">Bronces en round robin</span>
              <select name="rrb" [(ngModel)]="competition['round_robin_bronzes']">
                <option [ngValue]="undefined">{{ inherit }}</option>
                <option i18n="@@reglas.uno-3" [ngValue]="1">Uno (el 3.º)</option>
                <option i18n="@@reglas.dos-3-4-desde-5-inscritos" [ngValue]="2"
                  >Dos (3.º y 4.º) desde 5 inscritos</option
                >
              </select>
            </label>
            <div class="field">
              <span i18n="@@reglas.no-pasan-repechaje-quienes"
                >No pasan al repechaje quienes perdieron por</span
              >
              <div class="row checks">
                @for (m of repechageMethods; track m.key) {
                  <label class="field inline small">
                    <input
                      type="checkbox"
                      [name]="'rep' + m.key"
                      [ngModel]="hasExcluded(m.key)"
                      (ngModelChange)="toggleExcluded(m.key, $event)"
                    />
                    {{ m.label }}
                  </label>
                }
              </div>
            </div>
            <label class="field">
              <span i18n="@@reglas.separacion-llave">Separación en la llave</span>
              <select
                name="sep"
                [ngModel]="separationValue()"
                (ngModelChange)="setSeparation($event)"
              >
                <option [ngValue]="undefined">{{ inherit }}</option>
                <option i18n="@@reglas.dojo" value="dojo">Por dojo</option>
                <option i18n="@@reglas.dojo-ademas-ciudad" value="city"
                  >Por dojo y, además, por ciudad</option
                >
              </select>
            </label>
            <div class="grid-2">
              <label class="field">
                <span i18n="@@reglas.grupos-grupos-eliminacion">Grupos (grupos + eliminación)</span>
                <input
                  type="number"
                  min="2"
                  max="16"
                  name="gr"
                  [(ngModel)]="competition['groups']"
                  [placeholder]="ph('competition', 'groups')"
                />
              </label>
              <label class="field">
                <span i18n="@@reglas.pasan-grupo">Pasan por grupo</span>
                <input
                  type="number"
                  min="1"
                  max="4"
                  name="gq"
                  [(ngModel)]="competition['group_qualifiers']"
                  [placeholder]="ph('competition', 'group_qualifiers')"
                />
              </label>
            </div>
            <label class="field">
              <span i18n="@@reglas.shikkaku-mesa">Shikkaku en la mesa</span>
              <select name="shk" [(ngModel)]="competition['shikkaku_tournament_wide']">
                <option [ngValue]="undefined">{{ inherit }}</option>
                <option i18n="@@reglas.solo-combate" [ngValue]="false">Solo el combate</option>
                <option i18n="@@reglas.proponer-descalificar-torneo" [ngValue]="true"
                  >Proponer descalificar del torneo</option
                >
              </select>
            </label>
          </div>
        </div>
      </fieldset>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }
    .checks {
      gap: 1rem;
      min-height: 2.5rem;
      align-items: center;
    }
    .criteria {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 0.15rem;
      li {
        display: flex;
        align-items: center;
        gap: 0.35rem;
        padding: 0.15rem 0.4rem;
        border-radius: var(--radius-sm);
        background: var(--kinu);
        &.off {
          opacity: 0.6;
        }
      }
      .spacer {
        flex: 1;
      }
    }
  `,
})
export class RulesForm {
  readonly txtNinguno = $localize`:@@reglas.ninguno:Ninguno`;
  private api = inject(ApiService);

  /** tournament: valores del torneo; category: overrides (vacío = hereda). */
  @Input() mode: 'tournament' | 'category' = 'tournament';
  /** Modalidad de la categoría (null en el torneo: se muestran todas). */
  @Input() modality: 'kumite' | 'kata' | null = null;
  @Input() isTeam = false;
  @Input({ required: true }) kumite!: Record<string, any>;
  @Input({ required: true }) kata!: Record<string, any>;
  @Input({ required: true }) competition!: Record<string, any>;

  readonly defaults = signal<RulesDefaults | null>(null);
  readonly criteriaLabel = RR_CRITERIA_LABEL;
  readonly pointName: Record<number, string> = { 1: 'Yuko', 2: 'Waza-ari', 3: 'Ippon' };
  readonly repechageMethods = [
    { key: 'kiken', label: 'Kiken' },
    { key: 'shikkaku', label: 'Shikkaku' },
    { key: 'hansoku', label: 'Hansoku' },
  ];
  /** Fuerza el recálculo de la lista de criterios (los objetos se editan en el lugar). */
  private readonly tick = signal(0);

  constructor() {
    firstValueFrom(this.api.get<RulesDefaults>('/rules/defaults'))
      .then((d) => this.defaults.set(d))
      .catch(() => {});
  }

  get inherit(): string {
    return this.mode === 'category'
      ? $localize`:@@reglas.heredar-torneo:Heredar del torneo`
      : $localize`:@@reglas.defecto:Por defecto`;
  }
  get showKumite(): boolean {
    return this.modality !== 'kata';
  }
  get showKata(): boolean {
    return this.modality !== 'kumite';
  }
  /** Las reglas de llaves aplican a todas las modalidades. */
  readonly showCompetition = true;
  get showTeam(): boolean {
    return this.mode === 'tournament' || this.isTeam;
  }

  /** Valor por defecto del sistema como pista del campo vacío. */
  ph(group: 'kumite' | 'kata' | 'competition', key: string): string {
    if (this.mode === 'category') return $localize`:@@reglas.heredar:Heredar`;
    const v = this.defaults()?.[group]?.[key];
    return v === undefined || v === null ? '' : $localize`:@@reglas.defecto-2:Por defecto: ${v}:v:`;
  }

  hasPoint(v: number): boolean {
    const pv = this.kumite['point_values'] as number[] | undefined;
    return pv ? pv.includes(v) : this.mode === 'tournament';
  }

  togglePoint(v: number, on: boolean): void {
    const current =
      (this.kumite['point_values'] as number[] | undefined) ??
      (this.mode === 'tournament' ? [1, 2, 3] : []);
    const next = on ? [...new Set([...current, v])].sort() : current.filter((x) => x !== v);
    this.kumite['point_values'] = next.length ? next : undefined;
  }

  criteriaList(): Array<{ key: string; on: boolean }> {
    this.tick();
    const all = this.defaults()?.round_robin_criteria ?? [
      'wins',
      'head_to_head',
      'diff',
      'points_for',
      'fewer_sanctions',
      'draw',
    ];
    const chosen: string[] = this.competition['round_robin_criteria'] ??
      this.defaults()?.competition?.['round_robin_criteria'] ?? [
        'wins',
        'head_to_head',
        'diff',
        'points_for',
      ];
    return [
      ...chosen.map((key) => ({ key, on: true })),
      ...all.filter((k) => !chosen.includes(k)).map((key) => ({ key, on: false })),
    ];
  }

  private setCriteria(list: Array<{ key: string; on: boolean }>): void {
    this.competition['round_robin_criteria'] = list.filter((c) => c.on).map((c) => c.key);
    this.tick.update((x) => x + 1);
  }

  toggleCriterion(key: string, on: boolean): void {
    const list = this.criteriaList().map((c) => (c.key === key ? { ...c, on } : c));
    // Los activos van primero, en su orden.
    this.setCriteria([...list.filter((c) => c.on), ...list.filter((c) => !c.on)]);
  }

  moveCriterion(i: number, dir: -1 | 1): void {
    const list = this.criteriaList();
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    this.setCriteria(list);
  }

  hasExcluded(m: string): boolean {
    const v = this.competition['repechage_excluded_methods'] as string[] | undefined;
    return (
      v ??
      this.defaults()?.competition?.['repechage_excluded_methods'] ?? [
        'kiken',
        'shikkaku',
        'hansoku',
      ]
    ).includes(m);
  }

  toggleExcluded(m: string, on: boolean): void {
    const current = this.repechageMethods.map((x) => x.key).filter((k) => this.hasExcluded(k));
    this.competition['repechage_excluded_methods'] = on
      ? [...new Set([...current, m])]
      : current.filter((x) => x !== m);
  }

  separationValue(): string | undefined {
    const v = this.competition['separation'] as string[] | undefined;
    if (!v) return undefined;
    return v.includes('city') ? 'city' : 'dojo';
  }

  setSeparation(v: string | undefined): void {
    this.competition['separation'] =
      v === undefined ? undefined : v === 'city' ? ['dojo', 'city'] : ['dojo'];
  }
}

/** Quita los campos vacíos (heredan). Devuelve null si no queda nada. */
export function cleanRules(obj: Record<string, any>): Record<string, any> | null {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('_') || v === undefined || v === null || v === '') continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** Reglas de kata listas para enviar: el texto de rondas («8, 4») pasa a lista. */
export function kataPayload(kata: Record<string, any>): Record<string, any> | null {
  const text = String(kata['_rounds_text'] ?? '').trim();
  const rounds = text
    ? text
        .split(/[,\s;]+/)
        .map((x) => Number(x))
        .filter((x) => Number.isFinite(x) && x > 0)
    : undefined;
  return cleanRules({ ...kata, rounds: rounds && rounds.length ? rounds : undefined });
}

/** Copia editable de unas reglas guardadas (con el texto de rondas). */
export function editableKata(kata: Record<string, any> | null | undefined): Record<string, any> {
  const k = { ...(kata ?? {}) };
  if (Array.isArray(k['rounds'])) k['_rounds_text'] = (k['rounds'] as number[]).join(', ');
  delete k['rounds'];
  return k;
}
