import { Component, ElementRef, computed, effect, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';
import { ApiService } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { alertText } from '../core/billing';
import { BillingAlert } from '../core/models';
import {
  canReviewClaims,
  dojoAdminOf,
  hasOrganizations,
  isCompetitorOnly,
  isStaff,
  tatamiScopes,
} from '../core/roles';
import { ThemeMode, ThemeService } from '../core/theme.service';
import { Enso, HajimeWord } from '../shared/enso';
import { Icon, IconName } from '../shared/icon';
import { etiquetas, lista } from '../core/i18n/etiquetas';

interface NavItem {
  path: string;
  kanji: string;
  label: string;
  /** Solo para Admin y organizadores (personas, dojos, plantillas). */
  staff?: boolean;
}

const NAV: NavItem[] = lista(() => [
  { path: '/torneos', kanji: '大会', label: $localize`:@@menu.torneos:Torneos` },
  { path: '/personas', kanji: '人', label: $localize`:@@menu.personas:Personas`, staff: true },
  { path: '/dojos', kanji: '道場', label: $localize`:@@menu.dojos:Dojos`, staff: true },
  {
    path: '/plantillas',
    kanji: '型',
    label: $localize`:@@menu.plantillas:Plantillas`,
    staff: true,
  },
  { path: '/ranking', kanji: '番付', label: $localize`:@@menu.ranking:Ranking` },
]);
const ADMIN: NavItem = etiquetas(() => ({
  path: '/usuarios',
  kanji: '管理',
  label: $localize`:@@menu.usuarios:Usuarios`,
}));
/** Admin Global: pagos, reembolsos, comprobantes y cupones. */
const PAYMENTS: NavItem = etiquetas(() => ({
  path: '/pagos',
  kanji: '会計',
  label: $localize`:@@menu.pagos:Pagos`,
}));
/** Cuenta de competidor o de padre, madre o apoderado: sus perfiles deportivos. */
const MY_PROFILES: NavItem = etiquetas(() => ({
  path: '/mis-perfiles',
  kanji: '選手',
  label: $localize`:@@menu.mis-perfiles-2:Mis perfiles`,
}));
/** Dojo, organizadores y Admin: solicitudes para reclamar perfiles. */
const CLAIMS: NavItem = etiquetas(() => ({
  path: '/solicitudes',
  kanji: '申請',
  label: $localize`:@@menu.reclamos:Reclamos`,
}));
/** Operador de mesa de un tatami: acceso directo a su cola. */
const MY_TATAMI: NavItem = etiquetas(() => ({
  path: '/mi-tatami',
  kanji: '畳',
  label: $localize`:@@menu.mi-tatami:Mi tatami`,
}));
/** Sensei (admin de dojo): sus competidores y la inscripción en línea. */
const MY_DOJO: NavItem = etiquetas(() => ({
  path: '/mis-competidores',
  kanji: '門',
  label: $localize`:@@menu.mis-competidores:Mis competidores`,
}));
/** Organización: datos, miembros y plan. */
const ORGANIZATION: NavItem = etiquetas(() => ({
  path: '/organizacion',
  kanji: '組',
  label: $localize`:@@menu.organizacion:Organización`,
}));

const THEMES: Array<{ mode: ThemeMode; label: string; icon: IconName }> = lista(() => [
  { mode: 'light', label: $localize`:@@menu.claro:Claro`, icon: 'sun' },
  { mode: 'dark', label: $localize`:@@menu.oscuro:Oscuro`, icon: 'moon' },
  { mode: 'system', label: $localize`:@@menu.sistema:Sistema`, icon: 'system' },
]);

/**
 * Marco de la aplicación: barra lateral con kanji + etiqueta (≥1200 px), plegada a kanji con
 * etiqueta mínima (768–1199 px) y barra inferior en celular (<768 px). El menú de usuario vive
 * al pie de la barra lateral (en celular, arriba a la derecha).
 */
@Component({
  selector: 'app-shell',
  imports: [NgTemplateOutlet, RouterOutlet, RouterLink, RouterLinkActive, Enso, HajimeWord, Icon],
  host: {
    class: 'app-shell',
    '(document:click)': 'onDocClick($event)',
    '(document:keydown.escape)': 'menuOpen.set(null)',
  },
  template: `
    <aside
      i18n-aria-label="@@menu.navegacion-principal"
      class="sidebar no-print"
      aria-label="Navegación principal"
    >
      <div class="sidebar-inner">
        <a
          i18n-aria-label="@@menu.hajime-inicio"
          class="brand"
          routerLink="/"
          aria-label="Hajime, inicio"
        >
          <app-enso class="mark" />
          <app-hajime-word class="word" />
        </a>
        <nav class="nav">
          @for (it of items(); track it.path) {
            <a
              [routerLink]="it.path"
              routerLinkActive=""
              #rla="routerLinkActive"
              [class.active]="rla.isActive || inBracket(it)"
              [attr.aria-current]="rla.isActive ? 'page' : null"
              [attr.title]="it.label"
            >
              <span class="kanji" aria-hidden="true">{{ it.kanji }}</span>
              <span class="label">{{ it.label }}</span>
            </a>
          }
        </nav>
        <div class="user-slot" data-slot="side">
          <ng-container [ngTemplateOutlet]="userBtn" [ngTemplateOutletContext]="{ slot: 'side' }" />
        </div>
      </div>
    </aside>

    <header class="topbar no-print">
      <a
        i18n-aria-label="@@menu.hajime-inicio"
        class="brand"
        routerLink="/"
        aria-label="Hajime, inicio"
      >
        <app-enso class="mark" />
        <app-hajime-word class="word" />
      </a>
      <div class="user-slot" data-slot="top">
        <ng-container [ngTemplateOutlet]="userBtn" [ngTemplateOutletContext]="{ slot: 'top' }" />
      </div>
    </header>

    <main class="main">
      @for (a of alerts(); track a.subscription_id) {
        <div class="plan-alert no-print" [class.grace]="a.in_grace" role="status">
          <span>{{ alertMessage(a) }}</span>
          @if (a.organization_id) {
            <a i18n="@@menu.renovar" [routerLink]="['/organizacion', a.organization_id]">Renovar</a>
          } @else {
            <a i18n="@@menu.renovar" routerLink="/planes">Renovar</a>
          }
        </div>
      }
      <router-outlet />
    </main>

    <nav
      i18n-aria-label="@@menu.navegacion-principal"
      class="bottom-bar no-print"
      aria-label="Navegación principal"
    >
      @for (it of items(); track it.path) {
        <a
          [routerLink]="it.path"
          routerLinkActive=""
          #rlb="routerLinkActive"
          [class.active]="rlb.isActive || inBracket(it)"
          [attr.aria-current]="rlb.isActive ? 'page' : null"
        >
          <span class="kanji" aria-hidden="true">{{ it.kanji }}</span>
          <span class="label">{{ it.label }}</span>
        </a>
      }
    </nav>

    <ng-template #userBtn let-slot="slot">
      <button
        type="button"
        class="user-btn"
        (click)="toggleMenu(slot)"
        [attr.aria-expanded]="menuOpen() === slot"
        aria-haspopup="menu"
        [attr.aria-label]="ariaMenuDe(name())"
      >
        <span class="avatar" aria-hidden="true">{{ initial() }}</span>
        <span class="who">
          <span class="uname">{{ name() }}</span>
          <span class="role">{{ roleLabel() }}</span>
        </span>
      </button>
      @if (menuOpen() === slot) {
        <div
          i18n-aria-label="@@menu.menu-usuario"
          class="menu-panel user-menu"
          [class.up]="slot === 'side'"
          role="menu"
          aria-label="Menú de usuario"
        >
          <div i18n="@@menu.sesion" class="menu-label">Sesión: {{ auth.user()?.username }}</div>
          <div i18n-aria-label="@@menu.tema" class="theme" role="group" aria-label="Tema">
            @for (t of themes; track t.mode) {
              <button
                type="button"
                [class.on]="theme.mode() === t.mode"
                [attr.aria-pressed]="theme.mode() === t.mode"
                (click)="theme.set(t.mode)"
              >
                <app-icon [name]="t.icon" />
                <span>{{ t.label }}</span>
              </button>
            }
          </div>
          <hr />
          <a
            i18n="@@menu.mi-cuenta"
            class="menu-item"
            routerLink="/perfil"
            role="menuitem"
            (click)="menuOpen.set(null)"
            ><app-icon name="open" /> Mi cuenta</a
          >
          @if (!competitorOnly()) {
            <a
              i18n="@@menu.mis-perfiles"
              class="menu-item"
              routerLink="/mis-perfiles"
              role="menuitem"
              (click)="menuOpen.set(null)"
              ><app-icon name="history" /> Mis perfiles</a
            >
          }
          <a
            i18n="@@menu.planes"
            class="menu-item"
            routerLink="/planes"
            role="menuitem"
            (click)="menuOpen.set(null)"
            ><app-icon name="open" /> Planes</a
          >
          <a
            i18n="@@menu.cambiar-contrasena"
            class="menu-item"
            routerLink="/cambiar-clave"
            role="menuitem"
            (click)="menuOpen.set(null)"
            ><app-icon name="key" /> Cambiar contraseña</a
          >
          <a
            i18n="@@menu.borrar-mi-cuenta"
            class="menu-item"
            routerLink="/mi-cuenta"
            role="menuitem"
            (click)="menuOpen.set(null)"
            ><app-icon name="close" /> Borrar mi cuenta</a
          >
          <button
            i18n="@@menu.salir"
            type="button"
            class="menu-item"
            role="menuitem"
            (click)="logout()"
            ><app-icon name="logout" /> Salir</button
          >
        </div>
      }
    </ng-template>
  `,
  styles: `
    :host {
      display: grid;
      grid-template-columns: var(--sidebar-w) minmax(0, 1fr);
      min-height: 100vh;
    }

    /* ---- Aviso «tu plan vence en N días» (dueños y administradores) ---- */
    .plan-alert {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem 1rem;
      align-items: center;
      justify-content: center;
      padding: 0.5rem 1rem;
      font-size: var(--fs-14);
      background: color-mix(in srgb, var(--warn) 18%, var(--washi));
      border-bottom: 1px solid var(--kasumi);
      &.grace {
        background: color-mix(in srgb, var(--danger) 14%, var(--washi));
      }
      a {
        font-weight: 600;
      }
    }

    /* ---- Barra lateral (columna completa; el contenido queda fijo al desplazar) ---- */
    .sidebar {
      z-index: 100;
      border-right: 1px solid var(--kasumi);
      background: color-mix(in srgb, var(--washi) 92%, var(--kasumi));
    }
    .sidebar-inner {
      position: sticky;
      top: 0;
      height: 100vh;
      height: 100dvh;
      display: flex;
      flex-direction: column;
      padding: 1.75rem 0.9rem 1rem;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 0.65rem;
      padding: 0 0.7rem;
      margin-bottom: 2.5rem;
      color: var(--sumi);
      text-decoration: none !important;
      .mark {
        width: 2.4rem;
        height: 2.4rem;
        transition: transform var(--dur-3) var(--ease);
      }
      .word {
        /* La palabra incluye el descendente de la «j»: se baja un poco para centrar las mayúsculas. */
        height: 1.7rem;
        margin-top: 0.45rem;
      }
      &:hover .mark {
        transform: rotate(-8deg);
      }
    }
    .nav {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
    }
    .nav a {
      position: relative;
      display: grid;
      grid-template-columns: 2.6rem 1fr;
      align-items: center;
      gap: 0.35rem;
      padding: 0.6rem 0.7rem;
      border-radius: var(--radius-sm);
      color: var(--sumi-2);
      font-size: var(--fs-16);
      font-weight: 500;
      text-decoration: none;
      border: 1px solid transparent;
      transition:
        background-color var(--dur-1) var(--ease),
        color var(--dur-1) var(--ease);
      &:hover {
        background: var(--hover);
        color: var(--sumi);
      }
      &.active {
        background: var(--kinu);
        border-color: var(--kasumi);
        color: var(--sumi);
        font-weight: 700;
        .kanji {
          color: var(--shu-ink);
        }
      }
    }
    .kanji {
      font-family: var(--font-display);
      font-weight: 500;
      font-size: 1.15rem;
      line-height: 1;
      /* nezumi-ink: el tono tenue con contraste de texto (axe, color-contrast). */
      color: var(--nezumi-ink);
      text-align: center;
      letter-spacing: 0.02em;
      transition: color var(--dur-1) var(--ease);
    }

    /* ---- Usuario ---- */
    .user-slot {
      position: relative;
    }
    .sidebar .user-slot {
      margin-top: auto;
      padding-top: 1rem;
      border-top: 1px solid var(--kasumi);
    }
    .user-btn {
      all: unset;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: 0.7rem;
      width: 100%;
      padding: 0.5rem 0.6rem;
      border-radius: var(--radius-sm);
      cursor: pointer;
      &:hover {
        background: var(--hover);
      }
      &:focus-visible {
        outline: 2px solid var(--ai);
        outline-offset: 2px;
      }
    }
    .avatar {
      display: inline-grid;
      place-items: center;
      flex: none;
      width: 2.1rem;
      height: 2.1rem;
      border-radius: 50%;
      border: 1px solid var(--kasumi-2);
      background: var(--kinu);
      font-family: var(--font-display);
      font-weight: 700;
      color: var(--sumi);
    }
    .who {
      display: flex;
      flex-direction: column;
      min-width: 0;
      line-height: 1.3;
    }
    .uname {
      font-size: var(--fs-14);
      font-weight: 700;
      color: var(--sumi);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .role {
      font-size: var(--fs-12);
      color: var(--nezumi-ink);
    }
    .user-menu {
      position: absolute;
      z-index: 200;
      right: 0;
      top: calc(100% + 6px);
      min-width: 15rem;
      &.up {
        top: auto;
        bottom: calc(100% + 6px);
        left: 0;
        right: auto;
      }
    }
    .theme {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 2px;
      margin: 0.35rem 0.4rem 0.4rem;
      padding: 3px;
      border-radius: var(--radius-sm);
      background: var(--washi);
      border: 1px solid var(--kasumi);
      button {
        all: unset;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.15rem;
        padding: 0.4rem 0.2rem;
        border-radius: 6px;
        font-size: var(--fs-12);
        color: var(--nezumi-ink);
        cursor: pointer;
        transition:
          background-color var(--dur-1) var(--ease),
          color var(--dur-1) var(--ease);
        &:hover {
          color: var(--sumi);
        }
        &.on {
          background: var(--kinu-2);
          color: var(--sumi);
          box-shadow: 0 0 0 1px var(--kasumi);
        }
        &:focus-visible {
          outline: 2px solid var(--ai);
        }
      }
    }

    /* ---- Contenido ---- */
    .main {
      min-width: 0;
      min-height: 100vh;
    }
    .topbar,
    .bottom-bar {
      display: none;
    }

    /* ---- Pantallas medianas: solo kanji (con etiqueta mínima) ---- */
    @media (max-width: 1199px) {
      :host {
        --sidebar-w: 92px;
      }
      .sidebar-inner {
        padding: 1.4rem 0.6rem 0.9rem;
      }
      .brand {
        justify-content: center;
        padding: 0;
        margin-bottom: 2rem;
        .word {
          display: none;
        }
      }
      .nav a {
        grid-template-columns: 1fr;
        justify-items: center;
        gap: 0.3rem;
        padding: 0.7rem 0.2rem 0.55rem;
        .kanji {
          font-size: 1.3rem;
        }
        .label {
          font-size: 0.6875rem;
          font-weight: 500;
          letter-spacing: 0.02em;
        }
      }
      .sidebar .who {
        display: none;
      }
      .sidebar .user-btn {
        justify-content: center;
        padding: 0.5rem 0;
      }
      .user-menu.up {
        left: calc(100% + 0.9rem);
        bottom: 0;
      }
    }

    /* ---- Celular: barra superior mínima + barra inferior ---- */
    @media (max-width: 767px) {
      :host {
        display: block;
      }
      .sidebar {
        display: none;
      }
      .main {
        padding-bottom: calc(var(--bottom-bar-h) + env(safe-area-inset-bottom));
      }
      .topbar {
        position: sticky;
        top: 0;
        z-index: 100;
        display: flex;
        align-items: center;
        justify-content: space-between;
        height: 3.5rem;
        padding: 0 0.75rem 0 1rem;
        background: color-mix(in srgb, var(--washi) 88%, transparent);
        backdrop-filter: blur(8px);
        border-bottom: 1px solid var(--kasumi);
        .brand {
          margin: 0;
          padding: 0;
          .mark {
            width: 1.6rem;
            height: 1.6rem;
          }
          .word {
            display: inline-block;
            height: 1.2rem;
            margin-top: 0.3rem;
          }
        }
        .who {
          display: none;
        }
        .user-btn {
          padding: 0.3rem;
        }
      }
      .bottom-bar {
        position: fixed;
        inset: auto 0 0 0;
        z-index: 100;
        display: grid;
        grid-auto-flow: column;
        grid-auto-columns: 1fr;
        height: calc(var(--bottom-bar-h) + env(safe-area-inset-bottom));
        padding-bottom: env(safe-area-inset-bottom);
        background: color-mix(in srgb, var(--kinu) 94%, transparent);
        backdrop-filter: blur(8px);
        border-top: 1px solid var(--kasumi);
        a {
          position: relative;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 0.2rem;
          color: var(--nezumi-ink);
          text-decoration: none;
          font-size: 0.6875rem;
          font-weight: 500;
          .kanji {
            font-size: 1.15rem;
          }
          &.active {
            color: var(--sumi);
            font-weight: 700;
            .kanji {
              color: var(--shu-ink);
            }
            &::before {
              content: '';
              position: absolute;
              top: 0;
              left: 30%;
              right: 30%;
              height: 2px;
              border-radius: 0 0 2px 2px;
              background: var(--sumi);
            }
          }
        }
      }
    }
  `,
})
export class Shell {
  ariaMenuDe = (nombre: string) => $localize`:@@menu.menu-de:Menú de ${nombre}:nombre:`;
  readonly auth = inject(AuthService);
  readonly theme = inject(ThemeService);
  private host = inject(ElementRef<HTMLElement>);
  readonly themes = THEMES;
  /** Dónde está abierto el menú de usuario: barra lateral, barra superior (celular) o cerrado. */
  readonly menuOpen = signal<'side' | 'top' | null>(null);
  readonly items = computed(() => {
    const u = this.auth.user();
    if (isCompetitorOnly(u)) return [MY_PROFILES];
    const staff = isStaff(u);
    const base = NAV.filter((it) => staff || !it.staff);
    const mine = [
      ...(tatamiScopes(u).length ? [MY_TATAMI] : []),
      ...(dojoAdminOf(u).length ? [MY_DOJO] : []),
    ];
    const org = hasOrganizations(u) ? [ORGANIZATION] : [];
    const claims = canReviewClaims(u) ? [CLAIMS] : [];
    return [...mine, ...base, ...org, ...claims, ...(this.auth.isAdmin() ? [ADMIN, PAYMENTS] : [])];
  });
  readonly competitorOnly = computed(() => isCompetitorOnly(this.auth.user()));
  /** Planes por vencer o en gracia de las organizaciones que administra (o de su cuenta). */
  readonly alerts = signal<BillingAlert[]>([]);
  private readonly api = inject(ApiService);
  private readonly loadAlerts = effect(() => {
    if (!this.auth.user()) return;
    this.api.get<BillingAlert[]>('/billing/alerts').subscribe({
      next: (a) => this.alerts.set(a),
      error: () => this.alerts.set([]),
    });
  });
  alertMessage(a: BillingAlert): string {
    return alertText(a);
  }
  readonly name = computed(() => {
    const u = this.auth.user();
    return u?.display_name || u?.username || '';
  });
  readonly initial = computed(() => (this.name() || '?').charAt(0).toUpperCase());
  readonly roleLabel = computed(() => {
    const u = this.auth.user();
    if (u?.is_admin) return $localize`:@@menu.administrador:Administrador`;
    if (isStaff(u)) return $localize`:@@menu.organizador:Organizador`;
    if (isCompetitorOnly(u)) return $localize`:@@menu.competidor:Competidor`;
    if (tatamiScopes(u).length) return $localize`:@@menu.operador-mesa:Operador de mesa`;
    return dojoAdminOf(u).length ? 'Sensei' : $localize`:@@menu.operador:Operador`;
  });

  /** Las llaves (/categorias/…) pertenecen a un torneo: se marca «Torneos» como sección activa. */
  private readonly url = toSignal(
    inject(Router).events.pipe(
      filter((e) => e instanceof NavigationEnd),
      map((e) => (e as NavigationEnd).urlAfterRedirects),
    ),
    { initialValue: inject(Router).url },
  );
  inBracket(it: NavItem): boolean {
    return it.path === '/torneos' && this.url().startsWith('/categorias/');
  }

  toggleMenu(slot: 'side' | 'top'): void {
    this.menuOpen.set(this.menuOpen() === slot ? null : slot);
  }

  onDocClick(ev: MouseEvent): void {
    if (!this.menuOpen()) return;
    const slot = (this.host.nativeElement as HTMLElement).querySelector(
      `[data-slot="${this.menuOpen()}"]`,
    );
    if (slot && !slot.contains(ev.target as Node)) this.menuOpen.set(null);
  }

  logout(): void {
    this.menuOpen.set(null);
    this.auth.logout();
  }
}
