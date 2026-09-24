import { Component, computed, inject, signal } from '@angular/core';
import { JsonPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../../core/api.service';
import { AuditEntry } from '../../../core/models';
import { LimaPipe } from '../../../shared/pipes';
import { TournamentContext } from '../tournament-context';

@Component({
  selector: 'app-audit-tab',
  imports: [FormsModule, JsonPipe, LimaPipe],
  template: `
    <div class="card row">
      <input class="grow" placeholder="Filtrar por entidad, acción, usuario o motivo…" [ngModel]="q()" (ngModelChange)="q.set($event)" />
      <button class="btn sm" (click)="load()">↻ Actualizar</button>
      <span class="muted small">Horas en America/Lima</span>
    </div>
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr><th>Fecha y hora</th><th>Usuario</th><th>Entidad</th><th>Acción</th><th>Motivo</th><th>Cambios</th></tr>
        </thead>
        <tbody>
          @for (a of shown(); track a.id) {
            <tr>
              <td class="nowrap small">{{ a.at | lima }}</td>
              <td>{{ a.user }}</td>
              <td class="mono small">{{ a.entity }} #{{ a.entity_id }}</td>
              <td><span class="badge">{{ a.action }}</span></td>
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
            <tr><td colspan="6" class="empty">Sin registros.</td></tr>
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
