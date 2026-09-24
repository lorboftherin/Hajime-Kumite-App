import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import { DialogService } from '../../core/dialog.service';
import { Dojo } from '../../core/models';
import { MutationService } from '../../core/mutation.service';
import { Modal } from '../../shared/modal';

@Component({
  selector: 'app-dojo-list',
  imports: [FormsModule, Modal],
  template: `
    <div class="container">
      <div class="page-header">
        <h1>Dojos</h1>
        <div class="row">
          <input placeholder="Buscar dojo…" [ngModel]="q()" (ngModelChange)="q.set($event)" />
          <button class="btn primary" (click)="openNew()">+ Nuevo dojo</button>
        </div>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Nombre</th><th>Abrev.</th><th>Ciudad</th><th>Sedes</th><th>Tipo</th><th></th></tr></thead>
          <tbody>
            @for (d of filtered(); track d.id) {
              <tr>
                <td><strong>{{ d.name }}</strong></td>
                <td class="mono">{{ d.short_name }}</td>
                <td>{{ d.city }}</td>
                <td class="small">
                  @for (b of d.branches; track b.id; let l = $last) {
                    {{ b.name }}@if (!l) {, }
                  } @empty {
                    <span class="muted">—</span>
                  }
                </td>
                <td>
                  @if (d.is_independent) {
                    <span class="badge">Independiente</span>
                  }
                  @if (d.is_claimed) {
                    <span class="badge ok">Registrado</span>
                  } @else {
                    <span class="badge">Manual</span>
                  }
                </td>
                <td class="right nowrap">
                  <button class="btn sm" (click)="openEdit(d)">Editar</button>
                  <button class="btn sm" (click)="addBranch(d)">+ Sede</button>
                </td>
              </tr>
            } @empty {
              <tr><td colspan="6" class="empty">No hay dojos.</td></tr>
            }
          </tbody>
        </table>
      </div>
    </div>

    @if (form(); as f) {
      <app-modal [title]="f.id ? 'Editar dojo' : 'Nuevo dojo'" (closed)="form.set(null)">
        <form (ngSubmit)="save(f)" class="stack">
          <label class="field"><span>Nombre *</span><input name="n" [(ngModel)]="f.name" required minlength="2" /></label>
          <div class="grid-2">
            <label class="field"><span>Abreviatura</span><input name="s" [(ngModel)]="f.short_name" /></label>
            <label class="field"><span>Ciudad</span><input name="c" [(ngModel)]="f.city" /></label>
          </div>
          @if (!f.id) {
            <label class="field inline"><input type="checkbox" name="i" [(ngModel)]="f.is_independent" /> Competidor independiente (sin dojo formal)</label>
            <label class="field">
              <span>Sedes (una por línea)</span>
              <textarea name="b" rows="3" [(ngModel)]="f.branches" placeholder="Sede Miraflores&#10;Sede Surco"></textarea>
            </label>
          }
          <div class="form-actions">
            <button type="button" class="btn" (click)="form.set(null)">Cancelar</button>
            <button class="btn primary" [disabled]="f.name.trim().length < 2">Guardar</button>
          </div>
        </form>
      </app-modal>
    }
  `,
})
export class DojoListPage {
  private api = inject(ApiService);
  private mut = inject(MutationService);
  private dialog = inject(DialogService);

  readonly dojos = signal<Dojo[]>([]);
  readonly q = signal('');
  readonly form = signal<{ id?: number; version?: number; name: string; short_name: string; city: string; is_independent: boolean; branches: string } | null>(null);
  readonly filtered = computed(() => {
    const q = this.q().trim().toLowerCase();
    return this.dojos().filter((d) => !q || d.name.toLowerCase().includes(q) || d.short_name.toLowerCase().includes(q) || d.city.toLowerCase().includes(q));
  });

  constructor() {
    this.load();
  }

  load(): void {
    this.api.get<Dojo[]>('/dojos').subscribe({ next: (d) => this.dojos.set(d), error: () => {} });
  }

  openNew(): void {
    this.form.set({ name: '', short_name: '', city: 'Lima', is_independent: false, branches: '' });
  }

  openEdit(d: Dojo): void {
    this.form.set({ id: d.id, version: d.version, name: d.name, short_name: d.short_name, city: d.city, is_independent: d.is_independent, branches: '' });
  }

  async save(f: NonNullable<ReturnType<typeof this.form>>): Promise<void> {
    let res: Dojo | undefined;
    if (f.id) {
      res = await this.mut.patch<Dojo>(
        `/dojos/${f.id}`,
        { version: f.version, name: f.name.trim(), short_name: f.short_name.trim(), city: f.city.trim() },
        { success: 'Dojo actualizado', onConflict: () => this.load() },
      );
    } else {
      const branches = f.branches
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean)
        .map((name) => ({ name }));
      res = await this.mut.post<Dojo>(
        '/dojos',
        { name: f.name.trim(), short_name: f.short_name.trim(), city: f.city.trim(), is_independent: f.is_independent, branches },
        { success: 'Dojo creado' },
      );
    }
    if (res) {
      this.form.set(null);
      this.load();
    }
  }

  async addBranch(d: Dojo): Promise<void> {
    const name = await this.dialog.prompt({ title: `Nueva sede · ${d.name}`, label: 'Nombre de la sede', minLength: 2 });
    if (!name) return;
    const res = await this.mut.post<Dojo>(`/dojos/${d.id}/branches`, { name }, { success: 'Sede agregada' });
    if (res) this.load();
  }
}
