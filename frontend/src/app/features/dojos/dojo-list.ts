import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { DialogService } from '../../core/dialog.service';
import { Dojo } from '../../core/models';
import { MutationService } from '../../core/mutation.service';
import { Icon } from '../../shared/icon';
import { Modal } from '../../shared/modal';
import { MoreMenu } from '../../shared/more-menu';
import { PageHead } from '../../shared/page-head';

@Component({
  selector: 'app-dojo-list',
  imports: [FormsModule, Modal, RouterLink, PageHead, Icon, MoreMenu],
  template: `
    <div class="container">
      <app-page-head i18n-title="@@dojos.dojos" kanji="道場" title="Dojos">
        <div meta class="meta-line"><span i18n="@@dojos.dojos-clubes">{{ dojos().length }} dojos y clubes</span></div>
        <button i18n="@@dojos.nuevo-dojo" class="btn primary" (click)="openNew()"><app-icon name="plus" /> Nuevo dojo</button>
      </app-page-head>
      <div class="toolbar">
        <div class="search">
          <app-icon name="search" />
          <input i18n-aria-label="@@dojos.buscar-dojo" i18n-placeholder="@@dojos.buscar-nombre-abreviatura-ciudad" placeholder="Buscar por nombre, abreviatura o ciudad…" aria-label="Buscar dojo" [ngModel]="q()" (ngModelChange)="q.set($event)" />
        </div>
        <span i18n="@@dojos.de" class="count">{{ filtered().length }} de {{ dojos().length }}</span>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th i18n="@@dojos.nombre">Nombre</th><th i18n="@@dojos.abrev">Abrev.</th><th i18n="@@dojos.ciudad">Ciudad</th><th i18n="@@dojos.sedes">Sedes</th><th i18n="@@dojos.tipo">Tipo</th><th><span i18n="@@dojos.acciones" class="sr-only">Acciones</span></th></tr></thead>
          <tbody>
            @for (d of filtered(); track d.id) {
              <tr>
                <td class="who"><a [routerLink]="['/dojos', d.id]"><strong>{{ d.name }}</strong></a></td>
                <td><span class="code">{{ d.short_name }}</span></td>
                <td>{{ d.city }}</td>
                <td class="small">
                  @for (b of d.branches; track b.id; let l = $last) {
                    {{ b.name }}@if (!l) {, }
                  } @empty {
                    <span class="muted">—</span>
                  }
                </td>
                <td>
                  <div class="row types">
                    @if (d.is_independent) {
                      <span i18n="@@dojos.independiente" class="badge plain">Independiente</span>
                    }
                    @if (d.is_claimed) {
                      <span i18n="@@dojos.registrado" class="badge matcha">Registrado</span>
                    } @else {
                      <span i18n="@@dojos.manual" class="badge nezumi hollow">Manual</span>
                    }
                  </div>
                </td>
                <td class="right nowrap">
                  <app-more i18n-label="@@menu-mas.mas-acciones-de" label="Más acciones · {{ d.name }}">
                    <a i18n="@@dojos.ver-historial" class="menu-item" [routerLink]="['/dojos', d.id]"><app-icon name="history" /> Ver historial</a>
                    <button i18n="@@dojos.editar-datos" class="menu-item" (click)="openEdit(d)">Editar datos</button>
                    <button i18n="@@dojos.agregar-sede" class="menu-item" (click)="addBranch(d)"><app-icon name="plus" /> Agregar sede</button>
                  </app-more>
                </td>
              </tr>
            } @empty {
              <tr><td colspan="6" class="empty"><p><strong i18n="@@dojos.no-hay-dojos">No hay dojos.</strong></p><ng-container i18n="@@dojos.crea-primero-para-asociar">Crea el primero para asociar a sus competidores.</ng-container></td></tr>
            }
          </tbody>
        </table>
      </div>
    </div>

    @if (form(); as f) {
      <app-modal [title]="f.id ? textoEditarDojo : textoNuevoDojo" (closed)="form.set(null)">
        <form (ngSubmit)="save(f)" class="stack">
          <label class="field"><span i18n="@@dojos.nombre-2">Nombre *</span><input name="n" [(ngModel)]="f.name" required minlength="2" /></label>
          <div class="grid-2">
            <label class="field"><span i18n="@@dojos.abreviatura">Abreviatura</span><input name="s" [(ngModel)]="f.short_name" /></label>
            <label class="field"><span i18n="@@dojos.ciudad">Ciudad</span><input name="c" [(ngModel)]="f.city" /></label>
          </div>
          @if (!f.id) {
            <label i18n="@@dojos.competidor-independiente-sin" class="field inline"><input type="checkbox" name="i" [(ngModel)]="f.is_independent" /> Competidor independiente (sin dojo formal)</label>
            <label class="field">
              <span i18n="@@dojos.sedes-linea">Sedes (una por línea)</span>
              <textarea i18n-placeholder="@@dojos.sede-miraflores-sede-surco" name="b" rows="3" [(ngModel)]="f.branches" placeholder="Sede Miraflores&#10;Sede Surco"></textarea>
            </label>
          }
          <div class="form-actions">
            <button i18n="@@dojos.cancelar" type="button" class="btn" (click)="form.set(null)">Cancelar</button>
            <button i18n="@@dojos.guardar" class="btn primary" [disabled]="f.name.trim().length < 2">Guardar</button>
          </div>
        </form>
      </app-modal>
    }
  `,
  styles: `
    .who a {
      color: var(--sumi);
    }
    .who a:hover {
      color: var(--ai-ink);
    }
    .types {
      gap: 0.35rem;
      flex-wrap: nowrap;
    }
  `,
})
export class DojoListPage {
  readonly textoEditarDojo = $localize`:@@dojos.titulo-editar-dojo:Editar dojo`;
  readonly textoNuevoDojo = $localize`:@@dojos.titulo-nuevo-dojo:Nuevo dojo`;
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
        { success: $localize`:@@dojos.dojo-actualizado:Dojo actualizado`, onConflict: () => this.load() },
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
        { success: $localize`:@@dojos.dojo-creado:Dojo creado` },
      );
    }
    if (res) {
      this.form.set(null);
      this.load();
    }
  }

  async addBranch(d: Dojo): Promise<void> {
    const name = await this.dialog.prompt({ title: $localize`:@@dojos.nueva-sede:Nueva sede · ${d.name}:name:`, label: $localize`:@@dojos.nombre-sede:Nombre de la sede`, minLength: 2 });
    if (!name) return;
    const res = await this.mut.post<Dojo>(`/dojos/${d.id}/branches`, { name }, { success: $localize`:@@dojos.sede-agregada:Sede agregada` });
    if (res) this.load();
  }
}
