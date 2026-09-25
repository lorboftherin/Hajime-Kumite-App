import { Component, DestroyRef, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../../core/api.service';
import { DialogService } from '../../../core/dialog.service';
import { FilesService } from '../../../core/files.service';
import { QueueItem, Tatami, TatamiQueue } from '../../../core/models';
import { MutationService } from '../../../core/mutation.service';
import { StatusBadge } from '../../../shared/badge';
import { Icon } from '../../../shared/icon';
import { TournamentContext } from '../tournament-context';

interface TatamiView {
  tatami: Tatami;
  data: TatamiQueue | null;
  error?: string;
}

@Component({
  selector: 'app-tatamis-tab',
  imports: [RouterLink, StatusBadge, Icon],
  template: `
    <div class="toolbar">
      <span class="muted small grow">Se actualiza cada 15 s. Asigna categorías a un tatami desde la pestaña Categorías.</span>
      <button class="btn icon-only ghost" (click)="load()" title="Actualizar" aria-label="Actualizar"><app-icon name="refresh" /></button>
      <button class="btn" (click)="addTatami()"><app-icon name="plus" /> Agregar tatami</button>
    </div>
    <div class="tatamis">
      @for (v of views(); track v.tatami.id) {
        <section class="card tatami">
          <div class="tatami-head">
            <h2>{{ v.tatami.name || 'Tatami ' + v.tatami.number }}</h2>
            <button class="btn sm ghost" (click)="scoresheet(v.tatami.id)" title="Registro oficial en papel para Shadow Mode"><app-icon name="print" /> Planilla PDF</button>
          </div>
          @if (v.data; as q) {
            @if (q.progress; as pr) {
              <div class="progress" [attr.aria-label]="pr.done + ' de ' + pr.total + ' combates'">
                <div class="bar"><span [style.width.%]="pr.total ? (100 * pr.done) / pr.total : 0"></span></div>
                <span class="small muted num">{{ pr.done }} de {{ pr.total }} combates</span>
              </div>
            }
            <div class="people small">
              <div class="line">
                <span class="muted">Operando ahora:</span>
                @for (o of q.operators ?? []; track o.user) {
                  <span class="op"><i aria-hidden="true"></i>{{ o.user }}<span class="muted">· {{ o.matches.join(', ') }}</span></span>
                } @empty {
                  <span class="muted">nadie</span>
                }
                @if ((q.operators?.length ?? 0) > 1) {
                  <span class="badge yamabuki">varias tablets</span>
                }
              </div>
              @if (q.assigned_operators?.length) {
                <div class="line"><span class="muted">Operadores del tatami:</span><span>{{ q.assigned_operators!.join(', ') }}</span></div>
              }
              @if (q.referees?.length) {
                <div class="line">
                  <span class="muted">Árbitros:</span>
                  @for (r of q.referees!; track $index) {
                    <span class="ref">{{ r.name }}@if (r.position) {<span class="muted">· {{ r.position }}</span>}</span>
                  }
                </div>
              }
            </div>
            @if (q.conflicts.length) {
              <div class="alert warn small">
                <strong>Competidores con combates pendientes en otro tatami:</strong>
                <ul>
                  @for (c of q.conflicts; track c.registration_id) {
                    <li>{{ c.name }}</li>
                  }
                </ul>
              </div>
            }
            <div class="label">Combate actual</div>
            @if (q.current; as cur) {
              <div class="match current">
                <div class="grow">
                  <div class="m-meta"><span class="badge matcha live">En curso</span> <span class="num n">{{ cur.number }}</span> {{ cur.category_name }} <span class="code">{{ cur.match.code }}</span></div>
                  <div class="fighter aka"><span class="pname">{{ pname(q, cur.match.aka_registration_id) }}</span> <small class="muted">{{ pdojo(q, cur.match.aka_registration_id) }}</small><span class="pts num">{{ cur.match.aka_score ?? 0 }}</span></div>
                  <div class="fighter ao"><span class="pname">{{ pname(q, cur.match.ao_registration_id) }}</span> <small class="muted">{{ pdojo(q, cur.match.ao_registration_id) }}</small><span class="pts num">{{ cur.match.ao_score ?? 0 }}</span></div>
                </div>
                <a class="btn primary" [routerLink]="['/mesa', cur.match.id]" [queryParams]="{ tatami: v.tatami.id }"><app-icon name="open" /> Abrir mesa</a>
              </div>
            } @else {
              <div class="muted small quiet">Ninguno en curso.</div>
            }
            <div class="label">Siguiente y en espera</div>
            @for (it of waiting(q); track it.match.id; let i = $index) {
              <div class="match" [class.next]="i === 0">
                <div class="grow">
                  <div class="m-meta">
                    @if (i === 0) {
                      <span class="badge ai">Siguiente</span>
                    }
                    <span class="num n">{{ it.number }}</span> {{ it.category_name }} <span class="code">{{ it.match.code }}</span>
                    @if (it.match.status !== 'ready') {
                      <app-status [status]="it.match.status" type="match" />
                    }
                  </div>
                  <div class="fighter aka"><span class="pname">{{ pname(q, it.match.aka_registration_id) }}</span> <small class="muted">{{ pdojo(q, it.match.aka_registration_id) }}</small></div>
                  <div class="fighter ao"><span class="pname">{{ pname(q, it.match.ao_registration_id) }}</span> <small class="muted">{{ pdojo(q, it.match.ao_registration_id) }}</small></div>
                </div>
                <a class="btn sm" [routerLink]="['/mesa', it.match.id]" [queryParams]="{ tatami: v.tatami.id }">Mesa</a>
              </div>
            } @empty {
              <div class="muted small quiet">Cola vacía.</div>
            }
          } @else if (v.error) {
            <div class="alert danger small">{{ v.error }}</div>
          } @else {
            <span class="spinner"></span>
          }
        </section>
      } @empty {
        <div class="card empty"><p><strong>El torneo no tiene tatamis.</strong></p>Agrega uno para empezar a programar combates.</div>
      }
    </div>
  `,
  styles: `
    .tatamis {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
      gap: 1.25rem;
      align-items: start;
    }
    @media (max-width: 767px) {
      .tatamis {
        grid-template-columns: 1fr;
      }
    }
    .tatami {
      margin: 0;
    }
    .progress {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      margin: 0.35rem 0 0.5rem;
      .bar {
        flex: 1;
        height: 6px;
        border-radius: 3px;
        background: var(--kasumi);
        overflow: hidden;
        span {
          display: block;
          height: 100%;
          border-radius: 3px;
          background: var(--matcha);
        }
      }
    }
    .people {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
      margin-bottom: 0.5rem;
      .line {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.2rem 0.6rem;
      }
      .op,
      .ref {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
      }
      .op i {
        display: inline-block;
        width: 7px;
        height: 7px;
        margin-right: 0.3rem;
        border-radius: 50%;
        background: var(--matcha);
        vertical-align: middle;
      }
    }
    .pts {
      margin-left: auto;
      padding-left: 0.75rem;
      font-weight: 800;
      font-size: 1.1rem;
    }
    .tatami-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      margin-bottom: 0.25rem;
      h2 {
        margin: 0;
      }
    }
    .label {
      font-size: var(--fs-12);
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--nezumi-ink);
      margin: 1.25rem 0 0.5rem;
    }
    .quiet {
      padding: 0.25rem 0;
    }
    .match {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.75rem 0.85rem;
      border: 1px solid var(--kasumi);
      border-radius: var(--radius-sm);
      margin-bottom: 0.5rem;
      background: var(--kinu);
      font-size: var(--fs-14);
    }
    .match.current {
      border-color: color-mix(in srgb, var(--matcha) 45%, var(--kasumi));
      background: color-mix(in srgb, var(--matcha-soft) 55%, var(--kinu));
    }
    .match.next {
      border-color: color-mix(in srgb, var(--ai) 35%, var(--kasumi));
    }
    .m-meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.4rem;
      margin-bottom: 0.4rem;
      color: var(--sumi-2);
      .n {
        font-weight: 700;
        color: var(--sumi);
      }
    }
    .fighter {
      display: flex;
      align-items: baseline;
      gap: 0.35rem;
      padding: 0.1rem 0 0.1rem 0.65rem;
      border-left: 3px solid transparent;
      line-height: 1.5;
      &.aka {
        border-left-color: var(--shu);
      }
      &.ao {
        border-left-color: var(--ai);
      }
      .pname {
        font-weight: 500;
      }
      small {
        margin-left: 0.4rem;
      }
    }
  `,
})
export class TatamisTab {
  readonly ctx = inject(TournamentContext);
  private api = inject(ApiService);
  private files = inject(FilesService);
  private mut = inject(MutationService);
  private dialog = inject(DialogService);
  readonly views = signal<TatamiView[]>([]);

  constructor() {
    this.load();
    const timer = setInterval(() => this.load(), 15000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  async load(): Promise<void> {
    await this.ctx.reload();
    const tatamis = this.ctx.tournament()?.tatamis ?? [];
    const views = await Promise.all(
      tatamis.map(async (t): Promise<TatamiView> => {
        try {
          return { tatami: t, data: await firstValueFrom(this.api.get<TatamiQueue>(`/tatamis/${t.id}/queue`)) };
        } catch (e: any) {
          return { tatami: t, data: null, error: e?.message ?? 'Error' };
        }
      }),
    );
    this.views.set(views);
  }

  waiting(q: TatamiQueue): QueueItem[] {
    return q.queue.filter((it) => it.match.id !== q.current?.match.id);
  }

  scoresheet(tatamiId: number): void {
    this.files.open(`/tatamis/${tatamiId}/scoresheet.pdf`);
  }

  pname(q: TatamiQueue, rid: number | null): string {
    if (!rid) return 'Por definir';
    const p = q.participants[rid];
    return p ? p.name : `#${rid}`;
  }

  pdojo(q: TatamiQueue, rid: number | null): string {
    return rid ? (q.participants[rid]?.dojo_name ?? '') : '';
  }

  async addTatami(): Promise<void> {
    const n = (this.ctx.tournament()?.tatamis.length ?? 0) + 1;
    const name = await this.dialog.prompt({ title: 'Agregar tatami', label: 'Nombre', minLength: 1, initial: `Tatami ${n}` });
    if (!name) return;
    const res = await this.mut.post(`/tournaments/${this.ctx.id()}/tatamis`, { name }, { success: 'Tatami agregado' });
    if (res) this.load();
  }
}
