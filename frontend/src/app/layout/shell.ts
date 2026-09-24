import { Component, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from '../core/auth.service';

@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <header class="topbar no-print">
      <a class="brand" routerLink="/torneos" aria-label="Hajime, inicio">
        <span class="logo" aria-hidden="true"><span class="half aka"></span><span class="half ao"></span></span>
        Hajime
      </a>
      <button class="menu-toggle btn ghost sm" (click)="navOpen.set(!navOpen())" aria-label="Menú">☰</button>
      <nav [class.open]="navOpen()" (click)="navOpen.set(false)">
        <a routerLink="/torneos" routerLinkActive="active">Torneos</a>
        <a routerLink="/personas" routerLinkActive="active">Personas</a>
        <a routerLink="/dojos" routerLinkActive="active">Dojos</a>
        <a routerLink="/plantillas" routerLinkActive="active">Plantillas</a>
      </nav>
      <div class="user">
        <button class="btn ghost sm user-btn" (click)="menuOpen.set(!menuOpen())" [attr.aria-expanded]="menuOpen()">
          <span class="avatar">{{ initial() }}</span>
          <span class="uname">{{ auth.user()?.display_name || auth.user()?.username }}</span>
          @if (auth.isAdmin()) {
            <span class="badge dark">Admin</span>
          }
        </button>
        @if (menuOpen()) {
          <div class="menu" (click)="menuOpen.set(false)">
            <div class="menu-head small muted">Sesión: {{ auth.user()?.username }}</div>
            @if (auth.isAdmin()) {
              <a routerLink="/usuarios">Usuarios</a>
            }
            <button (click)="auth.logout()">Cerrar sesión</button>
          </div>
        }
      </div>
    </header>
    <main>
      <router-outlet />
    </main>
  `,
  styles: `
    .topbar {
      position: sticky;
      top: 0;
      z-index: 100;
      display: flex;
      align-items: center;
      gap: 1.25rem;
      padding: 0 1rem;
      height: 56px;
      background: var(--gray-900);
      color: #fff;
    }
    .brand {
      color: #fff;
      font-weight: 800;
      font-size: 1.2rem;
      letter-spacing: 0.02em;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      text-decoration: none;
    }
    .logo {
      display: inline-flex;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      overflow: hidden;
      border: 2px solid #fff;
    }
    .half {
      flex: 1;
    }
    .half.aka {
      background: var(--aka);
    }
    .half.ao {
      background: var(--ao);
    }
    nav {
      display: flex;
      gap: 0.25rem;
      flex: 1;
    }
    nav a {
      color: var(--gray-300);
      padding: 0.4rem 0.75rem;
      border-radius: var(--radius-sm);
      font-weight: 500;
      text-decoration: none;
    }
    nav a:hover {
      color: #fff;
      background: var(--gray-800);
    }
    nav a.active {
      color: #fff;
      background: var(--gray-700);
    }
    .user {
      position: relative;
    }
    .user-btn {
      color: #fff;
    }
    .user-btn:hover {
      background: var(--gray-800) !important;
    }
    .avatar {
      display: inline-grid;
      place-items: center;
      width: 26px;
      height: 26px;
      border-radius: 50%;
      background: var(--aka);
      font-weight: 700;
    }
    .menu {
      position: absolute;
      right: 0;
      top: 110%;
      background: #fff;
      color: var(--text);
      border-radius: var(--radius);
      box-shadow: var(--shadow-lg);
      min-width: 200px;
      padding: 0.35rem;
      display: flex;
      flex-direction: column;
    }
    .menu a,
    .menu button {
      text-align: left;
      padding: 0.5rem 0.75rem;
      border: 0;
      background: none;
      font: inherit;
      color: var(--gray-800);
      border-radius: var(--radius-sm);
      cursor: pointer;
    }
    .menu a:hover,
    .menu button:hover {
      background: var(--gray-100);
      text-decoration: none;
    }
    .menu-head {
      padding: 0.35rem 0.75rem;
    }
    .menu-toggle {
      display: none;
      color: #fff;
      font-size: 1.2rem;
    }
    @media (max-width: 720px) {
      .menu-toggle {
        display: inline-flex;
        margin-left: auto;
      }
      .uname {
        display: none;
      }
      nav {
        display: none;
        position: absolute;
        top: 56px;
        left: 0;
        right: 0;
        background: var(--gray-900);
        flex-direction: column;
        padding: 0.5rem;
      }
      nav.open {
        display: flex;
      }
    }
  `,
})
export class Shell {
  readonly auth = inject(AuthService);
  readonly menuOpen = signal(false);
  readonly navOpen = signal(false);
  initial(): string {
    const u = this.auth.user();
    return (u?.display_name || u?.username || '?').charAt(0).toUpperCase();
  }
}
