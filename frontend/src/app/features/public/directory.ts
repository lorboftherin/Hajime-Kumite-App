import { DatePipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Meta, Title } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { Enso, HajimeWord } from '../../shared/enso';
import { LanguageSelect } from '../../shared/language-select';
import { matchesQuery } from './public-logic';
import { DirectoryTournament, PublicDirectory } from './public-models';
import { SHARE_IMAGE } from './share-meta';
import { lista } from '../../core/i18n/etiquetas';

interface Group {
  key: 'live' | 'upcoming' | 'recent';
  title: string;
  empty: string;
}

const GROUPS: Group[] = lista(() => [
  { key: 'live', title: $localize`:@@publico.directorio.curso:En curso`, empty: $localize`:@@publico.directorio.ningun-torneo-curso-ahora:Ningún torneo en curso ahora.` },
  { key: 'upcoming', title: $localize`:@@publico.directorio.proximos:Próximos`, empty: $localize`:@@publico.directorio.no-hay-torneos-proximos:No hay torneos próximos publicados.` },
  { key: 'recent', title: $localize`:@@publico.directorio.recientes:Recientes`, empty: $localize`:@@publico.directorio.sin-torneos-recientes:Sin torneos recientes.` },
]);

/**
 * Directorio público de torneos (`/torneos-publicos`): los que activaron la
 * página pública y no son de prueba. Buscador por nombre y ciudad (en el
 * navegador, sin tildes: «cusco» encuentra «Cusco»).
 */
@Component({
  selector: 'app-public-directory',
  imports: [RouterLink, FormsModule, DatePipe, Enso, HajimeWord, LanguageSelect],
  template: `
    <div class="page">
      <header class="top">
        <span class="brand"><app-enso class="mark" /><app-hajime-word class="word" /></span>
        <a i18n="@@publico.directorio.ingresar" class="login" routerLink="/login">Ingresar</a>
      </header>
      <section class="hero">
        <h1 i18n="@@publico.directorio.torneos-karate">Torneos de karate</h1>
        <p i18n="@@publico.directorio.sigue-vivo-combates-horarios">
          Sigue en vivo los combates, horarios, llaves y resultados de los torneos que usan Hajime.
        </p>
      </section>
      <label class="search">
        <span i18n="@@publico.directorio.buscar-nombre-ciudad" class="sr-only">Buscar por nombre o ciudad</span>
        <input i18n-placeholder="@@publico.directorio.buscar-nombre-ciudad-2"
          type="search"
          [ngModel]="query()"
          (ngModelChange)="query.set($event)"
          placeholder="Buscar por nombre o ciudad"
          autocomplete="off"
        />
      </label>
      @if (data(); as d) {
        @for (g of groups; track g.key) {
          @let list = filtered()[g.key];
          @if (list.length || !query()) {
            <section [attr.aria-labelledby]="'h-' + g.key">
              <h2 class="sec" [id]="'h-' + g.key">{{ g.title }}</h2>
              @if (list.length) {
                <ul class="cards">
                  @for (t of list; track t.slug) {
                    <li>
                      <a
                        class="tcard"
                        [class.live]="g.key === 'live'"
                        [routerLink]="['/t', t.slug]"
                      >
                        @if (g.key === 'live') {
                          <span i18n="@@publico.directorio.vivo" class="badge-live">En vivo</span>
                        }
                        <strong>{{ t.name }}</strong>
                        <span class="muted">
                          {{ t.start_date | date: 'd MMM y' }}
                          @if (t.end_date && t.end_date !== t.start_date) {
                            – {{ t.end_date | date: 'd MMM' }}
                          }
                          @if (t.city) {
                            · {{ t.city }}
                          }
                        </span>
                        @if (t.venue) {
                          <span class="muted small">{{ t.venue }}</span>
                        }
                      </a>
                    </li>
                  }
                </ul>
              } @else {
                <p class="idle">{{ g.empty }}</p>
              }
            </section>
          }
        }
        @if (query() && !total()) {
          <p i18n="@@publico.directorio.ningun-torneo-coincide" class="idle">Ningún torneo coincide con «{{ query() }}».</p>
        }
      } @else if (error()) {
        <p class="idle">{{ error() }}</p>
      } @else {
        <p i18n="@@publico.directorio.cargando" class="idle">Cargando…</p>
      }
      <footer class="foot"><ng-container i18n="@@publico.directorio.hajime-torneos-karate-solo">
        Hajime · Torneos de karate. Solo se publican nombres, dojos y resultados.
        </ng-container><div class="foot-lang"><app-language-select /></div>
      </footer>
    </div>
  `,
  styleUrls: ['./live.scss', './directory.scss'],
})
export class PublicDirectoryPage {
  private api = inject(ApiService);
  readonly groups = GROUPS;
  readonly data = signal<PublicDirectory | null>(null);
  readonly error = signal('');
  readonly query = signal('');

  readonly filtered = computed(() => {
    const d = this.data()?.tournaments ?? { live: [], upcoming: [], recent: [] };
    const q = this.query();
    const pick = (list: DirectoryTournament[]) =>
      q.trim() ? list.filter((t) => matchesQuery(`${t.name} ${t.city} ${t.venue}`, q)) : list;
    return { live: pick(d.live), upcoming: pick(d.upcoming), recent: pick(d.recent) };
  });
  readonly total = computed(() => {
    const f = this.filtered();
    return f.live.length + f.upcoming.length + f.recent.length;
  });

  constructor() {
    const title = inject(Title);
    const meta = inject(Meta);
    title.setTitle($localize`:@@publico.directorio.torneos-karate-vivo-hajime:Torneos de karate en vivo · Hajime`);
    const desc = $localize`:@@publico.directorio.torneos-karate-vivo-combates:Torneos de karate en vivo: combates, horarios, llaves y resultados.`;
    meta.updateTag({ name: 'description', content: desc }, 'name="description"');
    meta.updateTag(
      { property: 'og:title', content: $localize`:@@publico.directorio.torneos-karate-vivo-hajime:Torneos de karate en vivo · Hajime` },
      'property="og:title"',
    );
    meta.updateTag({ property: 'og:description', content: desc }, 'property="og:description"');
    meta.updateTag(
      { property: 'og:image', content: `${location.origin}/${SHARE_IMAGE}` },
      'property="og:image"',
    );
    this.load();
  }

  async load(): Promise<void> {
    try {
      this.data.set(await firstValueFrom(this.api.get<PublicDirectory>('/public/torneos')));
    } catch {
      this.error.set(
        $localize`:@@publico.directorio.no-pudo-cargar-lista-torneos:No se pudo cargar la lista de torneos. Revisa la conexión y vuelve a intentar.`,
      );
    }
  }
}
