import { Component, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiError } from '../../core/api-error';
import { ApiService } from '../../core/api.service';
import { PublicProfile } from '../../core/cuentas';
import { fmtDate } from '../../core/format';
import { Enso, HajimeWord } from '../../shared/enso';
import { Hanko } from '../../shared/hanko';
import { LanguageSelect } from '../../shared/language-select';
import { shareProfileCard } from '../../shared/profile-share-card';

/**
 * Perfil público básico del competidor (`/competidor/:publicId`), sin inicio de sesión:
 * nombre (abreviado si es menor), dojo, medallas y torneos ya disputados. Nunca
 * documento, fecha de nacimiento ni datos de contacto (docs/modelo-negocio.md).
 */
@Component({
  selector: 'app-public-profile',
  imports: [Enso, HajimeWord, Hanko, RouterLink, LanguageSelect],
  template: `
    <div class="page">
      <header class="top">
        <a i18n-aria-label="@@perfil-publico.hajime" class="brand" routerLink="/login" aria-label="Hajime"
          ><app-enso class="mark" /><app-hajime-word class="word"
        /></a>
      </header>

      @if (profile(); as p) {
        <section class="hero">
          <span class="kanji" aria-hidden="true">選手</span>
          <h1>{{ p.name }}</h1>
          @if (p.dojo) {
            <p class="dojo">{{ p.dojo }}</p>
          }
          <div i18n-aria-label="@@perfil-publico.medallas" class="medals" aria-label="Medallas">
            <div>
              <app-hanko [place]="1" size="lg" /><span class="figure">{{ p.medals.gold }}</span
              ><span i18n="@@perfil-publico.oro" class="small muted">Oro</span>
            </div>
            <div>
              <app-hanko [place]="2" size="lg" /><span class="figure">{{ p.medals.silver }}</span
              ><span i18n="@@perfil-publico.plata" class="small muted">Plata</span>
            </div>
            <div>
              <app-hanko [place]="3" size="lg" /><span class="figure">{{ p.medals.bronze }}</span
              ><span i18n="@@perfil-publico.bronce" class="small muted">Bronce</span>
            </div>
            <div>
              <span class="figure">{{ p.tournament_count }}</span
              ><span i18n="@@perfil-publico.torneo-torneos" class="small muted">{p.tournament_count, plural, =1 {Torneo} other {Torneos}}</span>
            </div>
          </div>
          <button i18n="@@perfil-publico.compartir-tarjeta" class="btn" type="button" (click)="share(p)" [disabled]="sharing()">
            Compartir tarjeta
          </button>
        </section>

        <section class="list">
          <h2 i18n="@@perfil-publico.resultados" class="section-title">Resultados</h2>
          @for (e of p.tournaments; track $index) {
            <article class="card entry">
              <div class="grow">
                <div class="eyebrow num">{{ fdate(e.date) }}</div>
                <h3>{{ e.tournament_name }}</h3>
                <div class="small muted">
                  {{ e.category_name }}
                  @if (e.team_name) {<ng-container i18n="@@perfil-publico.equipo">
                    · Equipo {{ e.team_name }}
                  </ng-container>}
                  @if (e.dojo_name) {
                    · {{ e.dojo_name }}
                  }
                </div>
              </div>
              <div class="place">
                @if (e.place && e.place <= 3) {
                  <app-hanko [place]="e.place" [withLabel]="true" size="lg" />
                } @else {
                  <span class="muted small">@if (e.place) {<ng-container i18n="@@comun.puesto-n">{{ e.place }}.º puesto</ng-container>} @else {<ng-container i18n="@@perfil-publico.participo">Participó</ng-container>}</span>
                }
              </div>
            </article>
          } @empty {
            <div class="card empty"><p i18n="@@perfil-publico.aun-no-tiene-torneos-oficiales">Aún no tiene torneos oficiales disputados.</p></div>
          }
        </section>
        <footer class="foot small muted"><ng-container i18n="@@perfil-publico.perfil-basico-publico-historial">
          Perfil básico público. El historial completo lo ven la propia persona, su padre, madre o
          apoderado y su dojo.
          <a routerLink="/privacidad">Privacidad</a></ng-container>
          <div class="foot-lang"><app-language-select /></div>
        </footer>
      } @else if (error()) {
        <div class="card empty">
          <p>{{ error() }}</p>
        </div>
      } @else {
        <div class="empty"><span class="spinner"></span></div>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
      min-height: 100vh;
      background: var(--washi);
    }
    .page {
      max-width: 760px;
      margin: 0 auto;
      padding: 1.25rem 1rem 3rem;
    }
    .top .brand {
      display: inline-flex;
      align-items: center;
      gap: 0.6rem;
      color: var(--sumi);
      text-decoration: none;
      .mark {
        width: 2.2rem;
        height: 2.2rem;
      }
      .word {
        height: 1.5rem;
        margin-top: 0.4rem;
      }
    }
    .hero {
      text-align: center;
      padding: 2.5rem 0 1.5rem;
      .kanji {
        font-family: var(--font-display);
        color: var(--shu-ink);
        letter-spacing: 0.2em;
      }
      h1 {
        font-family: var(--font-display);
        font-size: var(--fs-40);
        margin: 0.25rem 0;
      }
      .dojo {
        color: var(--sumi-2);
        margin: 0 0 1.5rem;
      }
    }
    .medals {
      display: flex;
      justify-content: center;
      flex-wrap: wrap;
      gap: 1.5rem;
      margin-bottom: 1.5rem;
      > div {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.25rem;
        min-width: 4.5rem;
      }
    }
    .entry {
      display: flex;
      align-items: center;
      gap: 1rem;
      h3 {
        margin: 0.15rem 0;
      }
    }
    .foot {
      margin-top: 2rem;
      text-align: center;
    }
    .foot-lang {
      margin-top: 0.75rem;
    }
  `,
})
export class PublicProfilePage {
  private api = inject(ApiService);
  readonly publicId = input.required<string>();
  readonly profile = signal<PublicProfile | null>(null);
  readonly error = signal('');
  readonly sharing = signal(false);
  readonly fdate = fmtDate;

  constructor() {
    effect(() => {
      const id = this.publicId();
      this.profile.set(null);
      this.error.set('');
      firstValueFrom(this.api.get<PublicProfile>(`/public/persons/${encodeURIComponent(id)}`))
        .then((p) => {
          this.profile.set(p);
          if (typeof document !== 'undefined') document.title = $localize`:@@perfil-publico.hajime-2:${p.name}:name: · Hajime`;
        })
        .catch((e) => {
          const err = ApiError.from(e);
          this.error.set(err.status === 404 ? $localize`:@@perfil-publico.este-perfil-no-existe:Este perfil no existe.` : err.fullMessage);
        });
    });
  }

  async share(p: PublicProfile): Promise<void> {
    this.sharing.set(true);
    try {
      await shareProfileCard(p, location.href);
    } finally {
      this.sharing.set(false);
    }
  }
}
