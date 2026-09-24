import { Component, effect, inject, input } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { StatusBadge } from '../../shared/badge';
import { DatePipe } from '../../shared/pipes';
import { TournamentContext } from './tournament-context';

@Component({
  selector: 'app-tournament-detail',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, StatusBadge, DatePipe],
  providers: [TournamentContext],
  template: `
    <div class="container">
      @if (ctx.tournament(); as t) {
        <div class="page-header">
          <div>
            <div class="small"><a routerLink="/torneos">← Torneos</a></div>
            <h1>{{ t.name }}</h1>
            <div class="row small muted">
              <app-status [status]="t.status" type="tournament" />
              @if (t.is_test) {
                <span class="badge warn">Torneo de prueba</span>
              }
              <span>{{ t.start_date | fdate }}</span>
              @if (t.venue || t.city) {
                <span>· {{ t.venue }} {{ t.city }}</span>
              }
            </div>
          </div>
        </div>
        <nav class="tabs">
          <a routerLink="resumen" routerLinkActive="active">Resumen</a>
          <a routerLink="categorias" routerLinkActive="active">Categorías</a>
          <a routerLink="inscripciones" routerLinkActive="active">Inscripciones</a>
          <a routerLink="importar" routerLinkActive="active">Importar Excel</a>
          <a routerLink="tatamis" routerLinkActive="active">Tatamis</a>
          <a routerLink="resultados" routerLinkActive="active">Resultados</a>
          <a routerLink="shadow" routerLinkActive="active">Shadow Mode</a>
          <a routerLink="auditoria" routerLinkActive="active">Auditoría</a>
        </nav>
        <router-outlet />
      } @else if (ctx.error()) {
        <div class="alert danger">{{ ctx.error() }}</div>
      } @else {
        <div class="empty"><span class="spinner"></span></div>
      }
    </div>
  `,
})
export class TournamentDetailPage {
  readonly ctx = inject(TournamentContext);
  readonly id = input.required<string>();

  constructor() {
    effect(() => {
      const id = Number(this.id());
      if (id && id !== this.ctx.id()) {
        this.ctx.load(id);
        this.ctx.loadCategories();
      }
    });
  }
}
