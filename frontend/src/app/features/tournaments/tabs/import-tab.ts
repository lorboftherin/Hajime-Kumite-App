import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiError } from '../../../core/api-error';
import { ApiService, LONG_TIMEOUT_MS } from '../../../core/api.service';
import { DialogService } from '../../../core/dialog.service';
import { FilesService } from '../../../core/files.service';
import { DUPLICATE_REASON, IMPORT_BATCH_STATUS } from '../../../core/format';
import { ImportBatch, ImportRow } from '../../../core/models';
import { MutationService } from '../../../core/mutation.service';
import { ToastService } from '../../../core/toast.service';
import { StatusBadge } from '../../../shared/badge';
import { Icon } from '../../../shared/icon';
import { TournamentContext } from '../tournament-context';
import { lista } from '../../../core/i18n/etiquetas';

interface Decision {
  action: 'create' | 'use_existing' | 'skip';
  person_id: number | null;
  category_ids: Set<number>;
}

/** Columnas editables de una fila (mismas claves que la plantilla). */
const ROW_FIELDS: Array<{ key: string; label: string; placeholder?: string }> = lista(() => [
  { key: 'nombres', label: $localize`:@@torneo.importar.nombres:Nombres` },
  { key: 'apellidos', label: $localize`:@@torneo.importar.apellidos:Apellidos` },
  { key: 'fecha_nacimiento', label: $localize`:@@torneo.importar.fecha-nacimiento:Fecha de nacimiento`, placeholder: 'dd/mm/aaaa' },
  { key: 'sexo', label: $localize`:@@torneo.importar.sexo-m-f:Sexo (M/F)` },
  { key: 'grado', label: $localize`:@@torneo.importar.grado:Grado`, placeholder: '8 kyu, 1 dan…' },
  { key: 'categoria_peso', label: $localize`:@@torneo.importar.peso:Peso`, placeholder: '-45' },
  { key: 'dojo', label: 'Dojo' },
  { key: 'tipo_documento', label: $localize`:@@torneo.importar.tipo-documento:Tipo de documento`, placeholder: 'DNI, CE, PASSPORT' },
  { key: 'numero_documento', label: $localize`:@@torneo.importar.numero-documento:Número de documento` },
  { key: 'modalidades', label: $localize`:@@torneo.importar.modalidades:Modalidades`, placeholder: 'kumite, kata' },
  { key: 'rol', label: $localize`:@@torneo.importar.rol:Rol`, placeholder: 'competidor, árbitro, sensei' },
]);
// Palabras que acepta la importación (el backend las lee en español): no se traducen.
const ROLE_WORD: Record<string, string> = { competitor: 'competidor', referee: 'árbitro', sensei: 'sensei' };

@Component({
  selector: 'app-import-tab',
  imports: [FormsModule, StatusBadge, Icon],
  template: `
    <div class="card intro">
      <h2 i18n="@@torneo.importar.importar-inscripciones-desde">Importar inscripciones desde Excel</h2>
      <ol class="steps">
        <li i18n="@@torneo.importar.descarga-plantilla-columnas">Descarga la plantilla con columnas fijas y compártela con los dojos.</li>
        <li i18n="@@torneo.importar.sube-archivo-veras-vista-previa">Sube el archivo: verás una vista previa fila por fila (nueva, posible duplicado o con error).</li>
        <li i18n="@@torneo.importar.revisa-decisiones-categorias">Revisa las decisiones y categorías sugeridas; solo al confirmar se guarda algo.</li>
      </ol>
      <div class="row">
        <button i18n="@@torneo.importar.descargar-plantilla-xlsx" class="btn" (click)="downloadTemplate()"><app-icon name="download" /> Descargar plantilla .xlsx</button>
        <label i18n="@@torneo.importar.subir-archivo" class="btn primary">
          <app-icon name="upload" /> Subir archivo
          <input type="file" accept=".xlsx" hidden (change)="upload($event)" />
        </label>
        @if (uploading()) {
          <span class="spinner"></span> <span i18n="@@torneo.importar.procesando" class="small muted">Procesando…</span>
        }
      </div>
    </div>

    @if (batch(); as b) {
      <div class="card">
        <div class="row">
          <h2 i18n="@@torneo.importar.vista-previa" class="grow preview-title">Vista previa <span class="muted file">{{ b.filename }}</span> <span class="badge plain">{{ batchStatusText(b.status) }}</span></h2>
          <span i18n="@@torneo.importar.n-nuevas" class="badge matcha">{counts().new, plural, =1 {1 nueva} other {{{ counts().new }} nuevas}}</span>
          <span i18n="@@torneo.importar.n-duplicados" class="badge yamabuki">{counts().duplicate, plural, =1 {1 posible duplicado} other {{{ counts().duplicate }} posibles duplicados}}</span>
          <span i18n="@@torneo.importar.n-con-error" class="badge shu">{counts().error, plural, =1 {1 con error} other {{{ counts().error }} con error}}</span>
        </div>
        <div class="table-wrap mt">
          <table class="table preview-table">
            <colgroup>
              <col class="c-row" />
              <col class="c-person" />
              <col class="c-dojo" />
              <col class="c-status" />
              <col class="c-decision" />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th i18n="@@torneo.importar.fila">Fila</th>
                <th i18n="@@torneo.importar.persona">Persona</th>
                <th i18n="@@torneo.importar.dojo">Dojo</th>
                <th i18n="@@torneo.importar.estado">Estado</th>
                <th i18n="@@torneo.importar.decision">Decisión</th>
                <th i18n="@@torneo.importar.categorias">Categorías</th>
              </tr>
            </thead>
            <tbody>
              @for (r of b.rows; track r.id) {
                @let d = decisions()[r.id];
                <tr [class.diff]="r.status === 'duplicate'" [class.struck]="d?.action === 'skip'">
                  <td class="mono">{{ r.row_number }}</td>
                  <td>
                    <strong>{{ r.data['apellidos'] }}, {{ r.data['nombres'] }}</strong>
                    @for (role of staffRoles(r.data['rol']); track role) {
                      <span class="badge ai">{{ role }}</span>
                    }
                    <div class="muted small">
                      {{ r.data['sexo'] }} · {{ r.data['fecha_nacimiento'] || 's/f' }} · {{ r.data['grado'] || 's/g' }}
                      @if (r.data['numero_documento']) { · {{ r.data['tipo_documento'] }} {{ r.data['numero_documento'] }} }
                      @if (r.data['categoria_peso']) {<ng-container i18n="@@torneo.importar.kg"> · {{ r.data['categoria_peso'] }} kg </ng-container>}
                    </div>
                  </td>
                  <td>
                    {{ r.data['dojo'] }}
                    @if (!r.data['dojo_id'] && r.data['dojo']) {
                      <div i18n="@@torneo.importar.creara" class="small muted">(se creará)</div>
                    }
                  </td>
                  <td>
                    <app-status [status]="r.status" type="import" />
                    @for (e of r.errors; track $index) {
                      <div class="error-text">{{ e }}</div>
                    }
                    <!-- Avisos que no impiden importar (p. ej. sin peso: confirmar la categoría de kumite). -->
                    @for (w of r.data['avisos'] ?? []; track $index) {
                      <div class="small warn-text">{{ w }}</div>
                    }
                    @if (b.status === 'preview' && editing() !== r.id) {
                      <button class="btn sm mt-xs" [class.primary]="r.status === 'error'" [class.ghost]="r.status !== 'error'" (click)="startEdit(r)">
                        <ng-container i18n="@@torneo.importar.corregir-editar">{r.status, select, error {Corregir} other {Editar datos}}</ng-container>
                      </button>
                    }
                    @for (dup of r.duplicates; track $index) {
                      <div class="small">
                        @if (dup['person_id']) {
                          ≈ {{ dup['full_name'] }} (#{{ dup['person_id'] }}) · {{ dupReasonText(dup['reason']) }}
                        } @else {<ng-container i18n="@@torneo.importar.fila-mismo-archivo">
                          ≈ fila {{ dup['row_number'] }} del mismo archivo
                        </ng-container>}
                      </div>
                    }
                  </td>
                  <td>
                    @if (r.status === 'error') {
                      <span i18n="@@torneo.importar.omite" class="muted small">Se omite</span>
                    } @else if (d) {
                      <select i18n-aria-label="@@torneo.importar.decision-2" class="cell-input" [ngModel]="d.action" (ngModelChange)="setAction(r, $event)" aria-label="Decisión">
                        <option i18n="@@torneo.importar.crear-persona" value="create">Crear persona</option>
                        @if (personDups(r).length) {
                          <option i18n="@@torneo.importar.usar-existente" value="use_existing">Usar existente</option>
                        }
                        <option i18n="@@torneo.importar.omitir" value="skip">Omitir</option>
                      </select>
                      @if (d.action === 'use_existing') {
                        <select class="mt-xs cell-input" [ngModel]="d.person_id" (ngModelChange)="setPerson(r, $event)">
                          @for (dup of personDups(r); track dup['person_id']) {
                            <option [ngValue]="dup['person_id']">{{ dup['full_name'] }} (#{{ dup['person_id'] }})</option>
                          }
                        </select>
                      }
                    }
                  </td>
                  <td class="small">
                    @if (d && r.status !== 'error') {
                      @for (cid of rowCats(r); track cid) {
                        <label class="field inline"><input type="checkbox" [checked]="d.category_ids.has(cid)" [disabled]="d.action === 'skip'" (change)="toggleCat(r, cid)" /> {{ catName(cid) }}</label>
                      } @empty {
                        <span i18n="@@torneo.importar.sin-sugerencias-elige-categoria" class="muted">Sin sugerencias: elige una categoría.</span>
                      }
                      @if (d.action !== 'skip' && isCompetitor(r)) {
                        <select class="cell-input mt-xs" [ngModel]="0" (ngModelChange)="addCat(r, $event)" [attr.aria-label]="ariaOtraCategoria(r.row_number)">
                          <option i18n="@@torneo.importar.otra-elegir-categoria" [ngValue]="0">@if (rowCats(r).length) {+ Otra categoría…} @else {Elegir categoría…}</option>
                          @for (c of manualCategories(); track c.id) {
                            @if (!d.category_ids.has(c.id)) {
                              <option [ngValue]="c.id">{{ c.name }}</option>
                            }
                          }
                        </select>
                      }
                    }
                  </td>
                </tr>
                @if (editing() === r.id) {
                  <tr class="edit-row">
                    <td colspan="6">
                      <form class="row-form" (ngSubmit)="saveRow(b, r)">
                        <div class="row-fields">
                          @for (f of rowFields; track f.key) {
                            <label class="field">
                              <span>{{ f.label }}</span>
                              <input [name]="f.key" [(ngModel)]="rowForm[f.key]" [placeholder]="f.placeholder ?? ''" />
                            </label>
                          }
                        </div>
                        <div class="row">
                          <button i18n="@@torneo.importar.cancelar" type="button" class="btn sm" (click)="editing.set(null)">Cancelar</button>
                          <button i18n="@@torneo.importar.guardar-revalidar" class="btn sm primary" [disabled]="busy()">Guardar y revalidar</button>
                        </div>
                      </form>
                    </td>
                  </tr>
                }
              }
            </tbody>
          </table>
        </div>
        @if (b.status === 'preview') {
          <div class="form-actions">
            <button i18n="@@torneo.importar.cancelar-importacion" class="btn" (click)="cancel()">Cancelar importación</button>
            <button i18n="@@torneo.importar.confirmar-e-inscribir" class="btn primary" [disabled]="busy()" (click)="confirm()">Confirmar e inscribir</button>
          </div>
        }
      </div>
    }

    @if (result(); as res) {
      <div class="alert ok import-result">
        <strong i18n="@@torneo.importar.importacion-confirmada">Importación confirmada.</strong>
        <ul>
          @for (kv of resultEntries(); track kv[0]) {
            <li>{{ resultLabel[kv[0]] ?? kv[0] }}: <strong>{{ kv[1] }}</strong></li>
          }
        </ul>
      </div>
    }
  `,
  styles: `
    .intro h2 {
      margin-bottom: 0.25rem;
    }
    .preview-title {
      margin: 0;
      font-size: var(--fs-20);
      .file {
        font-family: var(--font-ui);
        font-size: var(--fs-14);
        font-weight: 400;
        margin: 0 0.35rem;
      }
    }
    /* En el celular la tabla se desplaza de lado con la fila y la persona fijas a la izquierda. */
    .preview-table th:nth-child(-n + 2),
    .preview-table td:nth-child(-n + 2) {
      position: sticky;
      z-index: 1;
      background: var(--kinu);
    }
    .preview-table th:first-child,
    .preview-table td:first-child {
      left: 0;
    }
    .preview-table th:nth-child(2),
    .preview-table td:nth-child(2) {
      left: 3.25rem;
      box-shadow: 1px 0 0 var(--kasumi);
    }
    .preview-table tr.edit-row td {
      position: static;
      box-shadow: none;
      background: var(--washi);
    }
    .row-form {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      max-width: calc(100vw - 3rem);
    }
    .row-fields {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
      gap: 0.5rem 0.75rem;
    }
    /* Anchos fijos: Persona y Categorías no se parten en muchas líneas. */
    .preview-table {
      table-layout: fixed;
      min-width: 56rem;
      th,
      td {
        padding-left: 0.6rem;
        padding-right: 0.6rem;
        vertical-align: top;
      }
      .c-row {
        width: 3.25rem;
      }
      .c-person {
        width: 13.5rem;
      }
      .c-dojo {
        width: 8.5rem;
      }
      .c-status {
        width: 11.5rem;
      }
      .c-decision {
        width: 10.5rem;
      }
      label.field.inline {
        align-items: flex-start;
        line-height: 1.35;
        margin-bottom: 0.3rem;
      }
    }
    .cell-input {
      width: 100%;
      min-width: 0;
      font-size: var(--fs-14);
    }
    .mt-xs {
      margin-top: 0.3rem;
      display: block;
    }
    label.btn {
      cursor: pointer;
    }
  `,
})
export class ImportTab {
  ariaOtraCategoria = (fila: number) => $localize`:@@torneo.importar.otra-categoria-fila:Otra categoría para la fila ${fila}:fila:`;
  /** Roles distintos de competidor (árbitro, sensei) para mostrarlos en la vista previa. */
  staffRoles(roles: unknown): string[] {
    const label: Record<string, string> = { referee: $localize`:@@torneo.importar.arbitro-2:Árbitro`, sensei: 'Sensei' };
    return Array.isArray(roles) ? roles.filter((r) => r in label).map((r) => label[r]) : [];
  }

  readonly ctx = inject(TournamentContext);
  private api = inject(ApiService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private files = inject(FilesService);
  private mut = inject(MutationService);
  private dialog = inject(DialogService);
  private toast = inject(ToastService);

  batchStatusText(status: string): string {
    return IMPORT_BATCH_STATUS[status] ?? status;
  }
  dupReasonText(reason: unknown): string {
    return DUPLICATE_REASON[String(reason)] ?? String(reason ?? '');
  }
  readonly resultLabel: Record<string, string | undefined> = {
    created_people: $localize`:@@torneo.importar.personas-creadas:Personas creadas`,
    registrations: $localize`:@@torneo.importar.inscripciones-creadas:Inscripciones creadas`,
    skipped: $localize`:@@torneo.importar.filas-omitidas:Filas omitidas`,
  };
  readonly batch = signal<ImportBatch | null>(null);
  readonly decisions = signal<Record<number, Decision>>({});
  readonly uploading = signal(false);
  readonly busy = signal(false);
  readonly result = signal<Record<string, unknown> | null>(null);

  readonly counts = computed(() => {
    const c = { new: 0, duplicate: 0, error: 0 };
    for (const r of this.batch()?.rows ?? []) {
      if (r.status in c) c[r.status as keyof typeof c]++;
    }
    return c;
  });
  readonly resultEntries = computed(() => Object.entries(this.result() ?? {}).filter(([, v]) => typeof v !== 'object'));

  constructor() {
    if (!this.ctx.categories().length) this.ctx.loadCategories();
    // Al recargar la página se retoma la vista previa del lote (?lote=<id>).
    const bid = Number(this.route.snapshot.queryParamMap.get('lote'));
    if (bid) this.resume(bid);
  }

  private async resume(bid: number): Promise<void> {
    try {
      const b = await firstValueFrom(this.api.get<ImportBatch>(`/imports/${bid}`));
      if (b.tournament_id === this.ctx.id() && b.status === 'preview') this.setBatch(b);
      else this.setLote(null);
    } catch {
      this.setLote(null);
    }
  }

  /** Guarda el lote en la URL para poder recargar sin perder la vista previa. */
  private setLote(bid: number | null): void {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { lote: bid },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  // --- Corrección de filas y categoría manual ---
  readonly rowFields = ROW_FIELDS;
  readonly editing = signal<number | null>(null);
  rowForm: Record<string, string> = {};

  /** Categorías que se pueden elegir a mano (individuales y abiertas a inscripción). */
  readonly manualCategories = computed(() =>
    this.ctx.categories().filter((c) => !c.is_team && ['open', 'empty'].includes(c.status)),
  );

  isCompetitor(r: ImportRow): boolean {
    const roles = r.data['rol'];
    return !Array.isArray(roles) || roles.includes('competitor');
  }

  /** Sugeridas más las elegidas a mano, sin repetir. */
  rowCats(r: ImportRow): number[] {
    const d = this.decisions()[r.id];
    return [...new Set([...r.suggested_category_ids, ...(d ? [...d.category_ids] : [])])];
  }

  addCat(r: ImportRow, cid: number): void {
    if (!cid) return;
    this.patch(r, (d) => ({ ...d, category_ids: new Set([...d.category_ids, cid]) }));
  }

  startEdit(r: ImportRow): void {
    const text = (k: string): string => {
      const v = r.data[k];
      if (Array.isArray(v)) return v.map((x) => (k === 'rol' ? (ROLE_WORD[x] ?? x) : x)).join(', ');
      return v === null || v === undefined ? '' : String(v);
    };
    this.rowForm = Object.fromEntries(ROW_FIELDS.map((f) => [f.key, text(f.key)]));
    this.editing.set(r.id);
  }

  async saveRow(b: ImportBatch, r: ImportRow): Promise<void> {
    this.busy.set(true);
    const res = await this.mut.patch<ImportBatch>(`/imports/${b.id}/rows/${r.id}`, { data: this.rowForm });
    this.busy.set(false);
    if (!res) return;
    const row = res.rows.find((x) => x.id === r.id);
    this.editing.set(null);
    // Solo cambia la fila corregida: las decisiones de las demás se conservan.
    this.batch.set(res);
    if (row) this.decisions.update((all) => ({ ...all, [row.id]: this.defaultDecision(row) }));
    this.toast.show(
      row?.status === 'error'
        ? $localize`:@@torneo.importar.fila-sigue-errores:Fila ${r.row_number}:row_number:: sigue con errores`
        : $localize`:@@torneo.importar.fila-corregida:Fila ${r.row_number}:row_number: corregida`,
      row?.status === 'error' ? 'warn' : 'ok',
    );
  }

  catName(id: number): string {
    return this.ctx.categoryById().get(id)?.name ?? `#${id}`;
  }

  personDups(r: ImportRow): Array<Record<string, any>> {
    return r.duplicates.filter((d) => d['person_id']);
  }

  downloadTemplate(): void {
    this.files.download('/imports/template.xlsx', 'plantilla-inscripciones.xlsx');
  }

  async upload(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.uploading.set(true);
    this.result.set(null);
    try {
      const b = await firstValueFrom(this.api.upload<ImportBatch>(`/tournaments/${this.ctx.id()}/imports`, file));
      this.setBatch(b);
      this.setLote(b.id);
    } catch (e) {
      this.toast.error(ApiError.from(e).fullMessage);
    } finally {
      this.uploading.set(false);
    }
  }

  private defaultDecision(r: ImportRow): Decision {
    const dups = this.personDups(r);
    return {
      // Un posible duplicado de BD se propone como "usar existente"; el operador decide.
      action: r.status === 'error' ? 'skip' : dups.length ? 'use_existing' : 'create',
      person_id: dups[0]?.['person_id'] ?? null,
      category_ids: new Set(r.suggested_category_ids),
    };
  }

  private setBatch(b: ImportBatch): void {
    const d: Record<number, Decision> = {};
    for (const r of b.rows) d[r.id] = this.defaultDecision(r);
    this.decisions.set(d);
    this.batch.set(b);
  }

  private patch(r: ImportRow, fn: (d: Decision) => Decision): void {
    this.decisions.update((all) => ({ ...all, [r.id]: fn(all[r.id]) }));
  }

  setAction(r: ImportRow, action: Decision['action']): void {
    this.patch(r, (d) => ({ ...d, action, person_id: action === 'use_existing' ? (d.person_id ?? this.personDups(r)[0]?.['person_id']) : d.person_id }));
  }

  setPerson(r: ImportRow, id: number): void {
    this.patch(r, (d) => ({ ...d, person_id: id }));
  }

  toggleCat(r: ImportRow, cid: number): void {
    this.patch(r, (d) => {
      const s = new Set(d.category_ids);
      if (s.has(cid)) s.delete(cid);
      else s.add(cid);
      return { ...d, category_ids: s };
    });
  }

  async confirm(): Promise<void> {
    const b = this.batch();
    if (!b) return;
    const decisions = b.rows
      .filter((r) => r.status !== 'error')
      .map((r) => {
        const d = this.decisions()[r.id];
        return {
          row_id: r.id,
          action: d.action,
          person_id: d.action === 'use_existing' ? d.person_id : null,
          category_ids: [...d.category_ids],
        };
      });
    this.busy.set(true);
    // Confirmar crea personas e inscripciones en una transacción: puede tardar más que una petición normal.
    const res = await this.mut.run<Record<string, unknown>>(
      (override) =>
        this.api.post(`/imports/${b.id}/confirm`, override ? { decisions, override } : { decisions }, undefined, {
          timeoutMs: LONG_TIMEOUT_MS,
        }),
      { success: $localize`:@@torneo.importar.importacion-confirmada-2:Importación confirmada` },
    );
    this.busy.set(false);
    if (res) {
      this.result.set(res);
      this.batch.set(null);
      this.setLote(null);
      this.ctx.loadCategories();
    }
  }

  async cancel(): Promise<void> {
    const b = this.batch();
    if (!b) return;
    const ok = await this.dialog.confirm({ title: $localize`:@@torneo.importar.cancelar-importacion-2:Cancelar importación`, message: $localize`:@@torneo.importar.no-guardara-nada-este-archivo:No se guardará nada de este archivo.`, danger: true, confirmText: $localize`:@@torneo.importar.cancelar-importacion-2:Cancelar importación` });
    if (!ok) return;
    const res = await this.mut.run(() => this.api.post(`/imports/${b.id}/cancel`, {}), { success: $localize`:@@torneo.importar.importacion-cancelada:Importación cancelada` });
    if (res !== undefined) {
      this.batch.set(null);
      this.setLote(null);
    }
  }
}
