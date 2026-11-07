import { Component, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiError } from '../../core/api-error';
import { ApiService } from '../../core/api.service';
import { REGISTRATION_STATUS, fmtDate, matchScoreText, methodText } from '../../core/format';
import { PersonHistory } from '../../core/models';
import { Hanko } from '../../shared/hanko';
import { PersonStatsView } from '../../shared/person-stats';

/** Historial deportivo de una persona (GET /persons/{id}/history). Foto al momento de cada torneo. */
@Component({
  selector: 'app-person-history',
  imports: [RouterLink, Hanko, PersonStatsView],
  template: `
    @if (history(); as h) {
      <div class="summary">
        <section
          i18n-aria-label="@@persona.historial.medallero-personal"
          class="card medals"
          aria-label="Medallero personal"
        >
          <h3 i18n="@@persona.historial.medallero">Medallero</h3>
          <div class="medal-row">
            <div class="medal"
              ><app-hanko [place]="1" size="lg" /><div
                ><span class="figure">{{ h.medals.gold }}</span
                ><span i18n="@@persona.historial.oro" class="small muted">Oro</span></div
              ></div
            >
            <div class="medal"
              ><app-hanko [place]="2" size="lg" /><div
                ><span class="figure">{{ h.medals.silver }}</span
                ><span i18n="@@persona.historial.plata" class="small muted">Plata</span></div
              ></div
            >
            <div class="medal"
              ><app-hanko [place]="3" size="lg" /><div
                ><span class="figure">{{ h.medals.bronze }}</span
                ><span i18n="@@persona.historial.bronce" class="small muted">Bronce</span></div
              ></div
            >
            <div class="medal total"
              ><div
                ><span class="figure">{{ h.tournaments.length }}</span
                ><span i18n="@@persona.historial.categorias-disputadas" class="small muted"
                  >Categorías disputadas</span
                ></div
              ></div
            >
          </div>
        </section>
        <section class="card grades">
          <h3 i18n="@@persona.historial.grados">Grados</h3>
          @if (h.grades.length) {
            <ol class="timeline">
              @for (g of h.grades; track $index; let last = $last) {
                <li [class.current]="last">
                  <span class="grade">{{ g.grade }}</span>
                  <span class="when">
                    @if (g.awarded_on) {
                      {{ fdate(g.awarded_on) }}
                    } @else {
                      <ng-container i18n="@@persona.historial.fecha-no-registrada"
                        >fecha no registrada</ng-container
                      >
                    }
                  </span>
                  @if (last) {
                    <span i18n="@@persona.historial.vigente" class="badge sumi">vigente</span>
                  }
                </li>
              }
            </ol>
          } @else {
            <p i18n="@@persona.historial.sin-grados-registrados" class="muted small"
              >Sin grados registrados.</p
            >
          }
        </section>
      </div>

      <app-person-stats [personId]="personId()" />

      <h2 i18n="@@persona.historial.torneos" class="section-title">Torneos</h2>
      @for (t of h.tournaments; track t.tournament_id + '-' + t.category_id) {
        <article class="card tour">
          <div class="tour-head">
            <div class="grow">
              <div class="eyebrow num">{{ fdate(t.date) }}</div>
              <h3
                ><a [routerLink]="links() ? ['/torneos', t.tournament_id] : null">{{
                  t.tournament_name
                }}</a></h3
              >
              <div class="small cat">
                <a [routerLink]="links() ? ['/categorias', t.category_id, 'llave'] : null">{{
                  t.category_name
                }}</a>
                @if (t.merged) {
                  <span
                    i18n="@@persona.historial.categoria-fusionada"
                    i18n-title="@@persona.historial.categoria-original-fusiono-otra"
                    class="badge nezumi"
                    title="La categoría original se fusionó con otra"
                    >Categoría fusionada</span
                  >
                }
                @if (t.status !== 'active') {
                  <span class="badge yamabuki">{{ regStatus[t.status] || t.status }}</span>
                }
              </div>
              <div class="small muted">
                @if (t.team_name) {
                  <ng-container i18n="@@persona.historial.equipo">
                    Equipo <strong>{{ t.team_name }}</strong> · {{ t.dojo_name || sinDojo }}
                  </ng-container>
                } @else {
                  {{ t.dojo_name || sinDojo }} · {{ t.grade || gradoSinDato }}
                  @if (t.weight_class) {
                    · {{ t.weight_class }}
                  }
                }
              </div>
            </div>
            <div class="place">
              @if (t.place && t.place <= 3) {
                <app-hanko [place]="t.place" [withLabel]="true" size="lg" />
              } @else {
                <span class="muted small">
                  @if (t.place) {
                    <ng-container i18n="@@comun.puesto-n">{{ t.place }}.º puesto</ng-container>
                  } @else {
                    <ng-container i18n="@@formato.sin-puesto">Sin puesto</ng-container>
                  }
                </span>
              }
            </div>
          </div>
          @if (t.matches.length) {
            <table class="table small flush fights">
              <thead
                ><tr
                  ><th><span i18n="@@persona.historial.color" class="sr-only">Color</span></th
                  ><th i18n="@@persona.historial.combate">Combate</th
                  ><th i18n="@@persona.historial.resultado">Resultado</th
                  ><th i18n="@@persona.historial.marcador" class="center">Marcador</th
                  ><th i18n="@@persona.historial.rival">Rival</th
                  ><th i18n="@@persona.historial.forma">Forma</th></tr
                ></thead
              >
              <tbody>
                @for (m of t.matches; track m.match_id) {
                  <tr>
                    <td class="color"
                      ><span
                        class="strip"
                        [class.aka]="m.color === 'aka'"
                        [class.ao]="m.color === 'ao'"
                        [title]="m.color === 'aka' ? 'Aka' : 'Ao'"
                      ></span
                      ><span class="sr-only">{{ m.color === 'aka' ? 'Aka' : 'Ao' }}</span></td
                    >
                    <td
                      ><a
                        i18n-title="@@persona.historial.hoja-combate"
                        class="code"
                        [routerLink]="['/combates', m.match_id]"
                        title="Hoja del combate"
                        >{{ m.code }}</a
                      ></td
                    >
                    <td>
                      @if (m.method === 'draw') {
                        <span i18n="@@persona.historial.empate" class="badge plain">Empate</span>
                      } @else if (m.won) {
                        <span i18n="@@persona.historial.gano" class="badge matcha">Ganó</span>
                      } @else {
                        <span i18n="@@persona.historial.perdio" class="badge nezumi">Perdió</span>
                      }
                    </td>
                    <td
                      class="center nowrap score"
                      [class.muted]="m.method === 'flags'"
                      [class.flags]="m.method === 'flags'"
                      >{{ score(m.score, m.method) }}</td
                    >
                    <td>
                      {{ m.opponent || '—' }}
                      @if (m.opponent_dojo) {
                        <span class="muted"> · {{ m.opponent_dojo }}</span>
                      }
                    </td>
                    <td class="muted">{{ method(m.method) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <p i18n="@@persona.historial.sin-combates-finalizados-esta" class="muted small nofights"
              >Sin combates finalizados en esta categoría.</p
            >
          }
        </article>
      } @empty {
        <div class="card empty">
          <p
            ><strong i18n="@@persona.historial.aun-no-tiene-torneos-historial"
              >Aún no tiene torneos en su historial.</strong
            ></p
          >
          <p i18n="@@persona.historial.torneos-prueba-no-aparecen" class="small"
            >Los torneos de prueba no aparecen en el historial. Solo cuentan los torneos
            oficiales.</p
          >
        </div>
      }
    } @else if (error()) {
      <div class="alert danger">{{ error() }}</div>
    } @else {
      <div class="empty"><span class="spinner"></span></div>
    }
  `,
  styles: `
    .summary {
      display: grid;
      grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
      gap: 1.25rem;
      margin-bottom: 1.5rem;
      .card {
        margin: 0;
      }
    }
    @media (max-width: 900px) {
      .summary {
        grid-template-columns: 1fr;
      }
    }
    .medals {
      display: flex;
      flex-direction: column;
    }
    .medal-row {
      margin: auto 0;
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 1rem;
    }
    @media (max-width: 560px) {
      .medal-row {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
    .medal {
      display: flex;
      align-items: center;
      gap: 0.85rem;
      > div {
        display: flex;
        flex-direction: column;
        line-height: 1.15;
      }
      .figure {
        font-size: var(--fs-28);
      }
      &.total {
        padding-left: 1rem;
        border-left: 1px solid var(--kasumi);
      }
    }
    /* Línea de tinta vertical con un punto por grado. */
    .timeline {
      list-style: none;
      margin: 0;
      padding: 0 0 0 1.25rem;
      position: relative;
      &::before {
        content: '';
        position: absolute;
        left: 0.3rem;
        top: 0.7rem;
        bottom: 0.7rem;
        width: 1.5px;
        background: linear-gradient(var(--kasumi-2), var(--sumi));
        border-radius: 1px;
      }
      li {
        position: relative;
        display: flex;
        flex-wrap: wrap;
        gap: 0.2rem 0.75rem;
        align-items: baseline;
        padding: 0.35rem 0;
      }
      li::before {
        content: '';
        position: absolute;
        left: calc(-1.25rem + 0.3rem - 4px);
        top: 0.8rem;
        width: 9px;
        height: 9px;
        border-radius: 50%;
        background: var(--kinu);
        border: 1.5px solid var(--nezumi);
      }
      li.current::before {
        left: calc(-1.25rem + 0.3rem - 6px);
        top: 0.7rem;
        width: 13px;
        height: 13px;
        background: var(--sumi);
        border-color: var(--sumi);
        box-shadow: 0 0 0 3px var(--kinu);
      }
      .grade {
        font-weight: 700;
      }
      li:not(.current) .grade {
        font-weight: 500;
        color: var(--sumi-2);
      }
      .when {
        font-size: var(--fs-14);
        color: var(--nezumi-ink);
        font-variant-numeric: tabular-nums;
      }
    }
    .tour {
      margin-bottom: 1rem;
    }
    .tour-head {
      display: flex;
      gap: 1.5rem;
      align-items: flex-start;
      h3 {
        margin: 0.15rem 0 0.3rem;
        font-family: var(--font-display);
        font-size: var(--fs-20);
        a {
          color: var(--sumi);
        }
        a:hover {
          color: var(--ai-ink);
        }
      }
      .cat {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem;
        margin-bottom: 0.2rem;
      }
    }
    .place {
      padding-top: 0.35rem;
      white-space: nowrap;
    }
    .fights {
      margin-top: 1rem;
      border-top: 1px solid var(--kasumi);
      .color {
        width: 1rem;
      }
      .score {
        font-weight: 700;
        &.flags {
          font-weight: 400;
        }
      }
    }
    .strip {
      display: inline-block;
      width: 3px;
      height: 1.1rem;
      border-radius: 2px;
      vertical-align: middle;
      &.aka {
        background: var(--shu);
      }
      &.ao {
        background: var(--ai);
      }
    }
    .nofights {
      margin: 0.75rem 0 0;
    }
  `,
})
export class PersonHistoryView {
  readonly sinDojo = $localize`:@@comun.sin-dojo:Sin dojo`;
  readonly gradoSinDato = $localize`:@@persona.historial.grado-sd:grado s/d`;
  private api = inject(ApiService);
  readonly personId = input.required<number>();
  /** Enlaces al torneo y a la llave (solo para quien lee el torneo). La hoja del combate
   * la ven también la propia persona y su apoderado. */
  readonly links = input(true);

  readonly history = signal<PersonHistory | null>(null);
  readonly error = signal('');
  readonly fdate = fmtDate;
  readonly score = matchScoreText;
  readonly method = methodText;
  readonly regStatus = REGISTRATION_STATUS;

  constructor() {
    effect(() => {
      const id = this.personId();
      this.history.set(null);
      this.error.set('');
      this.api.get<PersonHistory>(`/persons/${id}/history`).subscribe({
        next: (h) => this.history.set(h),
        error: (e) => this.error.set(ApiError.from(e).fullMessage),
      });
    });
  }
}
