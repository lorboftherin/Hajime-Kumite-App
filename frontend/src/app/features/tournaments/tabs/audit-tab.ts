import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../../core/api.service';
import { AUDIT_ACTION, AUDIT_ENTITY } from '../../../core/format';
import { AuditEntry } from '../../../core/models';
import { Icon } from '../../../shared/icon';
import { LimaPipe } from '../../../shared/pipes';
import { FieldChange, auditChanges, auditValue } from '../organizer-logic';
import { TournamentContext } from '../tournament-context';

/** Nombres legibles de los campos más comunes de la auditoría. */
const FIELD_LABEL: Record<string, string> = {
  name: 'Nombre',
  status: 'Estado',
  version: 'Versión',
  winner: 'Ganador (inscripción)',
  method: 'Método',
  aka_score: 'Puntos AKA',
  ao_score: 'Puntos AO',
  score: 'Marcador',
  event: 'Evento',
  tatami_id: 'Tatami',
  queue_position: 'Posición en la cola',
  categories: 'Categorías (en orden)',
  category_id: 'Categoría',
  seed: 'Cabeza de serie',
  weight_class: 'Peso',
  grade: 'Grado',
  dojo_id: 'Dojo',
  sex: 'Sexo',
  age_min: 'Edad mín.',
  age_max: 'Edad máx.',
  grade_min: 'Grado mín.',
  grade_max: 'Grado máx.',
  format: 'Formato',
  duration_seconds: 'Duración (s)',
  matches: 'Combates',
  waiting: 'En espera de rival',
  device: 'Tablet',
  first_names: 'Nombres',
  last_names: 'Apellidos',
  birth_date: 'Fecha de nacimiento',
  start_date: 'Fecha de inicio',
  end_date: 'Fecha de fin',
  venue: 'Sede',
  city: 'Ciudad',
  is_test: 'De prueba',
  public_token: 'Enlace público',
};

@Component({
  selector: 'app-audit-tab',
  imports: [FormsModule, LimaPipe, Icon],
  template: `
    <div class="toolbar">
      <div class="search">
        <app-icon name="search" />
        <input placeholder="Filtrar por entidad, acción, usuario o motivo…" aria-label="Filtrar auditoría" [ngModel]="q()" (ngModelChange)="q.set($event)" />
      </div>
      <span class="count">{{ shown().length }} registros · horas de Lima</span>
      <button class="btn icon-only ghost" (click)="load()" title="Actualizar" aria-label="Actualizar"><app-icon name="refresh" /></button>
    </div>
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr><th>Fecha y hora</th><th>Usuario</th><th>Entidad</th><th>Acción</th><th>Motivo</th><th>Cambios</th></tr>
        </thead>
        <tbody>
          @for (a of shown(); track a.id) {
            <tr>
              <td class="nowrap small num">{{ a.at | lima }}</td>
              <td>{{ a.user }}</td>
              <td class="small nowrap">{{ entityLabel(a.entity) }} <span class="muted num">#{{ a.entity_id }}</span></td>
              <td><span class="badge plain" [attr.title]="a.action">{{ actionLabel(a.action) }}</span></td>
              <td class="small">{{ a.reason }}</td>
              <td>
                @let ch = changes(a);
                @if (ch.length) {
                  <details>
                    <summary class="small">{{ ch.length === 1 ? '1 cambio' : ch.length + ' cambios' }}</summary>
                    <table class="diff">
                      <thead><tr><th>Campo</th><th>Antes</th><th>Después</th></tr></thead>
                      <tbody>
                        @for (c of ch; track c.field) {
                          <tr>
                            <th scope="row">{{ fieldLabel(c.field) }}</th>
                            <td class="old">{{ value(c.before) }}</td>
                            <td class="new">{{ value(c.after) }}</td>
                          </tr>
                        }
                      </tbody>
                    </table>
                  </details>
                }
              </td>
            </tr>
          } @empty {
            <tr><td colspan="6" class="empty"><p><strong>Sin registros.</strong></p>Cada cambio importante quedará anotado aquí.</td></tr>
          }
        </tbody>
      </table>
    </div>
  `,
  styles: `
    .diff {
      margin-top: 0.35rem;
      border-collapse: collapse;
      font-size: var(--fs-12);
      th,
      td {
        padding: 0.2rem 0.5rem;
        border-bottom: 1px solid var(--kasumi);
        text-align: left;
        vertical-align: top;
        overflow-wrap: anywhere;
      }
      thead th {
        color: var(--nezumi-ink);
        font-weight: 500;
      }
      tbody th {
        font-weight: 700;
        white-space: nowrap;
      }
      .old {
        color: var(--nezumi-ink);
        text-decoration: line-through;
        text-decoration-color: color-mix(in srgb, var(--shu) 60%, transparent);
      }
      .new {
        color: var(--sumi);
      }
    }
  `,
})
export class AuditTab {
  readonly ctx = inject(TournamentContext);
  private api = inject(ApiService);
  readonly entries = signal<AuditEntry[]>([]);
  readonly q = signal('');
  readonly shown = computed(() => {
    const q = this.q().trim().toLowerCase();
    if (!q) return this.entries();
    return this.entries().filter((a) =>
      [a.entity, a.action, this.entityLabel(a.entity), this.actionLabel(a.action), a.user ?? '', a.reason ?? '', a.entity_id].some(
        (x) => String(x).toLowerCase().includes(q),
      ),
    );
  });

  constructor() {
    this.load();
  }

  changes(a: AuditEntry): FieldChange[] {
    return auditChanges(
      a.before as Record<string, unknown> | null,
      a.after as Record<string, unknown> | null,
    );
  }

  fieldLabel(f: string): string {
    return FIELD_LABEL[f] ?? f.replace(/_/g, ' ');
  }

  value(v: unknown): string {
    return auditValue(v);
  }

  actionLabel(code: string): string {
    return AUDIT_ACTION[code] ?? code;
  }

  entityLabel(code: string): string {
    return AUDIT_ENTITY[code] ?? code;
  }

  load(): void {
    this.api.get<AuditEntry[]>('/audit', { tournament_id: this.ctx.id(), limit: 500 }).subscribe({
      next: (e) => this.entries.set(e),
      error: () => {},
    });
  }
}
