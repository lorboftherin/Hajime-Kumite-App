import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiError } from '../../../core/api-error';
import { ApiService } from '../../../core/api.service';
import { DialogService } from '../../../core/dialog.service';
import { FilesService } from '../../../core/files.service';
import { ImportBatch, ImportRow } from '../../../core/models';
import { MutationService } from '../../../core/mutation.service';
import { ToastService } from '../../../core/toast.service';
import { StatusBadge } from '../../../shared/badge';
import { TournamentContext } from '../tournament-context';

interface Decision {
  action: 'create' | 'use_existing' | 'skip';
  person_id: number | null;
  category_ids: Set<number>;
}

@Component({
  selector: 'app-import-tab',
  imports: [FormsModule, StatusBadge],
  template: `
    <div class="card">
      <h3>Importar inscripciones desde Excel</h3>
      <ol class="small steps">
        <li>Descarga la plantilla con columnas fijas y compártela con los dojos.</li>
        <li>Sube el archivo: verás una vista previa fila por fila (nueva, posible duplicado o con error).</li>
        <li>Revisa las decisiones y categorías sugeridas; solo al confirmar se guarda algo.</li>
      </ol>
      <div class="row">
        <button class="btn" (click)="downloadTemplate()">⬇ Descargar plantilla .xlsx</button>
        <label class="btn primary">
          ⬆ Subir archivo
          <input type="file" accept=".xlsx" hidden (change)="upload($event)" />
        </label>
        @if (uploading()) {
          <span class="spinner"></span> <span class="small muted">Procesando…</span>
        }
      </div>
    </div>

    @if (batch(); as b) {
      <div class="card">
        <div class="row">
          <h3 class="grow">Vista previa: {{ b.filename }} <span class="badge">{{ b.status }}</span></h3>
          <span class="badge ok">{{ counts().new }} nuevas</span>
          <span class="badge warn">{{ counts().duplicate }} posibles duplicados</span>
          <span class="badge danger">{{ counts().error }} con error</span>
        </div>
        <div class="table-wrap mt">
          <table class="table">
            <thead>
              <tr>
                <th>Fila</th>
                <th>Persona</th>
                <th>Dojo</th>
                <th>Estado</th>
                <th>Decisión</th>
                <th>Categorías</th>
              </tr>
            </thead>
            <tbody>
              @for (r of b.rows; track r.id) {
                @let d = decisions()[r.id];
                <tr [class.diff]="r.status === 'duplicate'" [class.struck]="d?.action === 'skip'">
                  <td class="mono">{{ r.row_number }}</td>
                  <td>
                    <strong>{{ r.data['apellidos'] }}, {{ r.data['nombres'] }}</strong>
                    <div class="muted small">
                      {{ r.data['sexo'] }} · {{ r.data['fecha_nacimiento'] || 's/f' }} · {{ r.data['grado'] || 's/g' }}
                      @if (r.data['numero_documento']) { · {{ r.data['tipo_documento'] }} {{ r.data['numero_documento'] }} }
                      @if (r.data['categoria_peso']) { · {{ r.data['categoria_peso'] }} kg }
                    </div>
                  </td>
                  <td>
                    {{ r.data['dojo'] }}
                    @if (!r.data['dojo_id'] && r.data['dojo']) {
                      <div class="small muted">(se creará)</div>
                    }
                  </td>
                  <td>
                    <app-status [status]="r.status" type="import" />
                    @for (e of r.errors; track $index) {
                      <div class="error-text">{{ e }}</div>
                    }
                    @for (dup of r.duplicates; track $index) {
                      <div class="small">
                        @if (dup['person_id']) {
                          ≈ {{ dup['full_name'] }} (#{{ dup['person_id'] }}, {{ dup['reason'] }})
                        } @else {
                          ≈ fila {{ dup['row_number'] }} del mismo archivo
                        }
                      </div>
                    }
                  </td>
                  <td>
                    @if (r.status === 'error') {
                      <span class="muted small">Se omite</span>
                    } @else if (d) {
                      <select [ngModel]="d.action" (ngModelChange)="setAction(r, $event)">
                        <option value="create">Crear persona</option>
                        @if (personDups(r).length) {
                          <option value="use_existing">Usar existente</option>
                        }
                        <option value="skip">Omitir</option>
                      </select>
                      @if (d.action === 'use_existing') {
                        <select class="mt-xs" [ngModel]="d.person_id" (ngModelChange)="setPerson(r, $event)">
                          @for (dup of personDups(r); track dup['person_id']) {
                            <option [ngValue]="dup['person_id']">{{ dup['full_name'] }} (#{{ dup['person_id'] }})</option>
                          }
                        </select>
                      }
                    }
                  </td>
                  <td class="small">
                    @if (d && r.status !== 'error') {
                      @for (cid of r.suggested_category_ids; track cid) {
                        <label class="field inline"><input type="checkbox" [checked]="d.category_ids.has(cid)" [disabled]="d.action === 'skip'" (change)="toggleCat(r, cid)" /> {{ catName(cid) }}</label>
                      } @empty {
                        <span class="muted">Sin sugerencias</span>
                      }
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        @if (b.status === 'preview') {
          <div class="form-actions">
            <button class="btn" (click)="cancel()">Cancelar importación</button>
            <button class="btn primary" [disabled]="busy()" (click)="confirm()">Confirmar e inscribir</button>
          </div>
        }
      </div>
    }

    @if (result(); as res) {
      <div class="alert ok import-result">
        <strong>Importación confirmada.</strong>
        <ul>
          @for (kv of resultEntries(); track kv[0]) {
            <li>{{ resultLabel[kv[0]] ?? kv[0] }}: <strong>{{ kv[1] }}</strong></li>
          }
        </ul>
      </div>
    }
  `,
  styles: `
    .steps {
      margin: 0 0 1rem;
      padding-left: 1.2rem;
      color: var(--gray-600);
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
  readonly ctx = inject(TournamentContext);
  private api = inject(ApiService);
  private files = inject(FilesService);
  private mut = inject(MutationService);
  private dialog = inject(DialogService);
  private toast = inject(ToastService);

  readonly resultLabel: Record<string, string | undefined> = {
    created_people: 'Personas creadas',
    registrations: 'Inscripciones creadas',
    skipped: 'Filas omitidas',
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
    } catch (e) {
      this.toast.error(ApiError.from(e).fullMessage);
    } finally {
      this.uploading.set(false);
    }
  }

  private setBatch(b: ImportBatch): void {
    const d: Record<number, Decision> = {};
    for (const r of b.rows) {
      const dups = this.personDups(r);
      d[r.id] = {
        // Un posible duplicado de BD se propone como "usar existente"; el operador decide.
        action: r.status === 'error' ? 'skip' : dups.length ? 'use_existing' : 'create',
        person_id: dups[0]?.['person_id'] ?? null,
        category_ids: new Set(r.suggested_category_ids),
      };
    }
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
    const res = await this.mut.post<Record<string, unknown>>(`/imports/${b.id}/confirm`, { decisions }, { success: 'Importación confirmada' });
    this.busy.set(false);
    if (res) {
      this.result.set(res);
      this.batch.set(null);
      this.ctx.loadCategories();
    }
  }

  async cancel(): Promise<void> {
    const b = this.batch();
    if (!b) return;
    const ok = await this.dialog.confirm({ title: 'Cancelar importación', message: 'No se guardará nada de este archivo.', danger: true, confirmText: 'Cancelar importación' });
    if (!ok) return;
    const res = await this.mut.run(() => this.api.post(`/imports/${b.id}/cancel`, {}), { success: 'Importación cancelada' });
    if (res !== undefined) this.batch.set(null);
  }
}
