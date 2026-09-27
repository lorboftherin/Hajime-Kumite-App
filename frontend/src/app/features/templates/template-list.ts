import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiError } from '../../core/api-error';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { DialogService } from '../../core/dialog.service';
import { FilesService } from '../../core/files.service';
import { FORMAT_LABEL, GRADES, MODALITY_LABEL, SEX_LABEL } from '../../core/format';
import { Template } from '../../core/models';
import { MutationService } from '../../core/mutation.service';
import { isStaff } from '../../core/roles';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../shared/icon';
import { Modal } from '../../shared/modal';
import { MoreMenu } from '../../shared/more-menu';
import { PageHead } from '../../shared/page-head';
import { LabelPipe } from '../../shared/pipes';
import { EditRow, blankRow, moveRow, toEditRow, toPayload, validateRows } from './template-logic';

@Component({
  selector: 'app-template-list',
  imports: [FormsModule, LabelPipe, PageHead, Icon, Modal, MoreMenu],
  template: `
    <div class="container">
      <app-page-head i18n-title="@@plantillas.plantillas-categorias" kanji="型" title="Plantillas de categorías">
        <div meta class="meta-line">
          <span i18n="@@plantillas.conjuntos-categorias-listos-para">Conjuntos de categorías listos para copiar a un torneo</span>
        </div>
        @if (canCreate()) {
          <button i18n="@@plantillas.nueva-plantilla" class="btn primary" (click)="openNew()">
            <app-icon name="plus" /> Nueva plantilla
          </button>
        }
      </app-page-head>
      <div class="layout">
        <nav i18n-aria-label="@@plantillas.plantillas" class="list" aria-label="Plantillas">
          @for (t of templates(); track t.id) {
            <button
              class="item"
              [class.on]="selected()?.id === t.id"
              [attr.aria-current]="selected()?.id === t.id ? 'true' : null"
              (click)="select(t)"
            >
              <span class="name">{{ t.name }}</span>
              <span class="muted small num"><ng-container i18n="@@plantillas.categorias">
                {{ t.items.length }} categorías · {{ orgName(t) }}
                </ng-container>@if (t.is_archived) {<ng-container i18n="@@plantillas.archivada">
                  · archivada
                </ng-container>}
              </span>
            </button>
          } @empty {
            <div i18n="@@plantillas.no-hay-plantillas" class="empty">No hay plantillas.</div>
          }
          <label i18n="@@plantillas.ver-archivadas" class="field inline small archived"
            ><input
              type="checkbox"
              [ngModel]="showArchived()"
              (ngModelChange)="showArchived.set($event); load()"
            />
            Ver archivadas</label
          >
        </nav>
        <section>
          @if (selected(); as t) {
            <div class="detail-head">
              <div class="grow">
                <h2>
                  {{ t.name }}
                  @if (t.is_archived) {
                    <span i18n="@@plantillas.archivada-2" class="badge nezumi">Archivada</span>
                  }
                </h2>
                @if (t.description) {
                  <p class="muted">{{ t.description }}</p>
                }
                @if (t.in_use) {
                  <p i18n="@@plantillas.uso-menos-torneo-cambiarla-no" class="hint">
                    La usó al menos un torneo: cambiarla no afecta a esos torneos; no se puede
                    borrar, solo archivar.
                  </p>
                }
              </div>
              <div class="row">
                @if (t.can_edit && !editing()) {
                  <button i18n="@@plantillas.editar-tabla" class="btn primary" (click)="startEdit()">Editar tabla</button>
                }
                <app-more i18n-label="@@plantillas.mas-acciones-plantilla" i18n-text="@@plantillas.mas" text="Más" label="Más acciones de la plantilla" [small]="false">
                  <button i18n="@@plantillas.exportar-excel"
                    class="menu-item"
                    (click)="
                      files.download(
                        '/templates/' + t.id + '/export.xlsx',
                        'plantilla-' + t.id + '.xlsx'
                      )
                    "
                  >
                    Exportar a Excel
                  </button>
                  @if (t.can_edit) {
                    <label i18n="@@plantillas.reemplazar-filas-desde-excel" class="menu-item">
                      Reemplazar filas desde Excel…
                      <input type="file" accept=".xlsx" hidden (change)="importFile($event, t)" />
                    </label>
                    <button i18n="@@plantillas.cambiar-nombre-descripcion" class="menu-item" (click)="openMeta(t)">
                      Cambiar nombre y descripción
                    </button>
                    <button i18n="@@plantillas.duplicar" class="menu-item" (click)="duplicate(t)">Duplicar</button>
                    <hr />
                    @if (t.is_archived) {
                      <button i18n="@@plantillas.restaurar" class="menu-item" (click)="setArchived(t, false)">Restaurar</button>
                    } @else if (t.in_use) {
                      <button i18n="@@plantillas.archivar" class="menu-item" (click)="remove(t)">Archivar…</button>
                    } @else {
                      <button i18n="@@plantillas.borrar" class="menu-item danger" (click)="remove(t)">Borrar…</button>
                    }
                  }
                </app-more>
              </div>
            </div>
            @if (editing()) {
              @if (errors().length) {
                <div class="alert danger small">
                  <ul>
                    @for (e of errors(); track e) {
                      <li>{{ e }}</li>
                    }
                  </ul>
                </div>
              }
              <div class="table-wrap">
                <table class="table edit">
                  <thead>
                    <tr>
                      <th i18n="@@plantillas.codigo">Código</th>
                      <th i18n="@@plantillas.nombre">Nombre</th>
                      <th i18n="@@plantillas.modalidad">Modalidad</th>
                      <th i18n="@@plantillas.eq">Eq.</th>
                      <th i18n="@@plantillas.sexo">Sexo</th>
                      <th i18n="@@plantillas.edad">Edad</th>
                      <th i18n="@@plantillas.grado">Grado</th>
                      <th i18n="@@plantillas.peso">Peso</th>
                      <th i18n="@@plantillas.formato">Formato</th>
                      <th i18n="@@plantillas.duracion-s">Duración (s)</th>
                      <th><span i18n="@@plantillas.acciones" class="sr-only">Acciones</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (r of rows(); track $index; let i = $index; let last = $last) {
                      <tr>
                        <td>
                          <input i18n-aria-label="@@plantillas.codigo-2"
                            class="code-in"
                            [(ngModel)]="r.code"
                            [name]="'c' + i"
                            aria-label="Código"
                          />
                        </td>
                        <td>
                          <input i18n-aria-label="@@plantillas.nombre-2"
                            class="name-in"
                            [(ngModel)]="r.name"
                            [name]="'n' + i"
                            aria-label="Nombre"
                          />
                        </td>
                        <td>
                          <select i18n-aria-label="@@plantillas.modalidad-2" [(ngModel)]="r.modality" [name]="'m' + i" aria-label="Modalidad">
                            <option i18n="@@plantillas.kumite" value="kumite">Kumite</option>
                            <option i18n="@@plantillas.kata" value="kata">Kata</option>
                          </select>
                        </td>
                        <td class="center">
                          <input i18n-aria-label="@@plantillas.equipos"
                            type="checkbox"
                            [(ngModel)]="r.is_team"
                            [name]="'t' + i"
                            aria-label="Por equipos"
                          />
                        </td>
                        <td>
                          <select i18n-aria-label="@@plantillas.sexo-2" [(ngModel)]="r.sex" [name]="'s' + i" aria-label="Sexo">
                            <option i18n="@@plantillas.m" value="M">M</option>
                            <option i18n="@@plantillas.f" value="F">F</option>
                            <option i18n="@@plantillas.mixto" value="X">Mixto</option>
                          </select>
                        </td>
                        <td class="nowrap">
                          <input i18n-aria-label="@@plantillas.edad-minima"
                            class="num-in"
                            inputmode="numeric"
                            [(ngModel)]="r.age_min"
                            [name]="'a' + i"
                            aria-label="Edad mínima"
                          />–<input i18n-aria-label="@@plantillas.edad-maxima"
                            class="num-in"
                            inputmode="numeric"
                            [(ngModel)]="r.age_max"
                            [name]="'b' + i"
                            aria-label="Edad máxima"
                          />
                        </td>
                        <td class="nowrap">
                          <select i18n-aria-label="@@plantillas.grado-desde"
                            [(ngModel)]="r.grade_min"
                            [name]="'g' + i"
                            aria-label="Grado desde"
                          >
                            <option [ngValue]="null">—</option>
                            @for (g of grades; track g; let gi = $index) {
                              <option [ngValue]="gi + 1">{{ g }}</option>
                            }
                          </select>
                          <select i18n-aria-label="@@plantillas.grado-hasta"
                            [(ngModel)]="r.grade_max"
                            [name]="'h' + i"
                            aria-label="Grado hasta"
                          >
                            <option [ngValue]="null">—</option>
                            @for (g of grades; track g; let gi = $index) {
                              <option [ngValue]="gi + 1">{{ g }}</option>
                            }
                          </select>
                        </td>
                        <td>
                          <input i18n-aria-label="@@plantillas.peso-2"
                            class="w-in"
                            [(ngModel)]="r.weight_class"
                            [name]="'w' + i"
                            placeholder="-45"
                            aria-label="Peso"
                          />
                        </td>
                        <td>
                          <select i18n-aria-label="@@plantillas.formato-2" [(ngModel)]="r.format" [name]="'f' + i" aria-label="Formato">
                            <option i18n="@@plantillas.torneo" [ngValue]="null">Del torneo</option>
                            <option i18n="@@plantillas.eliminacion" value="single_elimination">Eliminación</option>
                            <option i18n="@@plantillas.round-robin" value="round_robin">Round robin</option>
                            <option i18n="@@plantillas.rondas-kata" value="kata_rounds">Rondas de kata</option>
                          </select>
                        </td>
                        <td>
                          <input i18n-aria-label="@@plantillas.duracion-segundos"
                            class="num-in"
                            inputmode="numeric"
                            [(ngModel)]="r.duration_seconds"
                            [name]="'d' + i"
                            aria-label="Duración en segundos"
                          />
                        </td>
                        <td class="nowrap">
                          <button i18n-aria-label="@@plantillas.subir"
                            class="btn sm ghost icon-only"
                            (click)="move(i, -1)"
                            [disabled]="i === 0"
                            aria-label="Subir"
                          >
                            ↑
                          </button>
                          <button i18n-aria-label="@@plantillas.bajar"
                            class="btn sm ghost icon-only"
                            (click)="move(i, 1)"
                            [disabled]="last"
                            aria-label="Bajar"
                          >
                            ↓
                          </button>
                          <button i18n-aria-label="@@plantillas.quitar-fila"
                            class="btn sm ghost icon-only"
                            (click)="removeRow(i)"
                            aria-label="Quitar fila"
                          >
                            <app-icon name="close" />
                          </button>
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
              <div class="row edit-actions">
                <button i18n="@@plantillas.agregar-fila" class="btn" (click)="addRow()">
                  <app-icon name="plus" /> Agregar fila
                </button>
                <span class="grow"></span>
                <button i18n="@@plantillas.cancelar" class="btn ghost" (click)="cancelEdit()">Cancelar</button>
                <button i18n="@@plantillas.guardar-categorias" class="btn primary" [disabled]="saving()" (click)="saveRows(t)">
                  Guardar {{ rows().length }} categorías
                </button>
              </div>
            } @else {
              <div class="table-wrap">
                <table class="table">
                  <thead>
                    <tr>
                      <th i18n="@@plantillas.codigo">Código</th>
                      <th i18n="@@plantillas.nombre">Nombre</th>
                      <th i18n="@@plantillas.modalidad">Modalidad</th>
                      <th i18n="@@plantillas.sexo">Sexo</th>
                      <th i18n="@@plantillas.edad">Edad</th>
                      <th i18n="@@plantillas.grado">Grado</th>
                      <th i18n="@@plantillas.peso">Peso</th>
                      <th i18n="@@plantillas.formato">Formato</th>
                      <th i18n="@@plantillas.duracion" class="right">Duración</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (i of t.items; track i.id) {
                      <tr>
                        <td>
                          <span class="code">{{ i.code }}</span>
                        </td>
                        <td class="iname">
                          {{ i.name }}
                          @if (i.is_team) {
                            <span i18n="@@plantillas.equipos-2" class="badge plain">equipos</span>
                          }
                        </td>
                        <td>{{ i.modality | label: modality }}</td>
                        <td>{{ i.sex | label: sex }}</td>
                        <td class="nowrap">{{ range(i.age_min, i.age_max) }}</td>
                        <td class="nowrap small">{{ gradeRange(i.grade_min, i.grade_max) }}</td>
                        <td>{{ i.weight_class }}</td>
                        <td class="small">{{ i.format | label: format }}</td>
                        <td class="right nowrap">
                          {{ i.duration_seconds ? i.duration_seconds + ' s' : '' }}
                        </td>
                      </tr>
                    } @empty {
                      <tr>
                        <td colspan="9" class="empty"><ng-container i18n="@@plantillas.sin-categorias">
                          Sin categorías.
                          </ng-container>@if (t.can_edit) {<ng-container i18n="@@plantillas.usa-editar-tabla-para-agregarlas">
                            Usa «Editar tabla» para agregarlas.
                          </ng-container>}
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          } @else {
            <div class="card empty">
              <p><strong i18n="@@plantillas.selecciona-plantilla">Selecciona una plantilla.</strong></p>
            </div>
          }
        </section>
      </div>
    </div>

    @if (newOpen()) {
      <app-modal i18n-title="@@plantillas.nueva-plantilla-2" title="Nueva plantilla" (closed)="newOpen.set(false)">
        <form class="stack" (ngSubmit)="create()">
          <label class="field"
            ><span i18n="@@plantillas.nombre">Nombre</span><input name="nn" [(ngModel)]="meta.name" required autofocus
          /></label>
          <label class="field"
            ><span i18n="@@plantillas.descripcion">Descripción</span
            ><textarea name="nd" rows="3" [(ngModel)]="meta.description"></textarea>
          </label>
          @if (orgChoices().length > 1) {
            <label class="field">
              <span i18n="@@plantillas.organizacion">Organización</span>
              <select name="org" [(ngModel)]="newOrg">
                @for (o of orgChoices(); track o.id) {
                  <option [ngValue]="o.id">{{ o.name }}</option>
                }
              </select>
            </label>
          } @else if (orgChoices().length === 1) {
            <p i18n="@@plantillas.organizacion-2" class="hint">Organización: {{ orgChoices()[0].name }}</p>
          }
          <div class="form-actions">
            <label i18n="@@plantillas.importar-excel" i18n-title="@@plantillas.crear-plantilla-desde-excel-xlsx" class="btn" title="Crear la plantilla desde un Excel (.xlsx)">
              <app-icon name="upload" /> Importar Excel
              <input type="file" accept=".xlsx" hidden (change)="importFile($event, null)" />
            </label>
            <button i18n="@@plantillas.crear-vacia" class="btn primary" [disabled]="!meta.name.trim()">Crear vacía</button>
          </div>
        </form>
      </app-modal>
    }
    @if (metaOpen()) {
      <app-modal i18n-title="@@plantillas.nombre-descripcion" title="Nombre y descripción" (closed)="metaOpen.set(false)">
        <form class="stack" (ngSubmit)="saveMeta()">
          <label class="field"
            ><span i18n="@@plantillas.nombre">Nombre</span><input name="mn" [(ngModel)]="meta.name" required
          /></label>
          <label class="field"
            ><span i18n="@@plantillas.descripcion">Descripción</span
            ><textarea name="md" rows="3" [(ngModel)]="meta.description"></textarea>
          </label>
          <div class="form-actions">
            <button i18n="@@plantillas.guardar" class="btn primary" [disabled]="!meta.name.trim()">Guardar</button>
          </div>
        </form>
      </app-modal>
    }
  `,
  styles: `
    .layout {
      display: grid;
      grid-template-columns: 240px minmax(0, 1fr);
      gap: 2rem;
      align-items: start;
    }
    @media (max-width: 900px) {
      .layout {
        grid-template-columns: 1fr;
      }
    }
    .list {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      position: sticky;
      top: 1.5rem;
      .archived {
        margin-top: 0.75rem;
      }
    }
    .item {
      all: unset;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      gap: 0.1rem;
      width: 100%;
      padding: 0.75rem 0.9rem;
      border-radius: var(--radius-sm);
      border: 1px solid transparent;
      cursor: pointer;
      transition: background-color var(--dur-1) var(--ease);
      .name {
        font-weight: 500;
        color: var(--sumi-2);
      }
      &:hover {
        background: var(--hover);
      }
      &.on {
        background: var(--kinu);
        border-color: var(--kasumi);
        box-shadow: inset 3px 0 0 var(--sumi);
        .name {
          font-weight: 700;
          color: var(--sumi);
        }
      }
      &:focus-visible {
        outline: 2px solid var(--ai);
      }
    }
    .detail-head {
      display: flex;
      gap: 1rem;
      align-items: flex-start;
      margin-bottom: 1.25rem;
      h2 {
        margin: 0 0 0.25rem;
      }
      p {
        margin: 0;
        max-width: 70ch;
      }
    }
    .iname {
      font-weight: 500;
      min-width: 13rem;
    }
    .edit {
      td {
        padding: 0.3rem 0.35rem;
      }
      input,
      select {
        min-height: 2.1rem;
        padding: 0.2rem 0.4rem;
        font-size: var(--fs-14);
      }
      .code-in {
        width: 7rem;
      }
      .name-in {
        min-width: 14rem;
        width: 100%;
      }
      .num-in {
        width: 3.2rem;
        text-align: right;
      }
      .w-in {
        width: 4.5rem;
      }
    }
    .edit-actions {
      gap: 0.5rem;
    }
    label.menu-item {
      cursor: pointer;
    }
  `,
})
export class TemplateListPage {
  private api = inject(ApiService);
  private mut = inject(MutationService);
  private dialog = inject(DialogService);
  private toast = inject(ToastService);
  readonly files = inject(FilesService);
  readonly templates = signal<Template[]>([]);
  readonly selected = signal<Template | null>(null);
  readonly showArchived = signal(false);
  readonly editing = signal(false);
  readonly rows = signal<EditRow[]>([]);
  readonly errors = signal<string[]>([]);
  readonly saving = signal(false);
  readonly newOpen = signal(false);
  readonly metaOpen = signal(false);
  meta = { name: '', description: '' };
  readonly modality = MODALITY_LABEL;
  readonly sex = SEX_LABEL;
  readonly format = FORMAT_LABEL;
  readonly grades = GRADES;
  private auth = inject(AuthService);
  /** Admin y organizadores crean plantillas (el servidor decide igual: can_edit_template). */
  readonly canCreate = computed(() => isStaff(this.auth.user()));

  constructor() {
    this.load();
  }

  async load(keepId?: number): Promise<void> {
    try {
      const list = await firstValueFrom(
        this.api.get<Template[]>('/templates', { include_archived: this.showArchived() }),
      );
      this.templates.set(list);
      const id = keepId ?? this.selected()?.id;
      this.selected.set(list.find((t) => t.id === id) ?? list[0] ?? null);
    } catch {
      /* el interceptor ya avisó */
    }
  }

  select(t: Template): void {
    if (this.editing() && t.id !== this.selected()?.id) this.cancelEdit();
    this.selected.set(t);
  }

  startEdit(): void {
    const t = this.selected();
    if (!t) return;
    this.rows.set(t.items.map(toEditRow));
    this.errors.set([]);
    this.editing.set(true);
  }

  cancelEdit(): void {
    this.editing.set(false);
    this.errors.set([]);
  }

  addRow(): void {
    const rows = this.rows();
    this.rows.set([...rows, blankRow(rows[rows.length - 1])]);
  }

  removeRow(i: number): void {
    this.rows.set(this.rows().filter((_, j) => j !== i));
  }

  move(i: number, delta: number): void {
    this.rows.set(moveRow(this.rows(), i, delta));
  }

  async saveRows(t: Template): Promise<void> {
    const errs = validateRows(this.rows());
    this.errors.set(errs);
    if (errs.length) return;
    this.saving.set(true);
    const res = await this.mut.put<Template>(
      `/templates/${t.id}/items`,
      { version: t.version, items: toPayload(this.rows()) },
      { success: $localize`:@@plantillas.plantilla-guardada:Plantilla guardada`, onConflict: () => this.load(t.id) },
    );
    this.saving.set(false);
    if (res) {
      this.editing.set(false);
      await this.load(res.id);
    }
  }

  /** Dónde se puede crear: Global (solo el Admin) y las organizaciones donde es owner/admin. */
  readonly orgChoices = computed(() => {
    const u = this.auth.user();
    const orgs = (u?.organizations ?? [])
      .filter((o) => o.role === 'owner' || o.role === 'admin')
      .map((o) => ({ id: o.id as number | null, name: o.name }));
    return u?.is_admin ? [{ id: null, name: $localize`:@@plantillas.global-todas-organizaciones:Global (todas las organizaciones)` }, ...orgs] : orgs;
  });
  newOrg: number | null = null;

  /** Nombre de la organización dueña (o «Global») para mostrar en la lista. */
  orgName(t: Template): string {
    if (!t.organization_id) return $localize`:@@plantillas.global:Global`;
    return (
      (this.auth.user()?.organizations ?? []).find((o) => o.id === t.organization_id)?.name ??
      $localize`:@@plantillas.otra-organizacion:Otra organización`
    );
  }

  openNew(): void {
    this.meta = { name: '', description: '' };
    this.newOrg = this.orgChoices()[0]?.id ?? null;
    this.newOpen.set(true);
  }

  async create(): Promise<void> {
    const res = await this.mut.post<Template>(
      '/templates',
      {
        name: this.meta.name.trim(),
        description: this.meta.description,
        organization_id: this.newOrg,
        items: [],
      },
      { success: $localize`:@@plantillas.plantilla-creada:Plantilla creada` },
    );
    if (res) {
      this.newOpen.set(false);
      this.meta = { name: '', description: '' };
      await this.load(res.id);
      this.startEdit();
      this.addRow();
    }
  }

  openMeta(t: Template): void {
    this.meta = { name: t.name, description: t.description };
    this.metaOpen.set(true);
  }

  async saveMeta(): Promise<void> {
    const t = this.selected();
    if (!t) return;
    const res = await this.mut.patch<Template>(
      `/templates/${t.id}`,
      { version: t.version, name: this.meta.name.trim(), description: this.meta.description },
      { success: $localize`:@@plantillas.plantilla-actualizada:Plantilla actualizada`, onConflict: () => this.load(t.id) },
    );
    if (res) {
      this.metaOpen.set(false);
      await this.load(res.id);
    }
  }

  async duplicate(t: Template): Promise<void> {
    const name = await this.dialog.prompt({
      title: $localize`:@@plantillas.duplicar-plantilla:Duplicar plantilla`,
      label: $localize`:@@plantillas.nombre-copia:Nombre de la copia`,
      minLength: 1,
      initial: `${t.name} (copia)`,
      confirmText: $localize`:@@plantillas.duplicar-2:Duplicar`,
    });
    if (!name) return;
    const res = await this.mut.post<Template>(
      `/templates/${t.id}/duplicate`,
      { name },
      { success: $localize`:@@plantillas.plantilla-duplicada:Plantilla duplicada` },
    );
    if (res) await this.load(res.id);
  }

  async setArchived(t: Template, archived: boolean): Promise<void> {
    const res = await this.mut.patch<Template>(
      `/templates/${t.id}`,
      { version: t.version, is_archived: archived },
      { success: archived ? $localize`:@@plantillas.plantilla-archivada:Plantilla archivada` : $localize`:@@plantillas.plantilla-restaurada:Plantilla restaurada` },
    );
    if (res) await this.load(res.id);
  }

  async remove(t: Template): Promise<void> {
    const ok = await this.dialog.confirm({
      title: t.in_use ? $localize`:@@plantillas.archivar-plantilla:Archivar plantilla` : $localize`:@@plantillas.borrar-plantilla:Borrar plantilla`,
      message: t.in_use
        ? $localize`:@@plantillas.uso-torneo-archiva-deja:«${t.name}:name:» la usó un torneo: se archiva (deja de ofrecerse para torneos nuevos) y se puede restaurar.`
        : $localize`:@@plantillas.borra-categorias-no-puede:Se borra «${t.name}:name:» con sus ${t.items.length}:length: categorías. No se puede deshacer.`,
      confirmText: t.in_use ? $localize`:@@plantillas.archivar-2:Archivar` : $localize`:@@plantillas.borrar-2:Borrar`,
      danger: !t.in_use,
    });
    if (!ok) return;
    try {
      const res = await firstValueFrom(
        this.api.delete<{ deleted: boolean; archived: boolean }>(`/templates/${t.id}`),
      );
      this.toast.ok(res.deleted ? $localize`:@@plantillas.plantilla-borrada:Plantilla borrada` : $localize`:@@plantillas.plantilla-archivada:Plantilla archivada`);
      this.selected.set(null);
      await this.load();
    } catch (e) {
      this.toast.error(ApiError.from(e).fullMessage);
    }
  }

  async importFile(ev: Event, target: Template | null): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (target) {
      const ok = await this.dialog.confirm({
        title: $localize`:@@plantillas.reemplazar-filas:Reemplazar filas`,
        message: $localize`:@@plantillas.categorias-reemplazan-archivo:Las ${target.items.length}:length: categorías de «${target.name}:name:» se reemplazan por las del archivo.`,
        confirmText: $localize`:@@plantillas.reemplazar:Reemplazar`,
      });
      if (!ok) return;
    }
    try {
      const path = target
        ? `/templates/import?template_id=${target.id}`
        : this.newOrg !== null
          ? `/templates/import?organization_id=${this.newOrg}`
          : '/templates/import';
      const res = await firstValueFrom(this.api.upload<Template>(path, file));
      this.toast.ok($localize`:@@plantillas.plantilla-categorias-importadas:Plantilla «${res.name}:name:»: ${res.items.length}:length: categorías importadas`);
      this.newOpen.set(false);
      await this.load(res.id);
    } catch (e) {
      const err = ApiError.from(e);
      const rows = (err.details['errors'] as string[] | undefined) ?? [];
      if (rows.length) await this.dialog.alert($localize`:@@plantillas.plantilla-tiene-errores:La plantilla tiene errores`, err.message, rows);
      else this.toast.error(err.fullMessage);
    }
  }

  range(a: number | null, b: number | null): string {
    if (a === null && b === null) return $localize`:@@plantillas.libre:Libre`;
    if (b === null) return `${a}+`;
    if (a === null) return `≤ ${b}`;
    return `${a}–${b}`;
  }

  gradeRange(a: number | null, b: number | null): string {
    const g = (o: number | null) => (o === null ? null : (GRADES[o - 1] ?? String(o)));
    if (a === null && b === null) return $localize`:@@plantillas.todos:Todos`;
    if (b === null) return $localize`:@@plantillas.adelante:${g(a)}:g: en adelante`;
    if (a === null) return `hasta ${g(b)}`;
    return `${g(a)} – ${g(b)}`;
  }
}
