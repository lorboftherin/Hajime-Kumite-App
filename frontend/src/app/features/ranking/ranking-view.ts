import { Component, computed, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { RankingDetail } from '../../core/models';
import { medalsText } from './ranking-logic';

/**
 * Tablas del ranking de una temporada: personas por categoría equivalente y
 * «mejor academia». La usan la página interna y la pública (sin enlaces).
 */
@Component({
  selector: 'app-ranking-view',
  imports: [FormsModule, RouterLink],
  template: `
    @if (detail(); as d) {
      <div class="filters">
        <div i18n-aria-label="@@ranking.vista.tabla" class="chips" role="group" aria-label="Tabla">
          <button
            i18n="@@ranking.vista.competidores"
            type="button"
            class="chip"
            [class.on]="section() === 'persons'"
            (click)="sectionChange.emit('persons')"
          >
            Competidores
          </button>
          <button
            i18n="@@ranking.vista.mejor-academia"
            type="button"
            class="chip"
            [class.on]="section() === 'dojos'"
            (click)="sectionChange.emit('dojos')"
          >
            Mejor academia
          </button>
        </div>
        @if (section() === 'persons') {
          <select
            i18n-aria-label="@@ranking.vista.modalidad"
            aria-label="Modalidad"
            [ngModel]="modality()"
            (ngModelChange)="modalityChange.emit($event)"
          >
            <option i18n="@@ranking.vista.kumite-kata" value="">Kumite y kata</option>
            <option i18n="@@ranking.vista.kumite" value="kumite">Kumite</option>
            <option i18n="@@ranking.vista.kata" value="kata">Kata</option>
          </select>
          <select
            i18n-aria-label="@@ranking.vista.categoria"
            class="grow"
            aria-label="Categoría"
            [ngModel]="group()"
            (ngModelChange)="groupChange.emit($event)"
          >
            <option i18n="@@ranking.vista.todas-categorias" value="">Todas las categorías</option>
            @for (g of d.groups; track g.key) {
              <option [value]="g.key">{{ g.label }} ({{ g.competitors }})</option>
            }
          </select>
        }
      </div>

      @if (section() === 'persons') {
        @for (g of d.persons; track g.key) {
          <section class="group">
            <h3>
              {{ g.label }}
              <span class="muted small">{{ g.modality === 'kata' ? 'Kata' : 'Kumite' }}</span>
            </h3>
            <div class="table-wrap">
              <table class="table rank-table">
                <thead>
                  <tr>
                    <th class="center">#</th>
                    <th i18n="@@ranking.vista.competidor">Competidor</th>
                    <th i18n="@@ranking.vista.dojo">Dojo</th>
                    <th i18n="@@ranking.vista.medallas" class="center">Medallas</th>
                    <th i18n="@@ranking.vista.torneos" class="center">Torneos</th>
                    <th i18n="@@ranking.vista.puntos" class="right">Puntos</th>
                  </tr>
                </thead>
                <tbody>
                  @for (r of g.rows ?? []; track r.person_id) {
                    <tr [class.top]="r.rank <= 3">
                      <td class="center rank">{{ r.rank }}</td>
                      <td>
                        @if (links() && r.person_id) {
                          <a
                            [routerLink]="['/personas', r.person_id]"
                            [queryParams]="{ tab: 'diplomas' }"
                            >{{ r.name }}</a
                          >
                        } @else {
                          {{ r.name }}
                        }
                      </td>
                      <td class="muted">{{ r.dojo_name }}</td>
                      <td
                        class="center nowrap"
                        [attr.title]="medals(r.golds, r.silvers, r.bronzes)"
                      >
                        <span class="m kin">{{ r.golds }}</span
                        ><span class="m gin">{{ r.silvers }}</span
                        ><span class="m dou">{{ r.bronzes }}</span>
                      </td>
                      <td class="center">{{ r.tournaments }}</td>
                      <td class="right pts">{{ r.points }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        } @empty {
          <div class="card empty">
            <p
              ><strong i18n="@@ranking.vista.sin-resultados-todavia"
                >Sin resultados todavía.</strong
              ></p
            ><ng-container i18n="@@ranking.vista.ranking-llena-categorias">
              El ranking se llena con las categorías finalizadas de los torneos de la temporada.
            </ng-container></div
          >
        }
      } @else {
        <div class="table-wrap">
          <table class="table rank-table">
            <thead>
              <tr>
                <th class="center">#</th>
                <th i18n="@@ranking.vista.dojo">Dojo</th>
                <th i18n="@@ranking.vista.medallas" class="center">Medallas</th>
                <th i18n="@@ranking.vista.participaciones" class="center">Participaciones</th>
                <th i18n="@@ranking.vista.puntos" class="right">Puntos</th>
              </tr>
            </thead>
            <tbody>
              @for (r of d.dojos; track r.dojo_id) {
                <tr [class.top]="r.rank <= 3">
                  <td class="center rank">{{ r.rank }}</td>
                  <td>
                    @if (links() && r.dojo_id) {
                      <a [routerLink]="['/dojos', r.dojo_id]">{{ r.name }}</a>
                    } @else {
                      {{ r.name }}
                    }
                  </td>
                  <td class="center nowrap" [attr.title]="medals(r.golds, r.silvers, r.bronzes)">
                    <span class="m kin">{{ r.golds }}</span
                    ><span class="m gin">{{ r.silvers }}</span
                    ><span class="m dou">{{ r.bronzes }}</span>
                  </td>
                  <td class="center">{{ r.participations }}</td>
                  <td class="right pts">{{ r.points }}</td>
                </tr>
              } @empty {
                <tr>
                  <td i18n="@@ranking.vista.sin-resultados-todavia" colspan="5" class="empty"
                    >Sin resultados todavía.</td
                  >
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
      <p class="hint"
        ><ng-container i18n="@@ranking.vista.puntos-oro-plata-bronce">
          Puntos: oro {{ d.season.points.gold }}, plata {{ d.season.points.silver }}, bronce
          {{ d.season.points.bronze }}, participación {{ d.season.points.participation }}.
        </ng-container>
        @if (multiplied().length) {
          <ng-container i18n="@@ranking.vista.valen-mas">
            Valen más: {{ multiplied().join(', ') }}.
          </ng-container>
        }
      </p>
    }
  `,
  styles: `
    .filters {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-3);
      align-items: center;
      margin-bottom: var(--space-4);
      select {
        min-height: 2.5rem;
      }
    }
    .chips {
      display: flex;
      gap: 0.4rem;
    }
    .chip {
      all: unset;
      box-sizing: border-box;
      min-height: 2.5rem;
      padding: 0 1rem;
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      border: 1px solid var(--kasumi-2);
      font-size: var(--fs-14);
      cursor: pointer;
      &.on {
        background: var(--sumi);
        color: var(--on-sumi);
        border-color: var(--sumi);
      }
      &:focus-visible {
        outline: 2px solid var(--ai);
        outline-offset: 2px;
      }
    }
    .group h3 {
      margin: 1.25rem 0 0.5rem;
      font-size: var(--fs-16);
    }
    .rank-table {
      .rank {
        width: 3rem;
        font-family: var(--font-display);
        font-weight: 700;
      }
      tr.top .rank {
        color: var(--shu-ink);
      }
      .pts {
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }
      a {
        color: var(--sumi);
        font-weight: 500;
      }
    }
    .m {
      display: inline-block;
      min-width: 1.6rem;
      text-align: center;
      font-variant-numeric: tabular-nums;
      border-bottom: 3px solid;
      margin: 0 0.1rem;
      &.kin {
        border-color: var(--kin);
      }
      &.gin {
        border-color: var(--gin);
      }
      &.dou {
        border-color: var(--dou);
      }
    }
  `,
})
export class RankingView {
  readonly detail = input<RankingDetail | null>(null);
  readonly section = input<'persons' | 'dojos'>('persons');
  readonly modality = input('');
  readonly group = input('');
  /** Enlaces a fichas de personas y dojos (solo en la vista interna). */
  readonly links = input(false);
  readonly sectionChange = output<'persons' | 'dojos'>();
  readonly modalityChange = output<string>();
  readonly groupChange = output<string>();

  readonly multiplied = computed(() =>
    (this.detail()?.season.tournaments ?? [])
      .filter((t) => t.multiplier !== 1)
      .map((t) => `${t.name} ×${t.multiplier}`),
  );

  medals(g: number, s: number, b: number): string {
    return medalsText(g, s, b);
  }
}
