import { Component, inject, signal } from '@angular/core';
import { ApiService } from '../../core/api.service';
import { FORMAT_LABEL, GRADES, MODALITY_LABEL, SEX_LABEL } from '../../core/format';
import { Template } from '../../core/models';
import { PageHead } from '../../shared/page-head';
import { LabelPipe } from '../../shared/pipes';

@Component({
  selector: 'app-template-list',
  imports: [LabelPipe, PageHead],
  template: `
    <div class="container">
      <app-page-head kanji="型" title="Plantillas de categorías">
        <div meta class="meta-line"><span>Conjuntos de categorías listos para copiar a un torneo</span></div>
      </app-page-head>
      <div class="layout">
        <nav class="list" aria-label="Plantillas">
          @for (t of templates(); track t.id) {
            <button class="item" [class.on]="selected()?.id === t.id" [attr.aria-current]="selected()?.id === t.id ? 'true' : null" (click)="selected.set(t)">
              <span class="name">{{ t.name }}</span>
              <span class="muted small num">{{ t.items.length }} categorías · v{{ t.version }}</span>
            </button>
          } @empty {
            <div class="empty">No hay plantillas.</div>
          }
        </nav>
        <section>
          @if (selected(); as t) {
            <div class="detail-head">
              <h2>{{ t.name }}</h2>
              @if (t.description) {
                <p class="muted">{{ t.description }}</p>
              }
            </div>
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr><th>Código</th><th>Nombre</th><th>Modalidad</th><th>Sexo</th><th>Edad</th><th>Grado</th><th>Peso</th><th>Formato</th><th class="right">Duración</th></tr>
                </thead>
                <tbody>
                  @for (i of t.items; track i.id) {
                    <tr>
                      <td><span class="code">{{ i.code }}</span></td>
                      <td class="iname">{{ i.name }}</td>
                      <td>{{ i.modality | label: modality }}</td>
                      <td>{{ i.sex | label: sex }}</td>
                      <td class="nowrap">{{ range(i.age_min, i.age_max) }}</td>
                      <td class="nowrap small">{{ gradeRange(i.grade_min, i.grade_max) }}</td>
                      <td>{{ i.weight_class }}</td>
                      <td class="small">{{ i.format | label: format }}</td>
                      <td class="right nowrap">{{ i.duration_seconds ? i.duration_seconds + ' s' : '' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else {
            <div class="card empty"><p><strong>Selecciona una plantilla.</strong></p></div>
          }
        </section>
      </div>
    </div>
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
