import { Component, inject, signal } from '@angular/core';
import { ApiService } from '../../core/api.service';
import { FORMAT_LABEL, GRADES, MODALITY_LABEL, SEX_LABEL } from '../../core/format';
import { Template } from '../../core/models';
import { LabelPipe } from '../../shared/pipes';

@Component({
  selector: 'app-template-list',
  imports: [LabelPipe],
  template: `
    <div class="container">
      <div class="page-header"><h1>Plantillas de categorías</h1></div>
      <div class="layout">
        <aside class="card list">
          @for (t of templates(); track t.id) {
            <button class="item" [class.on]="selected()?.id === t.id" (click)="selected.set(t)">
              <strong>{{ t.name }}</strong>
              <span class="muted small">{{ t.items.length }} categorías · v{{ t.version }}</span>
            </button>
          } @empty {
            <div class="empty">No hay plantillas.</div>
          }
        </aside>
        <section>
          @if (selected(); as t) {
            <div class="card">
              <h2>{{ t.name }}</h2>
              <p class="muted">{{ t.description }}</p>
            </div>
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr><th>Código</th><th>Nombre</th><th>Modalidad</th><th>Sexo</th><th>Edad</th><th>Grado</th><th>Peso</th><th>Formato</th><th>Duración</th></tr>
                </thead>
                <tbody>
                  @for (i of t.items; track i.id) {
                    <tr>
                      <td class="mono small">{{ i.code }}</td>
                      <td>{{ i.name }}</td>
                      <td>{{ i.modality | label: modality }}</td>
                      <td>{{ i.sex | label: sex }}</td>
                      <td class="nowrap">{{ range(i.age_min, i.age_max) }}</td>
                      <td class="nowrap small">{{ gradeRange(i.grade_min, i.grade_max) }}</td>
                      <td>{{ i.weight_class }}</td>
                      <td class="small">{{ i.format | label: format }}</td>
                      <td>{{ i.duration_seconds ? i.duration_seconds + ' s' : '' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else {
            <div class="card empty">Selecciona una plantilla.</div>
          }
        </section>
      </div>
    </div>
  `,
  styles: `
    .layout {
      display: grid;
      grid-template-columns: 280px minmax(0, 1fr);
      gap: 1rem;
      align-items: start;
    }
    @media (max-width: 800px) {
      .layout {
        grid-template-columns: 1fr;
      }
    }
    .list {
      padding: 0.35rem;
    }
    .item {
      all: unset;
      display: flex;
      flex-direction: column;
      padding: 0.6rem 0.75rem;
      border-radius: var(--radius-sm);
      cursor: pointer;
      width: 100%;
      box-sizing: border-box;
      &:hover {
        background: var(--gray-100);
      }
      &.on {
        background: var(--info-soft);
      }
    }
  `,
})
export class TemplateListPage {
  private api = inject(ApiService);
  readonly templates = signal<Template[]>([]);
  readonly selected = signal<Template | null>(null);
  readonly modality = MODALITY_LABEL;
  readonly sex = SEX_LABEL;
  readonly format = FORMAT_LABEL;

  constructor() {
    this.api.get<Template[]>('/templates').subscribe({
      next: (t) => {
        this.templates.set(t);
        if (t.length) this.selected.set(t[0]);
      },
      error: () => {},
    });
  }

  range(a: number | null, b: number | null): string {
    if (a === null && b === null) return 'Libre';
    if (b === null) return `${a}+`;
    if (a === null) return `≤ ${b}`;
    return `${a}–${b}`;
  }

  gradeRange(a: number | null, b: number | null): string {
    const g = (o: number | null) => (o === null ? null : GRADES[o - 1] ?? String(o));
    if (a === null && b === null) return 'Todos';
    if (b === null) return `${g(a)} en adelante`;
    if (a === null) return `hasta ${g(b)}`;
    return `${g(a)} – ${g(b)}`;
  }
}
