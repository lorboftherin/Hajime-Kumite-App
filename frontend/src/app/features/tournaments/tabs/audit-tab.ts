import { Component, computed, inject, signal } from '@angular/core';
import { JsonPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../../core/api.service';
import { AuditEntry } from '../../../core/models';
import { Icon } from '../../../shared/icon';
import { LimaPipe } from '../../../shared/pipes';
import { TournamentContext } from '../tournament-context';

@Component({
  selector: 'app-audit-tab',
  imports: [FormsModule, JsonPipe, LimaPipe, Icon],
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
              <td class="small"><span class="code">{{ a.entity }}</span> <span class="muted num">#{{ a.entity_id }}</span></td>
              <td><span class="badge plain">{{ a.action }}</span></td>
              <td class="small">{{ a.reason }}</td>
              <td>
                @if (a.before || a.after) {
                  <details>
                    <summary class="small">ver</summary>
                    @if (a.before) {
                      <div class="small muted">Antes</div>
                      <pre class="json">{{ a.before | json }}</pre>
                    }
                    @if (a.after) {
                      <div class="small muted">Después</div>
                      <pre class="json">{{ a.after | json }}</pre>
                    }
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
      [a.entity, a.action, a.user ?? '', a.reason ?? '', a.entity_id].some((x) => x.toLowerCase().includes(q)),
    );
  });

  constructor() {
    this.load();
  }

  load(): void {
    this.api.get<AuditEntry[]>('/audit', { tournament_id: this.ctx.id(), limit: 500 }).subscribe({
      next: (e) => this.entries.set(e),
      error: () => {},
    });
  }
}
