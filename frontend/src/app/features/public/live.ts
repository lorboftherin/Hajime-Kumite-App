import { DatePipe, NgTemplateOutlet } from '@angular/common';
import {
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Meta, Title } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { toggled } from '../../core/push-logic';
import { PushService } from '../../core/push.service';
import { ToastService } from '../../core/toast.service';
import { PublicLive, PublicMatch } from '../../core/models';
import { Enso, HajimeWord } from '../../shared/enso';
import { personLink } from '../../shared/person-link';
import { LanguageSelect } from '../../shared/language-select';
import { PushButton, PushHint } from '../../shared/push-button';
import { PublicFeed } from './feed';
import {
  entryText,
  hourText,
  loadFavorites,
  saveFavorites,
  searchCompetitors,
  toggleFavorite,
} from './public-logic';
import { PublicCompetitor, PublicPeople } from './public-models';
import { setShareMeta } from './share-meta';

// Con SSE la página recibe cada cambio al instante; sin SSE (503, proxy) se
// consulta cada 5 s. Cada consulta pasa por la caché HTTP del navegador: el
// servidor responde con ETag y `Cache-Control: max-age`; si nada cambió, 304.
const REFRESH_MS = 5000;
const PEOPLE_REFRESH_MS = 20000;

/**
 * Hajime en vivo: la página pública del torneo para familias y público (como el
 * seguimiento en vivo de CricHeroes). Sin inicio de sesión; solo existe si el
 * organizador activó el público. Se abre por la dirección fija (`/t/:slug`) o
 * por el enlace secreto (`/vivo/:token`), que muestran lo mismo.
 */
@Component({
  selector: 'app-public-live',
  imports: [
    Enso,
    HajimeWord,
    DatePipe,
    NgTemplateOutlet,
    FormsModule,
    RouterLink,
    PushButton,
    PushHint,
    LanguageSelect,
  ],
  template: `
    <div class="page">
      <header class="top">
        <a
          i18n-aria-label="@@publico.vivo.torneos-publicos"
          class="brand"
          routerLink="/torneos-publicos"
          aria-label="Torneos públicos"
          ><app-enso class="mark" /><app-hajime-word class="word" /><span
            i18n="@@publico.vivo.vivo"
            class="live-tag"
            >en vivo</span
          ></a
        >
        @if (data(); as d) {
          <span class="pulse" [class.stale]="stale()" role="status">
            <i aria-hidden="true"></i>
            @if (stale()) {
              <ng-container i18n="@@publico.vivo.reconectando">Reconectando…</ng-container>
            } @else {
              <ng-container i18n="@@publico.vivo.actualizado"
                >Actualizado {{ updated() | date: 'HH:mm:ss' }}</ng-container
              >
            }
          </span>
        }
      </header>

      @if (data(); as d) {
        <section class="hero">
          <h1>{{ d.tournament.name }}</h1>
          <p>
            {{ d.tournament.start_date | date: 'd MMM y' }}
            @if (d.tournament.venue) {
              · {{ d.tournament.venue }}
            }
            @if (d.tournament.city) {
              , {{ d.tournament.city }}
            }
          </p>
        </section>

        <nav i18n-aria-label="@@publico.vivo.secciones" class="jump" aria-label="Secciones">
          <a i18n="@@publico.vivo.cuando-pelea" href="#cuando" (click)="go($event, 'cuando')"
            >¿Cuándo pelea?</a
          >
          <a i18n="@@publico.vivo.tatamis" href="#tatamis" (click)="go($event, 'tatamis')"
            >Tatamis</a
          >
          @if (d.awards.length) {
            <a i18n="@@publico.vivo.premios" href="#premios" (click)="go($event, 'premios')"
              >Premios</a
            >
          }
          <a i18n="@@publico.vivo.resultados" href="#resultados" (click)="go($event, 'resultados')"
            >Resultados</a
          >
          <a i18n="@@publico.vivo.llaves" href="#categorias" (click)="go($event, 'categorias')"
            >Llaves</a
          >
          <a i18n="@@publico.vivo.medallero" href="#medallero" (click)="go($event, 'medallero')"
            >Medallero</a
          >
        </nav>

        <section id="cuando" class="when" aria-labelledby="h-cuando">
          <h2 i18n="@@publico.vivo.cuando-pelea" id="h-cuando" class="sec">¿Cuándo pelea?</h2>
          <label class="search">
            <span i18n="@@publico.vivo.buscar-competidor-nombre-dojo" class="sr-only"
              >Buscar competidor por nombre o dojo</span
            >
            <input
              i18n-placeholder="@@publico.vivo.nombre-dojo-p-ej-diego-kaze"
              type="search"
              [ngModel]="query()"
              (ngModelChange)="query.set($event)"
              placeholder="Nombre o dojo, p. ej. «Diego» o «Kaze»"
              autocomplete="off"
              enterkeyhint="search"
            />
          </label>
          <app-push-hint [always]="false" />
          @if (highlighted(); as h) {
            <h3 i18n="@@publico.vivo.siguiendo" class="sub">Siguiendo</h3>
            <ul class="fighters hl" id="seguido">
              <ng-container *ngTemplateOutlet="fighter; context: { $implicit: h }" />
            </ul>
          }
          @if (query().trim().length >= 2) {
            <ul class="fighters" aria-live="polite">
              @for (c of results(); track c.key) {
                <ng-container *ngTemplateOutlet="fighter; context: { $implicit: c }" />
              } @empty {
                <li class="idle">
                  @if (people()) {
                    <ng-container i18n="@@publico.vivo.nadie-coincide"
                      >Nadie coincide con «{{ query().trim() }}».</ng-container
                    >
                  } @else {
                    <ng-container i18n="@@publico.vivo.cargando-competidores"
                      >Cargando competidores…</ng-container
                    >
                  }
                </li>
              }
            </ul>
          }
          @if (favorites().length) {
            <h3 i18n="@@publico.vivo.mis-favoritos" class="sub">Mis favoritos</h3>
            <ul class="fighters favs">
              @for (c of favorites(); track c.key) {
                <ng-container *ngTemplateOutlet="fighter; context: { $implicit: c }" />
              }
            </ul>
          } @else if (!query()) {
            <p i18n="@@publico.vivo.busca-competidor-marcalo-para" class="idle small">
              Busca a tu competidor y márcalo con ★ para tenerlo siempre arriba (se guarda solo en
              este dispositivo). Con la campana te avisamos cuando le toque, su resultado y sus
              medallas (<a routerLink="/avisos">ajustes de avisos</a>).
            </p>
          }
        </section>

        <section
          i18n-aria-label="@@publico.vivo.tatamis-2"
          id="tatamis"
          class="tatamis"
          aria-label="Tatamis"
        >
          @for (t of d.tatamis; track t.id) {
            <article class="tat">
              <header>
                <h2>{{ t.name }}</h2>
                <span i18n="@@publico.vivo.combates" class="prog"
                  >{{ t.done }} de {{ t.total }} combates</span
                >
              </header>
              @if (t.current; as m) {
                <div class="now">
                  <div i18n="@@publico.vivo.curso" class="kicker">
                    <span class="dot" aria-hidden="true"></span>En curso · {{ m.category }} ·
                    {{ m.number }}
                  </div>
                  @if (m.bout; as b) {
                    <div i18n="@@publico.vivo.combate-individual" class="teamline">
                      {{ m.aka?.name }} <strong>{{ m.score[0] }}–{{ m.score[1] }}</strong>
                      {{ m.ao?.name }} · combate individual
                    </div>
                    <ng-container *ngTemplateOutlet="board; context: { $implicit: b }" />
                  } @else {
                    <ng-container *ngTemplateOutlet="board; context: { $implicit: m }" />
                  }
                </div>
              } @else {
                <p i18n="@@publico.vivo.sin-combate-curso" class="idle">Sin combate en curso.</p>
              }
              @if (t.upcoming.length) {
                <div class="next">
                  <span i18n="@@publico.vivo.siguen" class="lbl">Siguen</span>
                  <ol>
                    @for (u of t.upcoming; track u.code + u.category) {
                      <li>
                        <span class="n">{{ u.number }}</span>
                        <span i18n="@@publico.vivo.vs" class="vs"
                          ><span class="aka">{{ u.aka?.name ?? txtPorDefinir }}</span> vs
                          <span class="ao">{{ u.ao?.name ?? txtPorDefinir }}</span></span
                        >
                        <span class="cat"
                          >{{ u.category }}
                          @if (u.eta) {
                            · ≈ {{ hour(u.eta) }}
                          }
                        </span>
                      </li>
                    }
                  </ol>
                </div>
              }
              @if (t.last; as l) {
                <p i18n="@@publico.vivo.ultimo-gano" class="last">
                  Último: {{ winnerName(l) }} ganó {{ l.score[0] }}–{{ l.score[1] }} ·
                  {{ l.category }}
                </p>
              }
            </article>
          } @empty {
            <p i18n="@@publico.vivo.torneo-todavia-no-tiene-tatamis" class="idle"
              >El torneo todavía no tiene tatamis.</p
            >
          }
        </section>

        @if (d.awards.length) {
          <section id="premios" aria-labelledby="h-premios">
            <h2 i18n="@@publico.vivo.premios-torneo" id="h-premios" class="sec"
              >Premios del torneo</h2
            >
            <div class="awards">
              @for (a of d.awards; track a.title) {
                <div class="award">
                  <span class="eyebrow">{{ a.title }}</span>
                  <strong>{{ a.name }}</strong>
                  <span class="muted">{{ a.dojo }} · {{ a.value }}</span>
                </div>
              }
            </div>
          </section>
        }

        <section id="resultados" aria-labelledby="h-res">
          <h2 i18n="@@publico.vivo.resultados-categoria-s" id="h-res" class="sec">
            Resultados <span class="muted">{{ d.results.length }} categoría(s) finalizada(s)</span>
          </h2>
          @for (r of d.results; track r.category) {
            <details class="res">
              <summary>{{ r.category }}</summary>
              <ol class="podium">
                @for (p of r.places; track $index) {
                  <li>
                    <span class="place p{{ p.place }}">{{ p.place }}</span
                    ><span class="grow">
                      @if (link(p.public_id); as l) {
                        <a class="plink" [routerLink]="l">{{ p.name }}</a>
                      } @else {
                        {{ p.name }}
                      }</span
                    ><span class="muted">{{ p.dojo }}</span>
                  </li>
                }
              </ol>
              @if (r.category_id) {
                <a
                  i18n="@@publico.vivo.ver-llave-completa"
                  class="more"
                  [routerLink]="catLink(r.category_id)"
                  >Ver la llave completa →</a
                >
              }
            </details>
          } @empty {
            <p i18n="@@publico.vivo.todavia-no-hay-categorias" class="idle"
              >Todavía no hay categorías finalizadas.</p
            >
          }
        </section>

        <section id="categorias" aria-labelledby="h-cat">
          <h2 i18n="@@publico.vivo.llaves-categoria" id="h-cat" class="sec"
            >Llaves por categoría</h2
          >
          @if (d.categories.length) {
            <ul class="cats">
              @for (c of d.categories; track c.id ?? c.name) {
                <li>
                  @if (c.id) {
                    <a [routerLink]="catLink(c.id)">{{ c.name }}</a>
                  } @else {
                    <span>{{ c.name }}</span>
                  }
                  <span class="muted small">{{ statusLabel(c.status) }}</span>
                </li>
              }
            </ul>
          } @else {
            <p i18n="@@publico.vivo.sin-categorias-publicadas" class="idle"
              >Sin categorías publicadas.</p
            >
          }
        </section>

        <section id="medallero" aria-labelledby="h-med">
          <h2 i18n="@@publico.vivo.medallero-dojo" id="h-med" class="sec">Medallero por dojo</h2>
          @if (d.medal_table.length) {
            <table class="medals">
              <thead>
                <tr>
                  <th>#</th>
                  <th i18n="@@publico.vivo.dojo">Dojo</th>
                  <th i18n="@@publico.vivo.oro-2" i18n-title="@@publico.vivo.oro" title="Oro"
                    >Oro</th
                  >
                  <th i18n="@@publico.vivo.plata-2" i18n-title="@@publico.vivo.plata" title="Plata"
                    >Plata</th
                  >
                  <th
                    i18n="@@publico.vivo.bronce-2"
                    i18n-title="@@publico.vivo.bronce"
                    title="Bronce"
                    >Bronce</th
                  >
                </tr>
              </thead>
              <tbody>
                @for (m of d.medal_table; track m.dojo_name) {
                  <tr>
                    <td>{{ m.rank }}</td>
                    <td>{{ m.dojo_name }}</td>
                    <td>{{ m.gold }}</td>
                    <td>{{ m.silver }}</td>
                    <td>{{ m.bronze }}</td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <p i18n="@@publico.vivo.sin-medallas-todavia" class="idle">Sin medallas todavía.</p>
          }
        </section>

        <footer class="foot"
          ><ng-container i18n="@@publico.vivo.datos-publicados-organizacion">
            Datos publicados por la organización del torneo.
            <a routerLink="/torneos-publicos">Más torneos</a> · Hajime · Torneos de karate. </ng-container
          ><div class="foot-lang"><app-language-select /></div>
        </footer>
      } @else if (error()) {
        <section class="hero">
          <h1 i18n="@@publico.vivo.enlace-no-disponible">Enlace no disponible</h1>
          <p>{{ error() }}</p>
          <p
            ><a i18n="@@publico.vivo.ver-torneos-publicos" routerLink="/torneos-publicos"
              >Ver torneos públicos</a
            ></p
          >
        </section>
      } @else {
        <p i18n="@@publico.vivo.cargando" class="idle">Cargando…</p>
      }
    </div>

    <ng-template #board let-m>
      <div class="board">
        <div class="s aka" [class.won]="m.winner === 'aka'">
          <span class="nm">{{ m.aka?.name ?? '—' }}</span
          ><span class="dj">{{ m.aka?.dojo }}</span>
        </div>
        <div class="sc">
          <span>{{ m.score[0] }}</span
          ><span class="d">–</span><span>{{ m.score[1] }}</span>
        </div>
        <div class="s ao" [class.won]="m.winner === 'ao'">
          <span class="nm">{{ m.ao?.name ?? '—' }}</span
          ><span class="dj">{{ m.ao?.dojo }}</span>
        </div>
      </div>
    </ng-template>

    <ng-template #fighter let-c>
      <li class="fighter" [class.fav]="favKeys().has(c.key)">
        <button
          type="button"
          class="star"
          [class.on]="favKeys().has(c.key)"
          (click)="toggleFav(c)"
          [attr.aria-pressed]="favKeys().has(c.key)"
          [attr.aria-label]="ariaFavorito(favKeys().has(c.key), c.name)"
        >
          {{ favKeys().has(c.key) ? '★' : '☆' }}
        </button>
        <app-push-button
          class="bell"
          [compact]="true"
          [on]="pushKeys().has(c.key)"
          [busy]="pushBusy()"
          [label]="c.name"
          (toggled)="toggleAlert(c, $event)"
        />
        <div class="grow">
          <div class="who">
            <strong>
              @if (link(c.public_id); as l) {
                <a class="plink" [routerLink]="l">{{ c.name }}</a>
              } @else {
                {{ c.name }}
              }
            </strong>
            <span class="muted">{{ c.dojo }}</span>
          </div>
          @for (e of c.entries; track e.category_id) {
            <div class="entry {{ e.state }}">
              <a [routerLink]="catLink(e.category_id)">{{ e.category }}</a>
              <span class="what">{{ entry(e) }}</span>
            </div>
          }
        </div>
      </li>
    </ng-template>
  `,
  styleUrl: './live.scss',
})
export class PublicLivePage {
  readonly txtPorDefinir = $localize`:@@comun.por-definir:Por definir`;
  ariaFavorito = (es: boolean, nombre: string) =>
    es
      ? $localize`:@@publico.vivo.quitar-favoritos:Quitar de favoritos a ${nombre}:nombre:`
      : $localize`:@@publico.vivo.marcar-favorito:Marcar como favorito a ${nombre}:nombre:`;
  private api = inject(ApiService);
  private meta = inject(Meta);
  private title = inject(Title);
  /** Enlace secreto (`/vivo/:token`) o dirección fija (`/t/:slug`): uno de los dos. */
  readonly token = input<string | undefined>(undefined);
  readonly slug = input<string | undefined>(undefined);
  /** `?seguir=<key>`: el enlace de un aviso resalta a ese competidor. */
  readonly seguir = input<string | undefined>(undefined);
  readonly data = signal<PublicLive | null>(null);
  readonly people = signal<PublicPeople | null>(null);
  readonly error = signal('');
  readonly updated = signal<Date | null>(null);
  readonly stale = signal(false);
  readonly query = signal('');
  readonly favKeys = signal<Set<string>>(new Set());
  /** Competidores con aviso en este dispositivo (en el servidor). */
  readonly pushKeys = signal<Set<string>>(new Set());
  readonly pushBusy = signal(false);
  private push = inject(PushService);
  private toast = inject(ToastService);
  private scrolled = false;

  readonly catStatus: Record<string, string> = {
    open: $localize`:@@publico.vivo.inscripciones:Inscripciones`,
    ready: $localize`:@@publico.vivo.llave-lista:Llave lista`,
    in_progress: $localize`:@@publico.vivo.curso-2:En curso`,
    finished: $localize`:@@publico.vivo.terminada:Terminada`,
  };

  /** Base de la API y de los enlaces de la página. */
  readonly ref = computed(() => {
    const slug = this.slug();
    if (slug) return { api: `/public/t/${encodeURIComponent(slug)}`, page: `/t/${slug}` };
    const token = this.token() ?? '';
    return { api: `/public/${encodeURIComponent(token)}`, page: `/vivo/${token}` };
  });
  readonly favRef = computed(
    () =>
      this.data()?.tournament.slug ??
      this.people()?.tournament.slug ??
      this.slug() ??
      this.token() ??
      '',
  );
  readonly tz = computed(
    () => this.data()?.tournament.timezone ?? this.people()?.tournament.timezone ?? 'America/Lima',
  );
  readonly results = computed(() =>
    searchCompetitors(this.people()?.competitors ?? [], this.query()),
  );
  readonly highlighted = computed<PublicCompetitor | null>(() => {
    const key = this.seguir();
    if (!key) return null;
    return (this.people()?.competitors ?? []).find((c) => c.key === key) ?? null;
  });
  readonly favorites = computed<PublicCompetitor[]>(() => {
    const keys = this.favKeys();
    return (this.people()?.competitors ?? []).filter((c) => keys.has(c.key));
  });

  private feed: PublicFeed<PublicLive, PublicPeople> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.feed?.stop());
    effect(() => {
      const ref = this.ref();
      untracked(() => this.connect(ref.api));
    });
    // Favoritos por torneo (la dirección fija si la hay: los mismos por /t/ y por /vivo/).
    effect(() => {
      const ref = this.favRef();
      untracked(() => this.favKeys.set(loadFavorites(ref)));
    });
    // Avisos de este dispositivo en el torneo (si ya está suscrito).
    effect(() => {
      const ref = this.favRef();
      const sub = this.push.subscription();
      if (!ref || !sub) return;
      untracked(() => void this.push.state(ref).then((s) => this.pushKeys.set(new Set(s.keys))));
    });
    // Llegó desde un aviso: se muestra arriba y se va a «¿Cuándo pelea?».
    effect(() => {
      if (!this.highlighted() || this.scrolled) return;
      this.scrolled = true;
      setTimeout(() => document.getElementById('cuando')?.scrollIntoView({ block: 'start' }), 50);
    });
  }

  private connect(base: string): void {
    this.feed?.stop();
    this.data.set(null);
    this.people.set(null);
    this.error.set('');
    this.feed = new PublicFeed<PublicLive, PublicPeople>(this.api, {
      base,
      live: true,
      people: true,
      pollMs: REFRESH_MS,
      peoplePollMs: PEOPLE_REFRESH_MS,
      onLive: (d) => {
        this.data.set(d);
        this.updated.set(new Date());
        this.stale.set(false);
        setShareMeta(this.meta, this.title, d.tournament, this.ref().page);
      },
      onPeople: (p) => this.people.set(p),
      onGone: (msg) => {
        this.data.set(null);
        this.error.set(msg);
      },
      onStatus: (ok) => this.stale.set(!ok),
    });
    this.feed.start();
  }

  readonly link = personLink;

  statusLabel(status: string): string {
    return this.catStatus[status] ?? status;
  }

  catLink(id: number): string {
    return `${this.ref().page}/categoria/${id}`;
  }

  hour(iso: string | null | undefined): string {
    return hourText(iso, this.tz());
  }

  entry(e: PublicCompetitor['entries'][number]): string {
    return entryText(e, this.tz());
  }

  toggleFav(c: PublicCompetitor): void {
    const next = toggleFavorite(this.favKeys(), c.key);
    this.favKeys.set(next);
    saveFavorites(this.favRef(), next);
  }

  /** «Avisarme»: suscribe este dispositivo (si hace falta) y guarda a quién sigue en el torneo. */
  async toggleAlert(c: PublicCompetitor, on: boolean): Promise<void> {
    const ref = this.favRef();
    if (!ref) return;
    this.pushBusy.set(true);
    try {
      const state = await this.push.followPublic(ref, [...toggled(this.pushKeys(), c.key, on)]);
      if (!state) return;
      this.pushKeys.set(new Set(state.keys));
      if (on && !this.favKeys().has(c.key)) this.toggleFav(c);
      this.toast.ok(
        on
          ? $localize`:@@publico.vivo.te-avisaremos-cuando-le-toque:Te avisaremos cuando le toque a ${c.name}:name:`
          : $localize`:@@publico.vivo.aviso-quitado:Aviso quitado`,
      );
    } catch {
      this.toast.error(
        $localize`:@@publico.vivo.no-pudo-guardar-aviso:No se pudo guardar el aviso`,
      );
    } finally {
      this.pushBusy.set(false);
    }
  }

  winnerName(m: PublicMatch): string {
    if (m.winner === 'aka') return m.aka?.name ?? 'AKA';
    if (m.winner === 'ao') return m.ao?.name ?? 'AO';
    return $localize`:@@publico.vivo.empate:Empate`;
  }

  go(ev: Event, id: string): void {
    ev.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}
