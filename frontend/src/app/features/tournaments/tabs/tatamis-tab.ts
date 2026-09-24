import { Component, DestroyRef, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../../core/api.service';
import { DialogService } from '../../../core/dialog.service';
import { FilesService } from '../../../core/files.service';
import { QueueItem, Tatami, TatamiQueue } from '../../../core/models';
import { MutationService } from '../../../core/mutation.service';
import { StatusBadge } from '../../../shared/badge';
import { TournamentContext } from '../tournament-context';

interface TatamiView {
  tatami: Tatami;
  data: TatamiQueue | null;
  error?: string;
}

@Component({
  selector: 'app-tatamis-tab',
  imports: [RouterLink, StatusBadge],
  template: `
    <div class="row mb">
      <button class="btn sm" (click)="load()">↻ Actualizar</button>
      <button class="btn sm" (click)="addTatami()">+ Agregar tatami</button>
      <span class="muted small">Se actualiza cada 15 s. Asigna categorías a un tatami desde la pestaña Categorías.</span>
    </div>
    <div class="tatamis">
      @for (v of views(); track v.tatami.id) {
        <section class="card tatami">
          <div class="row tatami-head">
            <h3 class="grow">{{ v.tatami.name || 'Tatami ' + v.tatami.number }}</h3>
            <button class="btn sm" (click)="scoresheet(v.tatami.id)" title="Registro oficial en papel para Shadow Mode">🖨 Planilla PDF</button>
          </div>
          @if (v.data; as q) {
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
                  <div class="small muted"><strong class="num">{{ cur.number }}</strong> {{ cur.category_name }} · {{ cur.match.code }}</div>
                  <div><span class="dot aka"></span> {{ pname(q, cur.match.aka_registration_id) }} <small class="muted">{{ pdojo(q, cur.match.aka_registration_id) }}</small></div>
                  <div><span class="dot ao"></span> {{ pname(q, cur.match.ao_registration_id) }} <small class="muted">{{ pdojo(q, cur.match.ao_registration_id) }}</small></div>
                </div>
                <a class="btn primary" [routerLink]="['/mesa', cur.match.id]" [queryParams]="{ tatami: v.tatami.id }">Abrir mesa</a>
              </div>
            } @else {
              <div class="muted small">Ninguno en curso.</div>
            }
            <div class="label">Siguiente y en espera</div>
            @for (it of waiting(q); track it.match.id; let i = $index) {
              <div class="match" [class.next]="i === 0">
                <div class="grow">
                  <div class="small muted">
                    @if (i === 0) {
                      <span class="badge info">Siguiente</span>
                    }
                    <strong class="num">{{ it.number }}</strong> {{ it.category_name }} · {{ it.match.code }} <app-status [status]="it.match.status" type="match" />
                  </div>
                  <div><span class="dot aka"></span> {{ pname(q, it.match.aka_registration_id) }} <small class="muted">{{ pdojo(q, it.match.aka_registration_id) }}</small></div>
                  <div><span class="dot ao"></span> {{ pname(q, it.match.ao_registration_id) }} <small class="muted">{{ pdojo(q, it.match.ao_registration_id) }}</small></div>
                </div>
                <a class="btn sm" [routerLink]="['/mesa', it.match.id]" [queryParams]="{ tatami: v.tatami.id }">Mesa</a>
              </div>
            } @empty {
              <div class="muted small">Cola vacía.</div>
            }
          } @else if (v.error) {
            <div class="alert danger small">{{ v.error }}</div>
          } @else {
            <span class="spinner"></span>
          }
        </section>
      } @empty {
        <div class="card empty">El torneo no tiene tatamis.</div>
      }
    </div>
  `,
  styles: `
    .tatami-head { align-items: center; gap: 8px; }
    .tatami-head h3 { margin: 0; }
    .num { font-variant-numeric: tabular-nums; color: var(--text, inherit); margin-right: 4px; }
    .tatamis {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
      gap: 1rem;
    }
    .label {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--muted);
      margin: 0.75rem 0 0.35rem;
      font-weight: 700;
    }
    .match {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      margin-bottom: 0.4rem;
    }
    .match.current {
      border: 2px solid var(--ok);
      background: var(--ok-soft);
    }
    .match.next {
      border-color: var(--ao);
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
