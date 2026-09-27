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
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    StatusBadge,
    DatePipe,
    PageHead,
    Icon,
    InkTabs,
  ],
  providers: [TournamentContext],
  template: `
    <div class="container">
      @if (ctx.tournament(); as t) {
        <app-page-head kanji="大会" [title]="t.name">
          <a i18n="@@torneo.detalle.torneos" back class="back-link" routerLink="/torneos"
            ><app-icon name="back" /> Torneos</a
          >
          <div meta class="meta-line">
            <app-status [status]="t.status" type="tournament" />
            @if (t.is_test) {
              <span i18n="@@torneo.detalle.torneo-prueba" class="badge yamabuki hollow"
                >Torneo de prueba</span
              >
            }
            @if (t.organization_name) {
              <span i18n-title="@@torneo.detalle.organizacion" class="org" title="Organización">{{
                t.organization_name
              }}</span>
            }
            <span class="num"
              >{{ t.start_date | fdate }}
              @if (t.end_date && t.end_date !== t.start_date) {
                – {{ t.end_date | fdate }}
              }
            </span>
            @if (t.venue || t.city) {
              <span
                >{{ t.venue }}
                @if (t.venue && t.city) {
                  ,
                }
                {{ t.city }}</span
              >
            }
          </div>
        </app-page-head>
        <nav
          i18n-aria-label="@@torneo.detalle.secciones-torneo"
          class="tabs"
          inkTabs
          aria-label="Secciones del torneo"
        >
          <a i18n="@@torneo.detalle.resumen" routerLink="resumen" routerLinkActive="active"
            >Resumen</a
          >
          <a i18n="@@torneo.detalle.categorias" routerLink="categorias" routerLinkActive="active"
            >Categorías</a
          >
          <a
            i18n="@@torneo.detalle.inscripciones"
            routerLink="inscripciones"
            routerLinkActive="active"
            >Inscripciones</a
          >
          <a routerLink="solicitudes" routerLinkActive="active"
            ><ng-container i18n="@@torneo.detalle.solicitudes"> Solicitudes </ng-container>
            @if (ctx.pendingCount()) {
              <span
                class="badge shu count"
                [attr.aria-label]="ariaPendientes(ctx.pendingCount())"
                >{{ ctx.pendingCount() }}</span
              >
            }
          </a>
          <a i18n="@@torneo.detalle.importar-excel" routerLink="importar" routerLinkActive="active"
            >Importar Excel</a
          >
          <a
            i18n="@@torneo.detalle.acreditacion"
            routerLink="acreditacion"
            routerLinkActive="active"
            >Acreditación</a
          >
          <a i18n="@@torneo.detalle.tatamis" routerLink="tatamis" routerLinkActive="active"
            >Tatamis</a
          >
          <a i18n="@@torneo.detalle.arbitros" routerLink="arbitros" routerLinkActive="active"
            >Árbitros</a
          >
          <a i18n="@@torneo.detalle.resultados" routerLink="resultados" routerLinkActive="active"
            >Resultados</a
          >
          <a i18n="@@torneo.detalle.lideres" routerLink="lideres" routerLinkActive="active"
            >Líderes</a
          >
          <a i18n="@@torneo.detalle.shadow-mode" routerLink="shadow" routerLinkActive="active"
            >Shadow Mode</a
          >
          <a i18n="@@torneo.detalle.auditoria" routerLink="auditoria" routerLinkActive="active"
            >Auditoría</a
          >
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
  ariaPendientes = (n: number) => $localize`:@@torneo.detalle.n-pendientes:${n}:n: pendientes`;
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
