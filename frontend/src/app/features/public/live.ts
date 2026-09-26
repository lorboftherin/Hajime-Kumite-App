import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { Component, DestroyRef, effect, inject, input, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiError } from '../../core/api-error';
import { ApiService } from '../../core/api.service';
import { PublicLive, PublicMatch } from '../../core/models';
import { Enso, HajimeWord } from '../../shared/enso';

// Cada consulta pasa por la caché HTTP del navegador: el servidor responde con
// ETag y `Cache-Control: max-age` (HAJIME_PUBLIC_CACHE_SECONDS). Si nada cambió,
// el navegador revalida con If-None-Match, recibe 304 sin cuerpo y entrega la
// respuesta anterior como un 200 normal: aquí no hace falta manejar el 304.
const REFRESH_MS = 5000;

/**
 * Hajime en vivo: la vista pública del torneo para familias y público (como el
 * seguimiento en vivo de CricHeroes). Sin inicio de sesión; solo existe si el
 * organizador activó el enlace. Se actualiza sola cada pocos segundos.
 */
@Component({
  selector: 'app-public-live',
  imports: [Enso, HajimeWord, DatePipe, NgTemplateOutlet],
  template: `
    <div class="page">
      <header class="top">
        <div class="brand"><app-enso class="mark" /><app-hajime-word class="word" /><span class="live-tag">en vivo</span></div>
        @if (data(); as d) {
          <span class="pulse" [class.stale]="stale()" role="status">
            <i aria-hidden="true"></i>{{ stale() ? 'Reconectando…' : 'Actualizado ' + (updated() | date: 'HH:mm:ss') }}
          </span>
        }
      </header>

      @if (data(); as d) {
        <section class="hero">
          <h1>{{ d.tournament.name }}</h1>
          <p>{{ d.tournament.start_date | date: 'd MMM y' }}@if (d.tournament.venue) { · {{ d.tournament.venue }}}@if (d.tournament.city) {, {{ d.tournament.city }}}</p>
        </section>

        <nav class="jump" aria-label="Secciones">
          <a href="#tatamis" (click)="go($event, 'tatamis')">Tatamis</a>
          @if (d.awards.length) {<a href="#premios" (click)="go($event, 'premios')">Premios</a>}
          <a href="#resultados" (click)="go($event, 'resultados')">Resultados</a>
          <a href="#medallero" (click)="go($event, 'medallero')">Medallero</a>
        </nav>

        <section id="tatamis" class="tatamis" aria-label="Tatamis">
          @for (t of d.tatamis; track t.id) {
            <article class="tat">
              <header>
                <h2>{{ t.name }}</h2>
                <span class="prog">{{ t.done }} de {{ t.total }} combates</span>
              </header>
              @if (t.current; as m) {
                <div class="now">
                  <div class="kicker"><span class="dot" aria-hidden="true"></span>En curso · {{ m.category }} · {{ m.number }}</div>
                  @if (m.bout; as b) {
                    <div class="teamline">{{ m.aka?.name }} <strong>{{ m.score[0] }}–{{ m.score[1] }}</strong> {{ m.ao?.name }} · combate individual</div>
                    <ng-container *ngTemplateOutlet="board; context: { $implicit: b }" />
                  } @else {
                    <ng-container *ngTemplateOutlet="board; context: { $implicit: m }" />
                  }
                </div>
              } @else {
                <p class="idle">Sin combate en curso.</p>
              }
              @if (t.upcoming.length) {
                <div class="next">
                  <span class="lbl">Siguen</span>
                  <ol>
                    @for (u of t.upcoming; track u.code + u.category) {
                      <li>
                        <span class="n">{{ u.number }}</span>
                        <span class="vs"><span class="aka">{{ u.aka?.name ?? 'Por definir' }}</span> vs <span class="ao">{{ u.ao?.name ?? 'Por definir' }}</span></span>
                        <span class="cat">{{ u.category }}</span>
                      </li>
                    }
                  </ol>
                </div>
              }
              @if (t.last; as l) {
                <p class="last">
                  Último: {{ winnerName(l) }} ganó {{ l.score[0] }}–{{ l.score[1] }} · {{ l.category }}
                </p>
              }
            </article>
          } @empty {
            <p class="idle">El torneo todavía no tiene tatamis.</p>
          }
        </section>

        @if (d.awards.length) {
          <section id="premios" aria-labelledby="h-premios">
            <h2 id="h-premios" class="sec">Premios del torneo</h2>
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
          <h2 id="h-res" class="sec">Resultados <span class="muted">{{ d.results.length }} categoría(s) finalizada(s)</span></h2>
          @for (r of d.results; track r.category) {
            <details class="res">
              <summary>{{ r.category }}</summary>
              <ol class="podium">
                @for (p of r.places; track $index) {
                  <li><span class="place p{{ p.place }}">{{ p.place }}</span><span class="grow">{{ p.name }}</span><span class="muted">{{ p.dojo }}</span></li>
                }
              </ol>
            </details>
          } @empty {
            <p class="idle">Todavía no hay categorías finalizadas.</p>
          }
        </section>

        <section id="medallero" aria-labelledby="h-med">
          <h2 id="h-med" class="sec">Medallero por dojo</h2>
          @if (d.medal_table.length) {
            <table class="medals">
              <thead><tr><th>#</th><th>Dojo</th><th title="Oro">Oro</th><th title="Plata">Plata</th><th title="Bronce">Bronce</th></tr></thead>
              <tbody>
                @for (m of d.medal_table; track m.dojo_name) {
                  <tr><td>{{ m.rank }}</td><td>{{ m.dojo_name }}</td><td>{{ m.gold }}</td><td>{{ m.silver }}</td><td>{{ m.bronze }}</td></tr>
                }
              </tbody>
            </table>
          } @else {
            <p class="idle">Sin medallas todavía.</p>
          }
        </section>

        <footer class="foot">Datos publicados por la organización del torneo. Hajime · Torneos de karate.</footer>
      } @else if (error()) {
        <section class="hero"><h1>Enlace no disponible</h1><p>{{ error() }}</p></section>
      } @else {
        <p class="idle">Cargando…</p>
      }
    </div>

    <ng-template #board let-m>
      <div class="board">
        <div class="s aka" [class.won]="m.winner === 'aka'">
          <span class="nm">{{ m.aka?.name ?? '—' }}</span><span class="dj">{{ m.aka?.dojo }}</span>
        </div>
        <div class="sc"><span>{{ m.score[0] }}</span><span class="d">–</span><span>{{ m.score[1] }}</span></div>
        <div class="s ao" [class.won]="m.winner === 'ao'">
          <span class="nm">{{ m.ao?.name ?? '—' }}</span><span class="dj">{{ m.ao?.dojo }}</span>
        </div>
      </div>
    </ng-template>
  `,
  styleUrl: './live.scss',
})
export class PublicLivePage {
  private api = inject(ApiService);
  readonly token = input.required<string>();
  readonly data = signal<PublicLive | null>(null);
  readonly error = signal('');
  readonly updated = signal<Date | null>(null);
  readonly stale = signal(false);

  constructor() {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') this.load();
    }, REFRESH_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
    effect(() => {
      this.token();
      untracked(() => this.load());
    });
  }

  async load(): Promise<void> {
    try {
      const d = await firstValueFrom(this.api.get<PublicLive>(`/public/${encodeURIComponent(this.token())}`));
      this.data.set(d);
      this.updated.set(new Date());
      this.stale.set(false);
      this.error.set('');
    } catch (e) {
      const err = ApiError.from(e);
      if (err.status === 404) {
        this.data.set(null);
        this.error.set(err.message);
      } else {
        this.stale.set(true);
      }
    }
  }

  winnerName(m: PublicMatch): string {
    if (m.winner === 'aka') return m.aka?.name ?? 'AKA';
    if (m.winner === 'ao') return m.ao?.name ?? 'AO';
    return 'Empate';
  }

  go(ev: Event, id: string): void {
    ev.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}
