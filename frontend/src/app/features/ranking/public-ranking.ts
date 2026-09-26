import { Component, effect, inject, input, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiError } from '../../core/api-error';
import { ApiService } from '../../core/api.service';
import { RankingDetail } from '../../core/models';
import { Enso, HajimeWord } from '../../shared/enso';
import { RankingView } from './ranking-view';

/** Ranking público (/ranking/:temporada): sin inicio de sesión, menores con nombre abreviado. */
@Component({
  selector: 'app-public-ranking',
  imports: [Enso, HajimeWord, RankingView],
  template: `
    <div class="page container">
      <header class="top">
        <div class="brand">
          <app-enso class="mark" /><app-hajime-word class="word" /><span class="tag">ranking</span>
        </div>
      </header>
      @if (data(); as d) {
        <h1>{{ d.season.name }}</h1>
        <p class="muted">
          Temporada {{ d.season.year }}
          @if (d.season.tournaments?.length) {
            · {{ d.season.tournaments!.length }} torneos
          }
        </p>
        <app-ranking-view
          [detail]="d"
          [section]="section()"
          [modality]="modality()"
          [group]="group()"
          (sectionChange)="section.set($event)"
          (modalityChange)="modality.set($event); group.set(''); load()"
          (groupChange)="group.set($event); load()"
        />
      } @else if (error()) {
        <div class="alert warn">{{ error() }}</div>
      } @else {
        <div class="empty"><span class="spinner"></span></div>
      }
    </div>
  `,
  styles: `
    .top {
      display: flex;
      align-items: center;
      margin-bottom: 1.5rem;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      .mark {
        width: 2rem;
        height: 2rem;
      }
      .word {
        height: 1.4rem;
      }
      .tag {
        font-size: var(--fs-12);
        letter-spacing: 0.15em;
        text-transform: uppercase;
        color: var(--nezumi-ink);
      }
    }
    h1 {
      margin: 0 0 0.25rem;
    }
  `,
})
export class PublicRankingPage {
  private api = inject(ApiService);
  readonly temporada = input.required<string>();
  readonly data = signal<RankingDetail | null>(null);
  readonly error = signal('');
  readonly section = signal<'persons' | 'dojos'>('persons');
  readonly modality = signal('');
  readonly group = signal('');

  constructor() {
    effect(() => {
      if (this.temporada()) this.load();
    });
  }

  async load(): Promise<void> {
    try {
      this.data.set(
        await firstValueFrom(
          this.api.get<RankingDetail>(`/public/ranking/${encodeURIComponent(this.temporada())}`, {
            modality: this.modality(),
            group: this.group(),
          }),
        ),
      );
      this.error.set('');
    } catch (e) {
      const err = ApiError.from(e);
      this.error.set(
        err.status === 404 ? 'Este ranking no existe o no es público.' : err.fullMessage,
      );
    }
  }
}
