import { Component, effect, inject, input } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { StatusBadge } from '../../shared/badge';
import { Icon } from '../../shared/icon';
import { InkTabs } from '../../shared/ink-tabs';
import { PageHead } from '../../shared/page-head';
import { DatePipe } from '../../shared/pipes';
import { TournamentContext } from './tournament-context';

@Component({
  selector: 'app-tournament-detail',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, StatusBadge, DatePipe, PageHead, Icon, InkTabs],
  providers: [TournamentContext],
  template: `
    <div class="container">
      @if (ctx.tournament(); as t) {
        <app-page-head kanji="大会" [title]="t.name">
          <a back class="back-link" routerLink="/torneos"><app-icon name="back" /> Torneos</a>
          <div meta class="meta-line">
            <app-status [status]="t.status" type="tournament" />
            @if (t.is_test) {
              <span class="badge yamabuki hollow">Torneo de prueba</span>
            }
            @if (t.organization_name) {
              <span class="org" title="Organización">{{ t.organization_name }}</span>
            }
            <span class="num">{{ t.start_date | fdate }}@if (t.end_date && t.end_date !== t.start_date) { – {{ t.end_date | fdate }}}</span>
            @if (t.venue || t.city) {
              <span>{{ t.venue }}@if (t.venue && t.city) {, }{{ t.city }}</span>
            }
          </div>
        </app-page-head>
        <nav class="tabs" inkTabs aria-label="Secciones del torneo">
          <a routerLink="resumen" routerLinkActive="active">Resumen</a>
          <a routerLink="categorias" routerLinkActive="active">Categorías</a>
          <a routerLink="inscripciones" routerLinkActive="active">Inscripciones</a>
          <a routerLink="solicitudes" routerLinkActive="active">
            Solicitudes
            @if (ctx.pendingCount()) {
              <span class="badge shu count" [attr.aria-label]="ctx.pendingCount() + ' pendientes'">{{ ctx.pendingCount() }}</span>
            }
          </a>
          <a routerLink="importar" routerLinkActive="active">Importar Excel</a>
          <a routerLink="tatamis" routerLinkActive="active">Tatamis</a>
          <a routerLink="arbitros" routerLinkActive="active">Árbitros</a>
          <a routerLink="resultados" routerLinkActive="active">Resultados</a>
          <a routerLink="lideres" routerLinkActive="active">Líderes</a>
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
  styles: `
    .count {
      margin-left: 0.35rem;
      font-size: var(--fs-12);
    }
    .org {
      color: var(--sumi-2);
      font-weight: 500;
    }
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
        this.ctx.loadPendingCount();
      }
    });
  }
}
