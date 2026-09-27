import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../../core/api.service';
import { AUDIT_ACTION, AUDIT_ENTITY } from '../../../core/format';
import { AuditEntry } from '../../../core/models';
import { Icon } from '../../../shared/icon';
import { LimaPipe } from '../../../shared/pipes';
import { FieldChange, auditChanges, auditValue } from '../organizer-logic';
import { TournamentContext } from '../tournament-context';
import { etiquetas } from '../../../core/i18n/etiquetas';

/** Nombres legibles de los campos más comunes de la auditoría. */
const FIELD_LABEL: Record<string, string> = etiquetas(() => ({
  name: $localize`:@@torneo.auditoria.nombre:Nombre`,
  status: $localize`:@@torneo.auditoria.estado:Estado`,
  version: $localize`:@@torneo.auditoria.version:Versión`,
  winner: $localize`:@@torneo.auditoria.ganador-inscripcion:Ganador (inscripción)`,
  method: $localize`:@@torneo.auditoria.metodo:Método`,
  aka_score: $localize`:@@torneo.auditoria.puntos-aka:Puntos AKA`,
  ao_score: $localize`:@@torneo.auditoria.puntos-ao:Puntos AO`,
  score: $localize`:@@torneo.auditoria.marcador:Marcador`,
  event: $localize`:@@torneo.auditoria.evento:Evento`,
  tatami_id: 'Tatami',
  queue_position: $localize`:@@torneo.auditoria.posicion-cola:Posición en la cola`,
  categories: $localize`:@@torneo.auditoria.categorias-orden:Categorías (en orden)`,
  category_id: $localize`:@@torneo.auditoria.categoria:Categoría`,
  seed: $localize`:@@torneo.auditoria.cabeza-serie:Cabeza de serie`,
  weight_class: $localize`:@@torneo.auditoria.peso:Peso`,
  grade: $localize`:@@torneo.auditoria.grado:Grado`,
  dojo_id: 'Dojo',
  sex: $localize`:@@torneo.auditoria.sexo:Sexo`,
  age_min: $localize`:@@torneo.auditoria.edad-min:Edad mín.`,
  age_max: $localize`:@@torneo.auditoria.edad-max:Edad máx.`,
  grade_min: $localize`:@@torneo.auditoria.grado-min:Grado mín.`,
  grade_max: $localize`:@@torneo.auditoria.grado-max:Grado máx.`,
  format: $localize`:@@torneo.auditoria.formato:Formato`,
  duration_seconds: $localize`:@@torneo.auditoria.duracion-s:Duración (s)`,
  matches: $localize`:@@torneo.auditoria.combates:Combates`,
  waiting: $localize`:@@torneo.auditoria.espera-rival:En espera de rival`,
  device: $localize`:@@torneo.auditoria.tablet:Tablet`,
  first_names: $localize`:@@torneo.auditoria.nombres:Nombres`,
  last_names: $localize`:@@torneo.auditoria.apellidos:Apellidos`,
  birth_date: $localize`:@@torneo.auditoria.fecha-nacimiento:Fecha de nacimiento`,
  start_date: $localize`:@@torneo.auditoria.fecha-inicio:Fecha de inicio`,
  end_date: $localize`:@@torneo.auditoria.fecha-fin:Fecha de fin`,
  venue: $localize`:@@torneo.auditoria.sede:Sede`,
  city: $localize`:@@torneo.auditoria.ciudad:Ciudad`,
  is_test: $localize`:@@torneo.auditoria.prueba:De prueba`,
  public_token: $localize`:@@torneo.auditoria.enlace-publico:Enlace público`,
}));

@Component({
  selector: 'app-audit-tab',
  imports: [FormsModule, LimaPipe, Icon],
  template: `
    <div class="toolbar">
      <div class="search">
        <app-icon name="search" />
        <input
          i18n-aria-label="@@torneo.auditoria.filtrar-auditoria"
          i18n-placeholder="@@torneo.auditoria.filtrar-entidad-accion-usuario"
          placeholder="Filtrar por entidad, acción, usuario o motivo…"
          aria-label="Filtrar auditoría"
          [ngModel]="q()"
          (ngModelChange)="q.set($event)"
        />
      </div>
      <span i18n="@@torneo.auditoria.registros-horas-lima" class="count"
        >{{ shown().length }} registros · horas de Lima</span
      >
      <button
        i18n-aria-label="@@torneo.auditoria.actualizar"
        i18n-title="@@torneo.auditoria.actualizar"
        class="btn icon-only ghost"
        (click)="load()"
        title="Actualizar"
        aria-label="Actualizar"
        ><app-icon name="refresh"
      /></button>
    </div>
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr
            ><th i18n="@@torneo.auditoria.fecha-hora">Fecha y hora</th
            ><th i18n="@@torneo.auditoria.usuario">Usuario</th
            ><th i18n="@@torneo.auditoria.entidad">Entidad</th
            ><th i18n="@@torneo.auditoria.accion">Acción</th
            ><th i18n="@@torneo.auditoria.motivo">Motivo</th
            ><th i18n="@@torneo.auditoria.cambios">Cambios</th></tr
          >
        </thead>
        <tbody>
          @for (a of shown(); track a.id) {
            <tr>
              <td class="nowrap small num">{{ a.at | lima }}</td>
              <td>{{ a.user }}</td>
              <td class="small nowrap"
                >{{ entityLabel(a.entity) }} <span class="muted num">#{{ a.entity_id }}</span></td
              >
              <td
                ><span class="badge plain" [attr.title]="a.action">{{
                  actionLabel(a.action)
                }}</span></td
              >
              <td class="small">{{ a.reason }}</td>
              <td>
                @let ch = changes(a);
                @if (ch.length) {
                  <details>
                    <summary i18n="@@torneo.auditoria.n-cambios" class="small">{ch.length, plural,
                      =1 {1 cambio}
                      other {{{ ch.length }} cambios}
                    }</summary>
                    <table class="diff">
                      <thead
                        ><tr
                          ><th i18n="@@torneo.auditoria.campo">Campo</th
                          ><th i18n="@@torneo.auditoria.antes">Antes</th
                          ><th i18n="@@torneo.auditoria.despues">Después</th></tr
                        ></thead
                      >
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
            <tr
              ><td colspan="6" class="empty"
                ><p><strong i18n="@@torneo.auditoria.sin-registros">Sin registros.</strong></p
                ><ng-container i18n="@@torneo.auditoria.cada-cambio-importante-quedara"
                  >Cada cambio importante quedará anotado aquí.</ng-container
                ></td
              ></tr
            >
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
      [
        a.entity,
        a.action,
        this.entityLabel(a.entity),
        this.actionLabel(a.action),
        a.user ?? '',
        a.reason ?? '',
        a.entity_id,
      ].some((x) => String(x).toLowerCase().includes(q)),
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
