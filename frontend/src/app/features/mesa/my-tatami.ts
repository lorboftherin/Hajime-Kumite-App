import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiError } from '../../core/api-error';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { QueueItem, TatamiQueue } from '../../core/models';
import { tatamiScopes } from '../../core/roles';
import { StatusBadge } from '../../shared/badge';
import { Icon } from '../../shared/icon';
import { PageHead } from '../../shared/page-head';
import { PluralPipe } from '../../shared/plural';

interface View {
  id: number;
  data: TatamiQueue | null;
  error: string;
}

/**
 * «Mi tatami»: el operador de mesa de un tatami entra directo aquí. Ve el combate en curso y
 * los siguientes de SU tatami, con un botón grande para abrir la mesa. Se actualiza cada 10 s.
 */
@Component({
  selector: 'app-my-tatami',
  imports: [RouterLink, PageHead, Icon, StatusBadge, PluralPipe],
  template: `
    <div class="container">
      <app-page-head kanji="畳" title="Mi tatami">
        <div meta class="meta-line">
          <span>Combates de tu tatami, en el orden de la planilla</span>
        </div>
        <button class="btn icon-only ghost" (click)="load()" title="Actualizar" aria-label="Actualizar"><app-icon name="refresh" /></button>
      </app-page-head>

      @for (v of views(); track v.id) {
        <section class="card tatami" [attr.aria-label]="v.data ? tname(v.data) : 'Tatami'">
          @if (v.data; as q) {
            <div class="t-head">
              <h2>{{ tname(q) }}</h2>
              @if (q.progress; as pr) {
                <span class="muted small num">{{ pr.done }} de {{ pr.total | plural: 'combate' : 'combates' }}</span>
              }
            </div>
            @if (next(q); as it) {
              <a class="go" [routerLink]="['/mesa', it.match.id]" [queryParams]="{ tatami: q.tatami.id }">
                <span class="go-kicker">{{ it.match.status === 'in_progress' ? 'Combate en curso' : 'Siguiente combate' }}</span>
                <span class="go-main">{{ it.match.status === 'in_progress' ? 'Abrir combate en curso' : 'Abrir siguiente combate' }} →</span>
                <span class="go-sub"><span class="num">{{ it.number }}</span> · {{ it.category_name }}</span>
                <span class="go-vs">
                  <span class="aka">{{ pname(q, it.match.aka_registration_id) }}</span>
                  <span class="vs" aria-hidden="true">vs</span>
                  <span class="ao">{{ pname(q, it.match.ao_registration_id) }}</span>
                </span>
              </a>
            } @else {
              <div class="empty-q">
                <p><strong>No hay combates listos en este tatami.</strong></p>
                <p class="small muted">Cuando el organizador genere las llaves o termine la ronda anterior, aparecerán aquí.</p>
              </div>
            }
            @if (rest(q).length) {
              <div class="label">Después</div>
              <ol class="queue">
                @for (it of rest(q); track it.match.id) {
                  <li>
                    <a [routerLink]="['/mesa', it.match.id]" [queryParams]="{ tatami: q.tatami.id }">
                      <span class="num n">{{ it.number }}</span>
                      <span class="grow">
                        <span class="cat">{{ it.category_name }}</span>
                        <span class="small"><span class="aka">{{ pname(q, it.match.aka_registration_id) }}</span> · <span class="ao">{{ pname(q, it.match.ao_registration_id) }}</span></span>
                      </span>
                      @if (it.match.status !== 'ready') {
                        <app-status [status]="it.match.status" type="match" />
                      }
                    </a>
                  </li>
                }
              </ol>
            }
            @if (q.conflicts.length) {
              <div class="alert warn small mt">
                <strong>Con combates pendientes en otro tatami:</strong>
                {{ conflictNames(q) }}
              </div>
            }
          } @else if (v.error) {
            <div class="alert danger small">{{ v.error }}</div>
          } @else {
            <span class="spinner"></span>
          }
        </section>
      } @empty {
        <div class="card empty">
          <p><strong>No tienes un tatami asignado.</strong></p>
          Pide al organizador que te asigne como operador de mesa de un tatami, o revisa
          <a routerLink="/torneos">los torneos</a>.
        </div>
      }
    </div>
  `,
  styles: `
    .tatami {
      max-width: 44rem;
    }
    .t-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 0.75rem;
      margin-bottom: 0.75rem;
      h2 {
        margin: 0;
      }
    }
    .go {
      display: flex;
      flex-direction: column;
      gap: 0.3rem;
      padding: 1.1rem 1.25rem;
      border-radius: var(--radius);
      background: var(--sumi);
      color: var(--on-sumi);
      text-decoration: none !important;
      box-shadow: var(--shadow-soft);
      transition: transform var(--dur-1) var(--ease);
      &:hover {
        transform: translateY(-1px);
      }
      &:focus-visible {
        outline: 3px solid var(--ai);
        outline-offset: 3px;
      }
    }
    .go-kicker {
      font-size: var(--fs-12);
      text-transform: uppercase;
      letter-spacing: 0.1em;
      opacity: 0.8;
    }
    .go-main {
      font-family: var(--font-display);
      font-size: var(--fs-28);
      font-weight: 700;
      line-height: 1.15;
    }
    .go-sub {
      font-size: var(--fs-14);
      opacity: 0.9;
    }
    .go-vs {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 0.4rem;
      margin-top: 0.25rem;
      font-weight: 700;
      .vs {
        opacity: 0.7;
        font-weight: 400;
      }
    }
    .go .aka {
      border-bottom: 3px solid var(--shu);
    }
    .go .ao {
      border-bottom: 3px solid var(--ai-ink);
    }
    .label {
      font-size: var(--fs-12);
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--nezumi-ink);
      margin: 1.25rem 0 0.5rem;
    }
    .queue {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
      a {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        min-height: 3rem;
        padding: 0.5rem 0.75rem;
        border: 1px solid var(--kasumi);
        border-radius: var(--radius-sm);
        background: var(--kinu);
        color: var(--sumi);
        text-decoration: none;
        &:hover {
          background: var(--hover);
        }
      }
      .grow {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }
      .cat {
        font-weight: 700;
      }
      .n {
        font-weight: 700;
        min-width: 4.5rem;
      }
      .aka {
        color: var(--shu-ink);
      }
      .ao {
        color: var(--ai-ink);
      }
    }
    .empty-q {
      padding: 1rem;
      border: 1px dashed var(--kasumi-2);
      border-radius: var(--radius-sm);
      p {
        margin: 0 0 0.25rem;
      }
    }
  `,
})
export class MyTatamiPage {
  private api = inject(ApiService);
  private auth = inject(AuthService);

  readonly ids = computed(() => tatamiScopes(this.auth.user()));
  readonly views = signal<View[]>([]);

  constructor() {
    this.views.set(this.ids().map((id) => ({ id, data: null, error: '' })));
    this.load();
    const timer = setInterval(() => this.load(), 10000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  async load(): Promise<void> {
    const views = await Promise.all(
      this.ids().map(async (id): Promise<View> => {
        try {
          return { id, data: await firstValueFrom(this.api.get<TatamiQueue>(`/tatamis/${id}/queue`)), error: '' };
        } catch (e) {
          const prev = this.views().find((v) => v.id === id);
          // Sin señal se conserva lo último que se vio.
          return { id, data: prev?.data ?? null, error: prev?.data ? '' : ApiError.from(e).fullMessage };
        }
      }),
    );
    this.views.set(views);
  }

  tname(q: TatamiQueue): string {
    return q.tatami.name || `Tatami ${q.tatami.number}`;
  }

  /** El combate en curso o, si no hay, el siguiente listo. */
  next(q: TatamiQueue): QueueItem | null {
    return q.current ?? q.queue.find((it) => it.match.status === 'ready') ?? q.queue[0] ?? null;
  }

  rest(q: TatamiQueue): QueueItem[] {
    const n = this.next(q);
    return q.queue.filter((it) => it.match.id !== n?.match.id).slice(0, 8);
  }

  pname(q: TatamiQueue, rid: number | null): string {
    if (!rid) return 'Por definir';
    return q.participants[rid]?.name ?? `#${rid}`;
  }

  conflictNames(q: TatamiQueue): string {
    return q.conflicts.map((c) => c.name).join(', ');
  }
}
