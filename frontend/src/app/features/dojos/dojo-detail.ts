import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiError } from '../../core/api-error';
import { ApiService } from '../../core/api.service';
import { fmtDate } from '../../core/format';
import { Dojo, DojoHistory } from '../../core/models';
import { Hanko } from '../../shared/hanko';
import { Icon } from '../../shared/icon';
import { PageHead } from '../../shared/page-head';

/** Ficha del dojo con su historial de medallas (GET /dojos/{id}/history). */
@Component({
  selector: 'app-dojo-detail',
  imports: [RouterLink, PageHead, Icon, Hanko],
  template: `
    <div class="container">
      @if (dojo(); as d) {
        <app-page-head kanji="道場" [title]="d.name">
          <a i18n="@@dojo.dojos" back class="back-link" routerLink="/dojos"
            ><app-icon name="back" /> Dojos</a
          >
          <div meta class="meta-line">
            @if (d.short_name) {
              <span class="code">{{ d.short_name }}</span>
            }
            @if (d.city) {
              <span>{{ d.city }}</span>
            }
            @if (d.is_independent) {
              <span i18n="@@dojo.independiente" class="badge plain">Independiente</span>
            }
            @if (d.is_claimed) {
              <span i18n="@@dojo.registrado" class="badge matcha">Registrado</span>
            }
            @if (d.branches.length) {
              <span i18n="@@dojo.sedes">Sedes: {{ branchNames() }}</span>
            }
            @if (history()?.senseis?.length) {
              <span
                ><ng-container i18n="@@dojo.sensei"> Sensei: </ng-container>
                @for (s of history()!.senseis!; track s.person_id; let last = $last) {
                  <a [routerLink]="['/personas', s.person_id]">{{ s.name }}</a>
                  @if (!last) {
                    ,
                  }
                }
              </span>
            }
          </div>
          <a
            i18n="@@dojo.ver-competidores"
            class="btn"
            [routerLink]="['/personas']"
            [queryParams]="{ dojo: d.id }"
            >Ver competidores</a
          >
        </app-page-head>
      } @else if (!error()) {
        <a i18n="@@dojo.dojos" class="back-link" routerLink="/dojos"
          ><app-icon name="back" /> Dojos</a
        >
      }

      @if (history(); as h) {
        @if (h.tournaments.length) {
          <section
            i18n-aria-label="@@dojo.medallero-historico"
            class="card totals"
            aria-label="Medallero histórico"
          >
            <div class="medal"
              ><app-hanko [place]="1" size="lg" /><div
                ><span class="figure">{{ totals().gold }}</span
                ><span i18n="@@dojo.oro" class="small muted">Oro</span></div
              ></div
            >
            <div class="medal"
              ><app-hanko [place]="2" size="lg" /><div
                ><span class="figure">{{ totals().silver }}</span
                ><span i18n="@@dojo.plata" class="small muted">Plata</span></div
              ></div
            >
            <div class="medal"
              ><app-hanko [place]="3" size="lg" /><div
                ><span class="figure">{{ totals().bronze }}</span
                ><span i18n="@@dojo.bronce" class="small muted">Bronce</span></div
              ></div
            >
            <div class="medal total"
              ><div
                ><span class="figure">{{ h.tournaments.length }}</span
                ><span i18n="@@dojo.torneos-medalla" class="small muted"
                  >Torneos con medalla</span
                ></div
              ></div
            >
          </section>
        }

        @for (t of h.tournaments; track t.tournament_id) {
          <article class="card tour">
            <div class="tour-head">
              <div class="grow">
                <div class="eyebrow num">{{ fdate(t.date) }}</div>
                <h3
                  ><a [routerLink]="['/torneos', t.tournament_id, 'resultados']">{{
                    t.tournament_name
                  }}</a></h3
                >
              </div>
              <div
                i18n-aria-label="@@dojo.medallas-torneo"
                class="tally num"
                aria-label="Medallas del torneo"
              >
                <span
                  ><span class="ring kin"></span>{{ t.gold
                  }}<span i18n="@@dojo.oro-2" class="sr-only"> oro</span></span
                >
                <span
                  ><span class="ring gin"></span>{{ t.silver
                  }}<span i18n="@@dojo.plata-2" class="sr-only"> plata</span></span
                >
                <span
                  ><span class="ring dou"></span>{{ t.bronze
                  }}<span i18n="@@dojo.bronce-2" class="sr-only"> bronce</span></span
                >
              </div>
            </div>
            <table class="table small flush mt">
              <tbody>
                @for (r of t.results; track $index) {
                  <tr>
                    <td class="place"><app-hanko [place]="r.place" /></td>
                    <td>
                      @if (r.person_id) {
                        <a
                          class="pname"
                          [routerLink]="['/personas', r.person_id]"
                          [queryParams]="{ tab: 'historial' }"
                          >{{ r.name }}</a
                        >
                      } @else {
                        <span class="pname">{{ r.name }}</span>
                      }
                    </td>
                    <td class="muted">{{ r.category_name }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </article>
        } @empty {
          <div class="card empty">
            <p
              ><strong i18n="@@dojo.este-dojo-aun-no-tiene-medallas"
                >Este dojo aún no tiene medallas en su historial.</strong
              ></p
            >
            <p i18n="@@dojo.torneos-prueba-no-aparecen" class="small"
              >Los torneos de prueba no aparecen en el historial. Solo cuentan las categorías
              finalizadas de torneos oficiales.</p
            >
          </div>
        }
      } @else if (error()) {
        <div class="alert danger">{{ error() }}</div>
      } @else {
        <div class="empty"><span class="spinner"></span></div>
      }
    </div>
  `,
  styles: `
    .totals {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 1rem;
      max-width: 820px;
    }
    @media (max-width: 640px) {
      .totals {
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
    .tour {
      margin-bottom: 1rem;
    }
    .tour-head {
      display: flex;
      gap: 1rem;
      align-items: flex-start;
      h3 {
        margin: 0.15rem 0 0;
        font-family: var(--font-display);
        font-size: var(--fs-20);
        a {
          color: var(--sumi);
        }
        a:hover {
          color: var(--ai-ink);
        }
      }
    }
    .tally {
      display: flex;
      gap: 1rem;
      font-weight: 700;
      padding-top: 0.4rem;
      > span {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
      }
    }
    .ring {
      display: inline-block;
      width: 0.7rem;
      height: 0.7rem;
      border-radius: 50%;
      border: 2.5px solid;
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
    .place {
      width: 3rem;
    }
    .pname {
      font-weight: 500;
      color: var(--sumi);
    }
    a.pname:hover {
      color: var(--ai-ink);
    }
  `,
})
export class DojoDetailPage {
  private api = inject(ApiService);
  readonly id = input.required<string>();

  readonly dojo = signal<Dojo | null>(null);
  readonly history = signal<DojoHistory | null>(null);
  readonly error = signal('');
  readonly fdate = fmtDate;
  readonly branchNames = computed(() =>
    (this.dojo()?.branches ?? []).map((b) => b.name).join(', '),
  );
  readonly totals = computed(() =>
    (this.history()?.tournaments ?? []).reduce(
      (acc, t) => ({
        gold: acc.gold + t.gold,
        silver: acc.silver + t.silver,
        bronze: acc.bronze + t.bronze,
      }),
      { gold: 0, silver: 0, bronze: 0 },
    ),
  );

  constructor() {
    effect(() => {
      const id = Number(this.id());
      if (!id) return;
      this.dojo.set(null);
      this.history.set(null);
      this.error.set('');
      this.api
        .get<Dojo>(`/dojos/${id}`)
        .subscribe({ next: (d) => this.dojo.set(d), error: () => {} });
      this.api.get<DojoHistory>(`/dojos/${id}/history`).subscribe({
        next: (h) => this.history.set(h),
        error: (e) => this.error.set(ApiError.from(e).fullMessage),
      });
    });
  }
}
