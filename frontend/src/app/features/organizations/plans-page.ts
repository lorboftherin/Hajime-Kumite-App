import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { Plan, PlansOut } from '../../core/models';
import { PageHead } from '../../shared/page-head';

/** Qué incluye cada nivel (docs/modelo-negocio.md). El servidor decide los derechos reales. */
const INCLUDES: Record<string, string> = {
  publico:
    'Torneos, llaves, resultados, medallero por dojo, seguimiento en vivo y perfil básico del competidor.',
  competidor:
    'Todo lo necesario del propio perfil (o del hijo o hija): historial completo, hoja de cada combate, medallas, grados, estadísticas básicas, insignias y avisos.',
  competidor_plus:
    'Análisis adicional: evolución por temporada, técnicas, índice Hajime y su tendencia, comparación con rivales (datos públicos) y certificados descargables.',
  dojo: 'Administrar el dojo y sus competidores, inscribir alumnos y organizar torneos: inscripciones, Excel, llaves, mesa, varios tatamis, árbitros, reportes, Shadow Mode y overlay en vivo.',
  organizador: 'Lo mismo que Dojo, pensado para ligas y organizadores que no son un dojo.',
};
const AUDIENCE: Record<string, string> = {
  all: 'Cualquiera',
  person: 'Competidores, padres o apoderados',
  organization: 'Dojos, ligas y organizadores',
};

/** Página «Planes»: niveles, precios (provisionales) y el modo de cobro vigente. */
@Component({
  selector: 'app-plans-page',
  imports: [RouterLink, PageHead],
  template: `
    <div class="container">
      <app-page-head kanji="料金" title="Planes">
        <div meta class="meta-line">
          <span>Gratis lo necesario; membresía para dojos y organizadores</span>
        </div>
      </app-page-head>

      @if (data(); as d) {
        @if (d.mode === 'marcha_blanca') {
          <div class="alert ok">
            <strong>Marcha blanca:</strong> durante las pruebas todo es gratis para cualquier
            cuenta. Los niveles ya existen y se activarán en el lanzamiento.
          </div>
        } @else {
          <div class="alert info">
            Los planes están activos. Para contratar o renovar la membresía de tu organización,
            escríbenos: por ahora el pago se coordina con el equipo de Hajime y el administrador lo
            activa. Tu plan actual está en
            <a routerLink="/organizacion">Organización</a>.
          </div>
        }

        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>Nivel</th>
                <th>Para quién</th>
                <th class="right">Mensual</th>
                <th class="right">Anual</th>
                <th>Qué incluye</th>
              </tr>
            </thead>
            <tbody>
              @for (p of visible(); track p.code) {
                <tr>
                  <td>
                    <strong>{{ p.name }}</strong>
                  </td>
                  <td class="small">{{ audience(p) }}</td>
                  <td class="right nowrap num">{{ price(p.price_pen_month) }}</td>
                  <td class="right nowrap num">{{ price(p.price_pen_year) }}</td>
                  <td class="small">
                    {{ includes(p) }}
                    @if (p.features.length) {
                      <div class="features">
                        @for (f of p.features; track f) {
                          <span class="badge plain">{{ featureName(d, f) }}</span>
                        }
                      </div>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        <p class="small muted note">
          Precios en soles (S/), <strong>provisionales</strong>: pueden cambiar antes del
          lanzamiento. Los resultados siguen siendo públicos y gratuitos: pagar da herramientas de
          gestión o análisis adicional, nunca ocultar o cambiar resultados.
        </p>
      } @else if (error()) {
        <div class="alert danger">{{ error() }}</div>
      } @else {
        <div class="empty"><span class="spinner"></span></div>
      }
    </div>
  `,
  styles: `
    .features {
      display: flex;
      flex-wrap: wrap;
      gap: 0.3rem;
      margin-top: 0.4rem;
    }
    .note {
      margin-top: 1rem;
      max-width: 60rem;
    }
  `,
})
export class PlansPage {
  private api = inject(ApiService);
  readonly data = signal<PlansOut | null>(null);
  readonly error = signal('');
  /** La marcha blanca es un modo, no un nivel que se contrate. */
  readonly visible = computed(() =>
    (this.data()?.plans ?? []).filter((p) => p.code !== 'marcha_blanca'),
  );

  constructor() {
    this.api.get<PlansOut>('/plans').subscribe({
      next: (d) => this.data.set(d),
      error: (e) => this.error.set(e?.message ?? 'No se pudieron cargar los planes'),
    });
  }

  price(v: number | null): string {
    if (v === null || v === undefined) return '—';
    if (!v) return 'Gratis';
    return (
      'S/ ' +
      v.toLocaleString('es-PE', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 })
    );
  }
  featureName(d: PlansOut, f: string): string {
    return d.features[f] || f;
  }
  includes(p: Plan): string {
    return INCLUDES[p.code] ?? '';
  }
  audience(p: Plan): string {
    return AUDIENCE[p.audience] ?? p.audience;
  }
}
