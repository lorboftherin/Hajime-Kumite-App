import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiError } from '../../core/api-error';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { DialogService } from '../../core/dialog.service';
import { RankingDetail, RankingSeason, Tournament } from '../../core/models';
import { MutationService } from '../../core/mutation.service';
import { isStaff } from '../../core/roles';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../shared/icon';
import { Modal } from '../../shared/modal';
import { MoreMenu } from '../../shared/more-menu';
import { PageHead } from '../../shared/page-head';
import { LimaPipe } from '../../shared/pipes';
import {
  SeasonForm,
  emptySeasonForm,
  seasonPayload,
  seasonToForm,
  toggleId,
} from './ranking-logic';
import { RankingView } from './ranking-view';

/** Ranking por temporada y liga: selector de temporada, tablas y configuración (staff). */
@Component({
  selector: 'app-ranking-page',
  imports: [FormsModule, Icon, Modal, MoreMenu, PageHead, LimaPipe, RankingView],
  template: `
    <div class="container">
      <app-page-head kanji="番付" title="Ranking">
        <div meta class="meta-line">
          @if (detail(); as d) {
            <span>{{ d.season.year }}</span>
            <span>{{ d.season.tournaments?.length ?? 0 }} torneos</span>
            @if (d.season.computed_at) {
              <span class="muted">Calculado {{ d.season.computed_at | lima }}</span>
            }
            @if (d.season.is_public) {
              <span class="badge matcha">Público</span>
            }
          } @else {
            <span>Puntos por temporada y liga</span>
          }
        </div>
        @if (staff()) {
          <button class="btn primary" (click)="openForm(null)">
            <app-icon name="plus" /> Nueva temporada
          </button>
        }
      </app-page-head>

      <div class="toolbar">
        <select aria-label="Temporada" [ngModel]="seasonId()" (ngModelChange)="pick($event)">
          @for (s of seasons(); track s.id) {
            <option [ngValue]="s.id">{{ s.name }} ({{ s.year }})</option>
          } @empty {
            <option [ngValue]="0">Sin temporadas</option>
          }
        </select>
        <span class="grow"></span>
        @if (current(); as s) {
          @if (s.is_public) {
            <button class="btn" (click)="copyLink(s)" title="Enlace público, sin inicio de sesión">
              Copiar enlace público
            </button>
          }
          @if (staff()) {
            <app-more text="Más" label="Más acciones de la temporada" [small]="false">
              <button class="menu-item" (click)="openForm(s)">Editar temporada…</button>
              <button class="menu-item" (click)="recompute(s)">Recalcular ahora</button>
              <hr />
              <button class="menu-item danger" (click)="remove(s)">Borrar temporada…</button>
            </app-more>
          }
        }
      </div>

      @if (seasons().length === 0 && loaded()) {
        <div class="card empty">
          <p><strong>No hay temporadas.</strong></p>
          @if (staff()) {
            Crea una temporada: por ejemplo «Liga Lima 2026» con todos los torneos del año.
          } @else {
            Cuando el organizador cree una temporada, el ranking aparecerá aquí.
          }
        </div>
      } @else {
        <app-ranking-view
          [detail]="detail()"
          [section]="section()"
          [modality]="modality()"
          [group]="group()"
          [links]="staff()"
          (sectionChange)="section.set($event)"
          (modalityChange)="modality.set($event); group.set(''); loadDetail()"
          (groupChange)="group.set($event); loadDetail()"
        />
      }
    </div>

    @if (formOpen()) {
      <app-modal
        [title]="editing() ? 'Editar temporada' : 'Nueva temporada'"
        [wide]="true"
        (closed)="formOpen.set(false)"
      >
        <form class="stack" (ngSubmit)="save()">
          <div class="grid-2">
            <label class="field"
              ><span>Nombre</span
              ><input name="n" [(ngModel)]="form.name" required placeholder="Liga Lima"
            /></label>
            <label class="field"
              ><span>Año</span><input name="y" type="number" [(ngModel)]="form.year"
            /></label>
            <label class="field"
              ><span>Desde (opcional)</span
              ><input name="df" type="date" [(ngModel)]="form.date_from"
            /></label>
            <label class="field"
              ><span>Hasta (opcional)</span><input name="dt" type="date" [(ngModel)]="form.date_to"
            /></label>
          </div>
          <fieldset>
            <legend>Torneos</legend>
            <p class="hint">
              Sin marcar ninguno cuentan todos los torneos que no son de prueba del rango de fechas
              (o del año). El multiplicador hace que un torneo valga más (p. ej. nacional ×2).
            </p>
            <ul class="tlist">
              @for (t of tournaments(); track t.id) {
                <li>
                  <label class="field inline"
                    ><input
                      type="checkbox"
                      [name]="'t' + t.id"
                      [ngModel]="form.tournament_ids.includes(t.id)"
                      (ngModelChange)="form.tournament_ids = toggle(form.tournament_ids, t.id)"
                    />
                    {{ t.name }}
                    <span class="muted small"
                      >{{ t.start_date }}
                      @if (t.is_test) {
                        · prueba
                      }
                    </span></label
                  >
                  <label class="field inline small"
                    >×<input
                      class="mult"
                      [name]="'m' + t.id"
                      inputmode="decimal"
                      [(ngModel)]="form.multipliers[t.id]"
                      placeholder="1"
                      [attr.aria-label]="'Multiplicador de ' + t.name"
                  /></label>
                </li>
              }
            </ul>
          </fieldset>
          <fieldset>
            <legend>Puntos por lugar</legend>
            <div class="grid-4">
              <label class="field"
                ><span>Oro</span
                ><input name="pg" type="number" min="0" [(ngModel)]="form.points.gold"
              /></label>
              <label class="field"
                ><span>Plata</span
                ><input name="ps" type="number" min="0" [(ngModel)]="form.points.silver"
              /></label>
              <label class="field"
                ><span>Bronce</span
                ><input name="pb" type="number" min="0" [(ngModel)]="form.points.bronze"
              /></label>
              <label class="field"
                ><span>Participación</span
                ><input name="pp" type="number" min="0" [(ngModel)]="form.points.participation"
              /></label>
            </div>
            <label class="field"
              ><span>Mínimo de competidores para puntuar un podio sin combate</span
              ><input name="me" type="number" min="0" [(ngModel)]="form.min_entrants_walkover_gold"
            /></label>
            <p class="hint">
              Un oro sin pelear (inscrito único o rival que no se presentó) en una categoría más
              chica que esto cuenta solo como participación.
            </p>
          </fieldset>
          <label class="field inline"
            ><input type="checkbox" name="pub" [(ngModel)]="form.is_public" /> Publicar en
            /ranking/{{ current()?.slug ?? '…' }} (sin inicio de sesión; menores con nombre
            abreviado)</label
          >
          <div class="form-actions">
            <button class="btn primary" [disabled]="form.name.trim().length < 3">Guardar</button>
          </div>
        </form>
      </app-modal>
    }
  `,
  styles: `
    .toolbar select {
      min-height: 2.5rem;
      min-width: 16rem;
    }
    fieldset {
      border: 1px solid var(--kasumi);
      border-radius: var(--radius-sm);
      padding: 0.75rem 1rem;
      legend {
        padding: 0 0.4rem;
        font-weight: 600;
      }
    }
    .grid-4 {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr));
      gap: 0.75rem;
      margin-bottom: 0.75rem;
    }
    .tlist {
      list-style: none;
      margin: 0;
      padding: 0;
      max-height: 16rem;
      overflow: auto;
      li {
        display: flex;
        justify-content: space-between;
        gap: 1rem;
        padding: 0.3rem 0;
        border-top: 1px solid var(--kasumi);
      }
      .mult {
        width: 3.5rem;
      }
    }
  `,
})
export class RankingPage {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private mut = inject(MutationService);
  private dialog = inject(DialogService);
  private toast = inject(ToastService);
  /** Query params (?temporada=…&grupo=…) desde el perfil de una persona. */
  readonly temporada = input<string | undefined>();
  readonly grupo = input<string | undefined>();

  readonly staff = computed(() => isStaff(this.auth.user()));
  readonly seasons = signal<RankingSeason[]>([]);
  readonly loaded = signal(false);
  readonly seasonId = signal(0);
  readonly detail = signal<RankingDetail | null>(null);
  readonly section = signal<'persons' | 'dojos'>('persons');
  readonly modality = signal('');
  readonly group = signal('');
  readonly current = computed(() => this.seasons().find((s) => s.id === this.seasonId()) ?? null);
  readonly tournaments = signal<Tournament[]>([]);
  readonly formOpen = signal(false);
  readonly editing = signal<RankingSeason | null>(null);
  form: SeasonForm = emptySeasonForm(new Date().getFullYear());

  constructor() {
    effect(() => {
      const wanted = Number(this.temporada() ?? 0);
      const g = this.grupo() ?? '';
      untracked(() => this.loadSeasons(wanted, g));
    });
  }

  async loadSeasons(wanted = 0, group = ''): Promise<void> {
    try {
      const list = await firstValueFrom(this.api.get<RankingSeason[]>('/ranking/seasons'));
      this.seasons.set(list);
      const id = list.find((s) => s.id === (wanted || this.seasonId()))?.id ?? list[0]?.id ?? 0;
      this.seasonId.set(id);
      this.group.set(group);
      if (id) await this.loadDetail();
      else this.detail.set(null);
    } catch {
      /* el interceptor ya avisó */
    } finally {
      this.loaded.set(true);
    }
  }

  async loadDetail(): Promise<void> {
    const id = this.seasonId();
    if (!id) return;
    try {
      this.detail.set(
        await firstValueFrom(
          this.api.get<RankingDetail>(`/ranking/seasons/${id}`, {
            modality: this.modality(),
            group: this.group(),
          }),
        ),
      );
    } catch (e) {
      this.toast.error(ApiError.from(e).fullMessage);
    }
  }

  pick(id: number): void {
    this.seasonId.set(id);
    this.group.set('');
    this.loadDetail();
  }

  toggle(ids: number[], id: number): number[] {
    return toggleId(ids, id);
  }

  async openForm(s: RankingSeason | null): Promise<void> {
    this.editing.set(s);
    this.form = s ? seasonToForm(s) : emptySeasonForm(new Date().getFullYear());
    this.formOpen.set(true);
    if (!this.tournaments().length) {
      try {
        this.tournaments.set(await firstValueFrom(this.api.get<Tournament[]>('/tournaments')));
      } catch {
        /* sin lista: se puede guardar igual con «todos los del año» */
      }
    }
  }

  async save(): Promise<void> {
    const s = this.editing();
    const body = seasonPayload(this.form);
    const res = s
      ? await this.mut.patch<RankingSeason>(
          `/ranking/seasons/${s.id}`,
          { ...body, version: s.version },
          { success: 'Temporada guardada', onConflict: () => this.loadSeasons() },
        )
      : await this.mut.post<RankingSeason>('/ranking/seasons', body, {
          success: 'Temporada creada',
        });
    if (res) {
      this.formOpen.set(false);
      await this.loadSeasons(res.id);
    }
  }

  async recompute(s: RankingSeason): Promise<void> {
    const res = await this.mut.post<{ entries: number }>(
      `/ranking/seasons/${s.id}/recompute`,
      {},
      { success: 'Ranking recalculado' },
    );
    if (res) await this.loadSeasons(s.id);
  }

  async remove(s: RankingSeason): Promise<void> {
    const ok = await this.dialog.confirm({
      title: 'Borrar temporada',
      message: `Se borra «${s.name}» y su ranking calculado. Los resultados de los torneos no se tocan.`,
      confirmText: 'Borrar',
      danger: true,
    });
    if (!ok) return;
    try {
      await firstValueFrom(this.api.delete(`/ranking/seasons/${s.id}`));
      this.toast.ok('Temporada borrada');
      await this.loadSeasons();
    } catch (e) {
      this.toast.error(ApiError.from(e).fullMessage);
    }
  }

  async copyLink(s: RankingSeason): Promise<void> {
    const url = `${location.origin}/ranking/${s.slug}`;
    try {
      await navigator.clipboard.writeText(url);
      this.toast.ok('Enlace copiado');
    } catch {
      await this.dialog.alert('Enlace público', url);
    }
  }
}
