import { Component, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { FilesService } from '../../core/files.service';
import { PersonCertificates, PersonRanking } from '../../core/models';
import { Hanko } from '../../shared/hanko';
import { Icon } from '../../shared/icon';
import { DatePipe } from '../../shared/pipes';

/** Perfil de la persona: sus diplomas por torneo y su puesto en cada ranking. */
@Component({
  selector: 'app-person-awards',
  imports: [RouterLink, Hanko, Icon, DatePipe],
  template: `
    <div class="grid">
      <section>
        <h2 class="section-title">Ranking</h2>
        @for (r of ranking(); track r.season_id + r.group_key) {
          <article class="card rank">
            <div class="pos">
              <span class="big">{{ r.rank }}.º</span>
              <span class="muted small">de {{ r.of }}</span>
            </div>
            <div class="grow">
              @if (links()) {
                <a
                  [routerLink]="['/ranking']"
                  [queryParams]="{ temporada: r.season_id, grupo: r.group_key }"
                >
                  <strong>{{ r.season_name }}</strong>
                </a>
              } @else if (r.is_public) {
                <a [routerLink]="['/ranking', r.slug]"
                  ><strong>{{ r.season_name }}</strong></a
                >
              } @else {
                <strong>{{ r.season_name }}</strong>
              }
              <div class="muted small">{{ r.group_label }}</div>
            </div>
            <div class="pts">
              <strong>{{ r.points }}</strong> <span class="muted small">pts</span>
            </div>
          </article>
        } @empty {
          <p class="muted small">Todavía no aparece en ningún ranking.</p>
        }
      </section>
      <section>
        <h2 class="section-title">Diplomas y certificados</h2>
        @for (t of certs(); track t.tournament_id) {
          <article class="card tour">
            <header>
              <div class="grow">
                <strong>{{ t.tournament_name }}</strong>
                <span class="muted small"> · {{ t.start_date | fdate }}</span>
                @if (t.is_test) {
                  <span class="badge yamabuki hollow">prueba</span>
                }
              </div>
              <button class="btn sm" (click)="open(t.tournament_id)">
                <app-icon name="print" /> Diplomas
              </button>
            </header>
            <ul>
              @for (i of t.items; track i.category_id) {
                <li>
                  @if (i.place) {
                    <app-hanko [place]="i.place" />
                  } @else {
                    <span class="part" title="Participación">P</span>
                  }
                  <span>{{ i.category_name }}</span>
                </li>
              }
            </ul>
          </article>
        } @empty {
          <p class="muted small">Sin diplomas todavía: salen de las categorías finalizadas.</p>
        }
      </section>
    </div>
  `,
  styles: `
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 2rem;
      align-items: start;
    }
    .rank {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: 0.8rem 1.1rem;
      margin-bottom: 0.6rem;
      .pos {
        display: flex;
        flex-direction: column;
        align-items: center;
        min-width: 3rem;
      }
      .big {
        font-family: var(--font-display);
        font-size: var(--fs-28);
        font-weight: 700;
      }
      a {
        color: var(--sumi);
      }
    }
    .tour {
      padding: 0.8rem 1.1rem;
      margin-bottom: 0.6rem;
      header {
        display: flex;
        align-items: center;
        gap: 0.75rem;
      }
      ul {
        list-style: none;
        margin: 0.5rem 0 0;
        padding: 0;
      }
      li {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        padding: 0.3rem 0;
        font-size: var(--fs-14);
      }
      .part {
        display: inline-grid;
        place-items: center;
        width: 1.75rem;
        height: 1.75rem;
        border-radius: 50%;
        border: 1px solid var(--kasumi-2);
        color: var(--nezumi-ink);
        font-size: var(--fs-12);
      }
    }
  `,
})
export class PersonAwards {
  private api = inject(ApiService);
  private files = inject(FilesService);
  readonly personId = input.required<number>();
  /** Enlaces a la página interna de ranking (staff); fuera, al ranking público si lo hay. */
  readonly links = input(true);
  readonly certs = signal<PersonCertificates[]>([]);
  readonly ranking = signal<PersonRanking[]>([]);

  constructor() {
    effect(() => {
      const id = this.personId();
      firstValueFrom(this.api.get<PersonCertificates[]>(`/persons/${id}/certificates`)).then(
        (c) => this.certs.set(c),
        () => this.certs.set([]),
      );
      firstValueFrom(this.api.get<PersonRanking[]>(`/persons/${id}/ranking`)).then(
        (r) => this.ranking.set(r),
        () => this.ranking.set([]),
      );
    });
  }

  open(tid: number): void {
    // Derecho «certificates»: de la organización del torneo o Competidor Plus de la persona.
    this.files.open(`/tournaments/${tid}/persons/${this.personId()}/diplomas.pdf`);
  }
}
