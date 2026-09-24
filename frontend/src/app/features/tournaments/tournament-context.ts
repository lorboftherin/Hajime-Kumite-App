import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { Category, Tournament } from '../../core/models';

/** Estado compartido entre las pestañas del detalle de torneo. */
@Injectable()
export class TournamentContext {
  private api = inject(ApiService);
  readonly id = signal<number>(0);
  readonly tournament = signal<Tournament | null>(null);
  readonly categories = signal<Category[]>([]);
  readonly error = signal<string>('');

  readonly categoryById = computed(() => new Map(this.categories().map((c) => [c.id, c])));

  async load(id: number): Promise<void> {
    this.id.set(id);
    try {
      this.tournament.set(await firstValueFrom(this.api.get<Tournament>(`/tournaments/${id}`)));
      this.error.set('');
    } catch (e: any) {
      this.error.set(e?.message ?? 'No se pudo cargar el torneo');
    }
  }

  async reload(): Promise<void> {
    await this.load(this.id());
  }

  async loadCategories(): Promise<Category[]> {
    try {
      const cats = await firstValueFrom(this.api.get<Category[]>(`/tournaments/${this.id()}/categories`));
      this.categories.set(cats);
      return cats;
    } catch {
      return this.categories();
    }
  }
}
