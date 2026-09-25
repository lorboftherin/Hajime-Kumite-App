import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiError } from '../../core/api-error';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { DialogService } from '../../core/dialog.service';
import { Dojo, Person, RoleOut, Tournament, User } from '../../core/models';
import { ROLE_LABEL, SCOPE_LABEL } from '../../core/format';
import { MutationService } from '../../core/mutation.service';
import { Icon } from '../../shared/icon';
import { Modal } from '../../shared/modal';
import { MoreMenu } from '../../shared/more-menu';
import { PageHead } from '../../shared/page-head';
import { MIN_PASSWORD, randomPassword } from '../../core/passwords';

@Component({
  selector: 'app-users',
  imports: [FormsModule, Modal, RouterLink, PageHead, Icon, MoreMenu],
  template: `
    <div class="container">
      <app-page-head kanji="管理" title="Usuarios">
        <div meta class="meta-line">
          <span>Cuentas con acceso a Hajime. Las contraseñas nuevas o reseteadas obligan a elegir una propia al ingresar.</span>
        </div>
        <button class="btn primary" (click)="openNew()"><app-icon name="plus" /> Nuevo usuario</button>
      </app-page-head>
      @if (problem()) {
        <div class="alert danger row" role="alert">
          <span class="grow">{{ problem() }}</span>
          <button class="btn sm ghost icon-only" (click)="problem.set('')" aria-label="Cerrar"><app-icon name="close" /></button>
        </div>
      }
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr><th>Usuario</th><th>Nombre</th><th>Persona</th><th>Rol</th><th>Estado</th><th class="right"><span class="sr-only">Acciones</span></th></tr>
          </thead>
          <tbody>
            @for (u of users(); track u.id) {
              <tr [class.inactive]="u.is_active === false">
                <td>
                  <div class="uname">
                    <span class="avatar" aria-hidden="true">{{ (u.display_name || u.username).charAt(0).toUpperCase() }}</span>
                    <span class="mono">{{ u.username }}</span>
                    @if (u.id === me()?.id) {
                      <span class="badge ai">Tú</span>
                    }
                  </div>
                </td>
                <td>{{ u.display_name }}</td>
                <td class="small">
                  @if (u.person_id) {
                    <a [routerLink]="['/personas', u.person_id]">#{{ u.person_id }}</a>
                  } @else {
                    <span class="muted">—</span>
                  }
                </td>
                <td>
                  <div class="row roles">
                    @if (u.is_admin) {
                      <span class="badge sumi">Admin</span>
                    }
                    @for (r of u.roles ?? []; track r.id) {
                      <span class="badge plain">{{ roleText(r) }}</span>
                    }
                    @if (!u.is_admin && !(u.roles ?? []).length) {
                      <span class="muted small">Sin rol</span>
                    }
                  </div>
                </td>
                <td>
                  <div class="row states">
                    @if (u.is_active === false) {
                      <span class="badge nezumi">Inactivo</span>
                    } @else {
                      <span class="badge matcha">Activo</span>
                    }
                    @if (u.must_change_password) {
                      <span class="badge yamabuki" title="Debe elegir una contraseña nueva al ingresar">Clave temporal</span>
                    }
                  </div>
                </td>
                <td class="right actions">
                  <button class="btn sm" (click)="openReset(u)"><app-icon name="key" /> Resetear contraseña</button>
                  <app-more [label]="'Más acciones · ' + u.username">
                    <button class="menu-item" (click)="openLink(u)">{{ u.person_id ? 'Cambiar persona vinculada' : 'Vincular persona' }}</button>
                    <button class="menu-item" (click)="toggleAdmin(u)">{{ u.is_admin ? 'Quitar rol de administrador' : 'Hacer administrador' }}</button>
                    <hr />
                    @if (u.is_active === false) {
                      <button class="menu-item" (click)="setActive(u, true)">Activar cuenta</button>
                    } @else {
                      <button class="menu-item danger" (click)="setActive(u, false)">Desactivar cuenta…</button>
                    }
                  </app-more>
                </td>
              </tr>
            } @empty {
              <tr><td colspan="6" class="empty"><p><strong>No hay usuarios.</strong></p></td></tr>
            }
          </tbody>
        </table>
      </div>
    </div>

    @if (showNew()) {
      <app-modal title="Nuevo usuario" (closed)="showNew.set(false)">
        <form (ngSubmit)="create()" class="stack">
          <label class="field"><span>Usuario</span><input name="u" [(ngModel)]="form.username" required minlength="3" /></label>
          <label class="field"><span>Nombre visible</span><input name="d" [(ngModel)]="form.display_name" /></label>
          <label class="field">
            <span>Contraseña temporal (mín. {{ min }})</span>
            <div class="row">
              <input class="grow mono" name="p" [(ngModel)]="form.password" required [minlength]="min" autocomplete="off" />
              <button type="button" class="btn sm" (click)="form.password = generate()">Generar</button>
            </div>
          </label>
          <label class="field inline"><input type="checkbox" name="a" [(ngModel)]="form.is_admin" /> Administrador global</label>
          <p class="hint">Al primer ingreso deberá elegir su propia contraseña.</p>
          <div class="form-actions">
            <button type="button" class="btn" (click)="showNew.set(false)">Cancelar</button>
            <button class="btn primary" [disabled]="form.username.trim().length < 3 || form.password.length < min">Crear</button>
          </div>
        </form>
      </app-modal>
    }

    @if (resetFor(); as u) {
      <app-modal [title]="'Resetear contraseña · ' + u.username" (closed)="resetFor.set(null)">
        <form (ngSubmit)="reset(u)" class="stack">
          <p class="small">
            Se cerrarán las sesiones abiertas de <strong>{{ u.username }}</strong> y deberá elegir una contraseña nueva al ingresar.
          </p>
          <label class="field">
            <span>Nueva contraseña temporal (mín. {{ min }})</span>
            <div class="row">
              <input class="grow mono" name="rp" [(ngModel)]="resetPassword" required [minlength]="min" autocomplete="off" />
              <button type="button" class="btn sm" (click)="resetPassword = generate()">Generar</button>
            </div>
          </label>
          <div class="form-actions">
            <button type="button" class="btn" (click)="resetFor.set(null)">Cancelar</button>
            <button class="btn primary" [disabled]="resetPassword.length < min">Resetear</button>
          </div>
        </form>
      </app-modal>
    }

    @if (handover(); as h) {
      <app-modal title="Contraseña temporal" (closed)="handover.set(null)">
        <div class="stack">
          <p>Entrega esta contraseña a <strong>{{ h.username }}</strong>. <strong>No se volverá a mostrar.</strong></p>
          <div class="secret mono" data-testid="temp-password">{{ h.password }}</div>
          <p class="hint">Al ingresar, el sistema le pedirá elegir una contraseña propia.</p>
          <div class="form-actions">
            <button type="button" class="btn" (click)="copy(h.password)">{{ copied() ? 'Copiada ✓' : 'Copiar' }}</button>
            <button type="button" class="btn primary" (click)="handover.set(null)">Listo, ya la entregué</button>
          </div>
        </div>
      </app-modal>
    }

    @if (linkFor(); as u) {
      <app-modal [title]="'Vincular persona · ' + u.username" (closed)="linkFor.set(null)">
        <div class="stack">
          <p class="hint">La persona vinculada define los roles (organizador, operador de mesa…) de esta cuenta.</p>
          <form class="row" (ngSubmit)="searchPersons()">
            <input class="grow" name="pq" placeholder="Buscar por nombre o documento…" [(ngModel)]="personQ" autofocus />
            <button class="btn">Buscar</button>
          </form>
          <ul class="list-plain">
            @for (p of personResults(); track p.id) {
              <li class="row">
                <span class="grow">
                  {{ p.first_names }} {{ p.last_names }} <span class="muted small">#{{ p.id }}</span>
                  @if (p.id === u.person_id) {
                    <span class="badge matcha">Vinculada</span>
                  }
                </span>
                <button class="btn sm primary" [disabled]="p.id === u.person_id" (click)="link(u, p.id)">Vincular</button>
              </li>
            } @empty {
              @if (searched()) {
                <li class="muted small">Sin resultados.</li>
              }
            }
          </ul>
          <div class="form-actions">
            @if (u.person_id) {
              <button type="button" class="btn danger" (click)="link(u, null)">Quitar vínculo</button>
            }
            <button type="button" class="btn" (click)="linkFor.set(null)">Cerrar</button>
          </div>
        </div>
      </app-modal>
    }
  `,
  styles: `
    .actions {
      white-space: nowrap;
      > * {
        vertical-align: middle;
      }
      app-more {
        margin-left: 0.25rem;
      }
    }
    .uname {
      display: flex;
      align-items: center;
      gap: 0.6rem;
    }
    .avatar {
      display: inline-grid;
      place-items: center;
      flex: none;
      width: 1.9rem;
      height: 1.9rem;
      border-radius: 50%;
      border: 1px solid var(--kasumi-2);
      background: var(--washi);
      font-family: var(--font-display);
      font-weight: 700;
      font-size: var(--fs-14);
    }
    .states,
    .roles {
      gap: 0.35rem;
    }
    tr.inactive td {
      color: var(--nezumi-ink);
    }
    tr.inactive .avatar {
      opacity: 0.5;
    }
    .secret {
      font-size: 1.5rem;
      padding: 1rem;
      text-align: center;
      letter-spacing: 0.1em;
      background: var(--washi);
      border: 1px dashed var(--kasumi-2);
      border-radius: var(--radius);
      user-select: all;
    }
  `,
})
export class UsersPage {
  private api = inject(ApiService);
  private mut = inject(MutationService);
  private dialog = inject(DialogService);
  private auth = inject(AuthService);

  readonly min = MIN_PASSWORD;
  readonly me = computed(() => this.auth.user());
  readonly users = signal<User[]>([]);
  readonly showNew = signal(false);
  readonly problem = signal('');
  readonly resetFor = signal<User | null>(null);
  readonly handover = signal<{ username: string; password: string } | null>(null);
  readonly copied = signal(false);
  readonly linkFor = signal<User | null>(null);
  readonly personResults = signal<Person[]>([]);
  readonly searched = signal(false);
  form = { username: '', display_name: '', password: '', is_admin: false };
  resetPassword = '';
  personQ = '';

  constructor() {
    this.load();
  }

  load(): void {
    this.api.get<User[]>('/users').subscribe({ next: (u) => this.users.set(u), error: () => {} });
    // Nombres de torneos y dojos para mostrar el alcance de cada rol.
    this.api.get<Tournament[]>('/tournaments').subscribe({
      next: (ts) =>
        this.scopeNames.update((m) => ({
          ...m,
          ...Object.fromEntries(ts.map((t) => [`tournament:${t.id}`, t.name])),
          ...Object.fromEntries(ts.flatMap((t) => t.tatamis.map((tt) => [`tatami:${tt.id}`, `${tt.name} · ${t.name}`]))),
        })),
      error: () => {},
    });
    this.api.get<Dojo[]>('/dojos').subscribe({
      next: (ds) => this.scopeNames.update((m) => ({ ...m, ...Object.fromEntries(ds.map((d) => [`dojo:${d.id}`, d.name])) })),
      error: () => {},
    });
  }

  readonly scopeNames = signal<Record<string, string>>({});

  /** "Organizador · Copa Primavera 2026", "Operador de mesa · torneo 3", "Árbitro" (global). */
  roleText(r: RoleOut): string {
    const label = ROLE_LABEL[r.role] ?? r.role;
    if (r.scope_type === 'global' || r.scope_id === null) return label;
    const name = this.scopeNames()[`${r.scope_type}:${r.scope_id}`];
    return `${label} · ${name ?? `${SCOPE_LABEL[r.scope_type] ?? r.scope_type} ${r.scope_id}`}`;
  }

  generate(): string {
    return randomPassword();
  }

  openNew(): void {
    this.form = { username: '', display_name: '', password: randomPassword(), is_admin: false };
    this.showNew.set(true);
  }

  async create(): Promise<void> {
    const password = this.form.password;
    const r = await this.mut.post<User>('/users', { ...this.form, username: this.form.username.trim() }, { success: 'Usuario creado' });
    if (r) {
      this.showNew.set(false);
      this.showHandover(r.username, password);
      this.load();
    }
  }

  /** PATCH /users/{id}; los 409 (p. ej. desactivarse a uno mismo) se muestran en la página. */
  private async update(u: User, body: Record<string, unknown>, success: string): Promise<User | undefined> {
    this.problem.set('');
    const r = await this.mut.patch<User>(`/users/${u.id}`, body, {
      success,
      onError: (err: ApiError) => {
        if (err.status === 409 || err.status === 403 || err.status === 404) {
          this.problem.set(err.fullMessage);
          return true;
        }
        return false;
      },
    });
    if (r) this.load();
    return r;
  }

  async setActive(u: User, active: boolean): Promise<void> {
    if (!active) {
      const ok = await this.dialog.confirm({
        title: 'Desactivar usuario',
        message: `${u.username} no podrá ingresar y se cerrarán sus sesiones abiertas. Puedes reactivarlo cuando quieras.`,
        confirmText: 'Desactivar',
        danger: true,
      });
      if (!ok) return;
    }
    await this.update(u, { is_active: active }, active ? 'Usuario activado' : 'Usuario desactivado');
  }

  async toggleAdmin(u: User): Promise<void> {
    const makeAdmin = !u.is_admin;
    const ok = await this.dialog.confirm({
      title: makeAdmin ? 'Dar rol de Admin' : 'Quitar rol de Admin',
      message: makeAdmin
        ? `${u.username} podrá administrar usuarios, fusionar personas y cambiar cualquier dato.`
        : `${u.username} dejará de ser administrador global.`,
      confirmText: makeAdmin ? 'Hacer admin' : 'Quitar admin',
      danger: !makeAdmin,
    });
    if (!ok) return;
    await this.update(u, { is_admin: makeAdmin }, makeAdmin ? 'Ahora es Admin' : 'Ya no es Admin');
  }

  openReset(u: User): void {
    this.resetPassword = randomPassword();
    this.resetFor.set(u);
  }

  async reset(u: User): Promise<void> {
    const password = this.resetPassword;
    const r = await this.update(u, { reset_password: password }, 'Contraseña reseteada');
    this.resetFor.set(null);
    if (r) this.showHandover(u.username, password);
  }

  private showHandover(username: string, password: string): void {
    this.copied.set(false);
    this.handover.set({ username, password });
  }

  async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(true);
    } catch {
      /* sin portapapeles: el texto se puede seleccionar a mano */
    }
  }

  openLink(u: User): void {
    this.personQ = '';
    this.personResults.set([]);
    this.searched.set(false);
    this.linkFor.set(u);
  }

  searchPersons(): void {
    const q = this.personQ.trim();
    if (!q) return;
    this.api.get<Person[]>('/persons', { q, limit: 20 }).subscribe({
      next: (p) => {
        this.personResults.set(p);
        this.searched.set(true);
      },
      error: () => {},
    });
  }

  async link(u: User, personId: number | null): Promise<void> {
    const r = await this.update(u, { person_id: personId }, personId ? 'Persona vinculada' : 'Vínculo quitado');
    if (r) this.linkFor.set(null);
  }
}
