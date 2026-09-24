import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import { User } from '../../core/models';
import { MutationService } from '../../core/mutation.service';
import { Modal } from '../../shared/modal';

@Component({
  selector: 'app-users',
  imports: [FormsModule, Modal],
  template: `
    <div class="container">
      <div class="page-header">
        <h1>Usuarios</h1>
        <button class="btn primary" (click)="showNew.set(true)">Nuevo usuario</button>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Usuario</th><th>Nombre</th><th>Rol</th></tr></thead>
          <tbody>
            @for (u of users(); track u.id) {
              <tr>
                <td class="mono">{{ u.username }}</td>
                <td>{{ u.display_name }}</td>
                <td>@if (u.is_admin) {<span class="badge dark">Admin</span>} @else {<span class="badge">Operador</span>}</td>
              </tr>
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
          <label class="field"><span>Contraseña (mín. 8)</span><input name="p" type="password" [(ngModel)]="form.password" required minlength="8" /></label>
          <label class="field inline"><input type="checkbox" name="a" [(ngModel)]="form.is_admin" /> Administrador global</label>
          <div class="form-actions">
            <button type="button" class="btn" (click)="showNew.set(false)">Cancelar</button>
            <button class="btn primary" [disabled]="form.username.length < 3 || form.password.length < 8">Crear</button>
          </div>
        </form>
      </app-modal>
    }
  `,
})
export class UsersPage {
  private api = inject(ApiService);
  private mut = inject(MutationService);
  readonly users = signal<User[]>([]);
  readonly showNew = signal(false);
  form = { username: '', display_name: '', password: '', is_admin: false };

  constructor() {
    this.load();
  }
  load(): void {
    this.api.get<User[]>('/users').subscribe({ next: (u) => this.users.set(u), error: () => {} });
  }
  async create(): Promise<void> {
    const r = await this.mut.post<User>('/users', { ...this.form }, { success: 'Usuario creado' });
    if (r) {
      this.showNew.set(false);
      this.form = { username: '', display_name: '', password: '', is_admin: false };
      this.load();
    }
  }
}
