import { NgTemplateOutlet } from '@angular/common';
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
import { Meta, Title } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiError } from '../../core/api-error';
import { ApiService } from '../../core/api.service';
import { methodText } from '../../core/format';
import { Enso, HajimeWord } from '../../shared/enso';
import { personLink } from '../../shared/person-link';
import { KIND_LABEL, bracketRounds } from './public-logic';
import { PublicBracketMatch, PublicCategory } from './public-models';
import { etiquetas } from '../../core/i18n/etiquetas';

const REFRESH_MS = 10000;

const STATUS: Record<string, string> = etiquetas(() => ({
  open: $localize`:@@publico.categoria.inscripciones-abiertas:Inscripciones abiertas`,
  ready: $localize`:@@publico.categoria.llave-lista:Llave lista`,
  in_progress: $localize`:@@publico.categoria.curso-2:En curso`,
  finished: $localize`:@@publico.categoria.terminada:Terminada`,
}));

/**
 * Llave y resultados de una categoría para el público (`/t/:slug/categoria/:id`
 * o `/vivo/:token/categoria/:id`): vista liviana de solo lectura, nombres según
 * la regla del torneo y el resultado de cada combate. El podio se muestra
 * abierto. Se actualiza cada 10 s (ETag: si nada cambió, 304 sin cuerpo).
 */
@Component({
  selector: 'app-public-category',
  imports: [RouterLink, Enso, HajimeWord, NgTemplateOutlet],
  template: `
    <div class="page">
      <header class="top">
        <a
          i18n-aria-label="@@publico.categoria.volver-torneo"
          class="brand"
          [routerLink]="back()"
          aria-label="Volver al torneo"
          ><app-enso class="mark" /><app-hajime-word class="word"
        /></a>
        <a class="btn-back" [routerLink]="back()">← {{ data()?.tournament?.name ?? txtTorneo }}</a>
      </header>
      @if (data(); as d) {
        <section class="hero">
          <h1>{{ d.category.name }}</h1>
          <p>
            {{ status(d.category.status) }} ·
            <ng-container i18n="@@publico.categoria.n-inscritos"
              >{{ d.entrants.length }}
              @if (d.category.is_team) {
                equipos
              } @else {
                competidores
              }
            </ng-container>
          </p>
        </section>

        @if (d.podium.length) {
          <details class="res" open>
            <summary i18n="@@publico.categoria.resultados">Resultados</summary>
            <ol class="podium">
              @for (p of d.podium; track $index) {
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
          </details>
        }

        @if (d.standings?.length) {
          <h2 i18n="@@publico.categoria.puntuaciones-tabla" class="sec">{d.format, select,
            kata_rounds {Puntuaciones}
            other {Tabla}
          }</h2>
          <table class="table">
            <thead>
              <tr>
                <th>#</th>
                <th i18n="@@publico.categoria.competidor">Competidor</th>
                @if (d.format === 'kata_rounds') {
                  <th i18n="@@publico.categoria.kata">Kata</th>
                  <th i18n="@@publico.categoria.nota">Nota</th>
                } @else {
                  <th i18n="@@publico.categoria.ganados">Ganados</th>
                  <th i18n="@@publico.categoria.jugados">Jugados</th>
                  <th i18n="@@publico.categoria.puntos">Puntos</th>
                }
              </tr>
            </thead>
            <tbody>
              @for (s of d.standings!; track $index) {
                <tr>
                  <td>{{ s.rank ?? '—' }}</td>
                  <td>
                    @if (link(s.public_id); as l) {
                      <a class="plink" [routerLink]="l">{{ s.name }}</a>
                    } @else {
                      {{ s.name }}
                    }
                    <span class="muted">{{ s.dojo }}</span>
                  </td>
                  @if (d.format === 'kata_rounds') {
                    <td>{{ s.kata_name ?? '—' }}</td>
                    <td>{{ s.total ?? '—' }}</td>
                  } @else {
                    <td>{{ s.wins ?? 0 }}</td>
                    <td>{{ s.played ?? 0 }}</td>
                    <td>{{ s.points_for ?? 0 }}</td>
                  }
                </tr>
              }
            </tbody>
          </table>
        }

        @if (rounds().length) {
          <h2 i18n="@@publico.categoria.llave" class="sec">Llave</h2>
          <div
            i18n-aria-label="@@publico.categoria.llave-rondas"
            class="bracket"
            role="list"
            aria-label="Llave por rondas"
          >
            @for (r of rounds(); track r.round) {
              <section class="round" role="listitem" [attr.aria-label]="r.label">
                <h3>{{ r.label }}</h3>
                <div class="ms">
                  @for (m of r.matches; track m.code) {
                    <ng-container
                      [ngTemplateOutlet]="match"
                      [ngTemplateOutletContext]="{ $implicit: m }"
                    />
                  }
                </div>
              </section>
            }
          </div>
        }
        @if (extra().length) {
          <h2 i18n="@@publico.categoria.combates-otros" class="sec">{d.format, select,
            round_robin {Combates}
            other {Otros combates}
          }</h2>
          <div class="extra">
            @for (m of extra(); track m.code) {
              <ng-container
                [ngTemplateOutlet]="match"
                [ngTemplateOutletContext]="{ $implicit: m }"
              />
            }
          </div>
        }
        @if (!d.format) {
          <h2 i18n="@@publico.categoria.inscritos" class="sec">Inscritos</h2>
          <ul class="list">
            @for (e of d.entrants; track $index) {
              <li>
                {{ e.name }} <span class="muted">{{ e.dojo }}</span>
              </li>
            } @empty {
              <li i18n="@@publico.categoria.sin-inscritos-todavia" class="muted"
                >Sin inscritos todavía.</li
              >
            }
          </ul>
          <p i18n="@@publico.categoria.llave-publica-cuando" class="muted"
            >La llave se publica cuando la organización la genera.</p
          >
        }
      } @else if (error()) {
        <section class="hero">
          <h1 i18n="@@publico.categoria.categoria-no-disponible">Categoría no disponible</h1>
          <p>{{ error() }}</p>
        </section>
      } @else {
        <p i18n="@@publico.categoria.cargando" class="muted">Cargando…</p>
      }
    </div>

    <ng-template #match let-m>
      <article
        class="m"
        [class.done]="m.status === 'finished'"
        [class.live]="m.status === 'in_progress'"
      >
        <div class="meta">
          <span class="code">{{ m.code }}</span>
          @if (kindLabel[m.kind]) {
            <span>{{ kindLabel[m.kind] }}</span>
          }
          @if (m.status === 'in_progress') {
            <span i18n="@@publico.categoria.curso" class="now">En curso</span>
          }
          @if (m.status === 'finished' && m.method) {
            <span>{{ method(m.method) }}</span>
          }
        </div>
        <div class="side aka" [class.won]="m.winner === 'aka'" [class.lost]="m.winner === 'ao'">
          <span class="nm">
            @if (link(m.aka?.public_id); as l) {
              <a class="plink" [routerLink]="l">{{ m.aka?.name }}</a>
            } @else {
              {{ m.aka?.name ?? txtPorDefinir }}
            }
          </span>
          <span class="dj">{{ m.aka?.dojo }}</span>
          @if (showScore(m)) {
            <span class="pts">{{ m.score[0] }}</span>
          }
        </div>
        <div class="side ao" [class.won]="m.winner === 'ao'" [class.lost]="m.winner === 'aka'">
          <span class="nm">
            @if (link(m.ao?.public_id); as l) {
              <a class="plink" [routerLink]="l">{{ m.ao?.name }}</a>
            } @else {
              {{ m.ao?.name ?? txtPorDefinir }}
            }
          </span>
          <span class="dj">{{ m.ao?.dojo }}</span>
          @if (showScore(m)) {
            <span class="pts">{{ m.score[1] }}</span>
          }
        </div>
      </article>
    </ng-template>
  `,
  styleUrls: ['./live.scss', './category.scss'],
})
export class PublicCategoryPage {
  readonly txtTorneo = $localize`:@@publico.categoria.torneo:Torneo`;
  readonly txtPorDefinir = $localize`:@@comun.por-definir:Por definir`;
  private api = inject(ApiService);
  private meta = inject(Meta);
  private title = inject(Title);
  readonly token = input<string | undefined>(undefined);
  readonly slug = input<string | undefined>(undefined);
  readonly id = input.required<string>();
  readonly data = signal<PublicCategory | null>(null);
  readonly error = signal('');
  readonly kindLabel = KIND_LABEL;
  readonly link = personLink;

  readonly back = computed(() => (this.slug() ? `/t/${this.slug()}` : `/vivo/${this.token()}`));
  private readonly apiPath = computed(() => {
    const base = this.slug()
      ? `/public/t/${encodeURIComponent(this.slug()!)}`
      : `/public/${encodeURIComponent(this.token() ?? '')}`;
    return `${base}/categories/${encodeURIComponent(this.id())}`;
  });
  readonly rounds = computed(() =>
    this.data()?.format === 'single_elimination' ? bracketRounds(this.data()!.matches) : [],
  );
  readonly extra = computed<PublicBracketMatch[]>(() => {
    const d = this.data();
    if (!d) return [];
    return d.format === 'single_elimination'
      ? d.matches.filter((m) => m.kind !== 'main')
      : d.matches;
  });

  constructor() {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') this.load();
    }, REFRESH_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
    effect(() => {
      this.apiPath();
      untracked(() => this.load());
    });
  }

  async load(): Promise<void> {
    try {
      const d = await firstValueFrom(this.api.get<PublicCategory>(this.apiPath()));
      this.data.set(d);
      this.error.set('');
      this.title.setTitle(
        $localize`:@@publico.categoria.hajime-vivo:${d.category.name}:name: · ${d.tournament.name}:name_2: · Hajime en vivo`,
      );
      this.meta.updateTag(
        { property: 'og:title', content: `${d.category.name} · ${d.tournament.name}` },
        'property="og:title"',
      );
    } catch (e) {
      const err = ApiError.from(e);
      if (err.status === 404) {
        this.data.set(null);
        this.error.set(err.message);
      }
    }
  }

  status(s: string): string {
    return STATUS[s] ?? s;
  }

  method(m: string): string {
    return methodText(m);
  }

  showScore(m: PublicBracketMatch): boolean {
    return (m.status === 'finished' || m.status === 'in_progress') && m.method !== 'flags';
  }
}
