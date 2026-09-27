import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiError } from '../../core/api-error';
import { ApiService } from '../../core/api.service';
import { FilesService } from '../../core/files.service';
import { Credential, Tournament } from '../../core/models';
import { Icon } from '../../shared/icon';
import { PageHead } from '../../shared/page-head';

/**
 * Credenciales imprimibles (/torneos/:id/credenciales): vista previa y PDF
 * (8 por hoja A4) con el QR del código de cada persona, para toda la lista o
 * por dojo (se entregan en sobres por dojo).
 */
@Component({
  selector: 'app-credentials-page',
  imports: [FormsModule, RouterLink, Icon, PageHead],
  template: `
    <div class="container">
      <app-page-head
        kanji="証"
        [title]="tituloCredenciales()"
      >
        <a i18n="@@acreditacion.credenciales.acreditacion" back class="back-link" [routerLink]="['/torneos', id(), 'acreditacion']"
          ><app-icon name="back" /> Acreditación</a
        >
        <div meta class="meta-line">
          <span i18n="@@acreditacion.credenciales.n-credenciales">{shown().length, plural, =1 {1 credencial} other {{{ shown().length }} credenciales}}</span>
        </div>
        <button i18n="@@acreditacion.credenciales.abrir-pdf-para-imprimir" class="btn primary" (click)="print()">
          <app-icon name="print" /> Abrir PDF para imprimir
        </button>
      </app-page-head>
      @if (error()) {
        <div class="alert danger">{{ error() }}</div>
      }
      <div class="toolbar no-print">
        <select i18n-aria-label="@@acreditacion.credenciales.dojo" aria-label="Dojo" [ngModel]="dojo()" (ngModelChange)="dojo.set($event)">
          <option i18n="@@acreditacion.credenciales.todos-dojos" [ngValue]="''">Todos los dojos</option>
          @for (d of dojos(); track d) {
            <option [ngValue]="d">{{ d }}</option>
          }
        </select>
        <p i18n="@@acreditacion.credenciales.cada-credencial-lleva-qr-codigo" class="hint grow">
          Cada credencial lleva el QR con el código de la persona: en la mesa de acreditación se
          escanea o se tipea para marcarla presente en todas sus categorías.
        </p>
      </div>
      <div class="grid">
        @for (c of shown(); track c.code ?? c.name) {
          <article class="cred">
            <div class="t muted tiny">{{ tournament()?.name }}</div>
            <strong>{{ c.name }}</strong>
            <span class="muted small">{{ c.dojo_name }}</span>
            <ul>
              @for (cat of c.categories; track cat) {
                <li>{{ cat }}</li>
              }
            </ul>
            <span class="code mono">{{ c.code }}</span>
          </article>
        } @empty {
          <div i18n="@@acreditacion.credenciales.no-hay-inscripciones-activas" class="card empty">No hay inscripciones activas.</div>
        }
      </div>
    </div>
  `,
  styles: `
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: var(--space-3);
    }
    .cred {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
      padding: 0.9rem 1rem;
      border: 1px dashed var(--kasumi-2);
      border-radius: var(--radius-sm);
      background: var(--kinu);
      ul {
        margin: 0.3rem 0;
        padding-left: 1rem;
        font-size: var(--fs-12);
      }
      .code {
        align-self: flex-end;
        font-size: var(--fs-16);
        font-weight: 700;
        letter-spacing: 0.08em;
      }
    }
  `,
})
export class CredentialsPage {
  tituloCredenciales(): string {
    const t = this.tournament();
    return t
      ? $localize`:@@acreditacion.credenciales.titulo-torneo:Credenciales · ${t.name}:torneo:`
      : $localize`:@@acreditacion.credenciales.titulo:Credenciales`;
  }
  private api = inject(ApiService);
  private files = inject(FilesService);
  readonly id = input.required<string>();
  readonly tournament = signal<Tournament | null>(null);
  readonly items = signal<Credential[]>([]);
  readonly error = signal('');
  readonly dojo = signal('');
  readonly dojos = computed(() => [...new Set(this.items().map((c) => c.dojo_name))].sort());
  readonly shown = computed(() =>
    this.items().filter((c) => !this.dojo() || c.dojo_name === this.dojo()),
  );
  private dojoIds = new Map<string, number>();

  constructor() {
    effect(() => {
      const tid = Number(this.id());
      if (tid) this.load(tid);
    });
  }

  private async load(tid: number): Promise<void> {
    try {
      const [t, list, rows] = await Promise.all([
        firstValueFrom(this.api.get<Tournament>(`/tournaments/${tid}`)),
        firstValueFrom(this.api.get<Credential[]>(`/tournaments/${tid}/credentials`)),
        firstValueFrom(
          this.api.get<{ rows: Array<{ dojo_id: number; dojo_name: string }> }>(
            `/tournaments/${tid}/checkin`,
          ),
        ),
      ]);
      this.tournament.set(t);
      this.items.set(list);
      this.dojoIds = new Map(rows.rows.map((r) => [r.dojo_name, r.dojo_id]));
    } catch (e) {
      this.error.set(ApiError.from(e).fullMessage);
    }
  }

  print(): void {
    const dojoId = this.dojo() ? this.dojoIds.get(this.dojo()) : undefined;
    this.files.open(
      `/tournaments/${this.id()}/credentials.pdf`,
      dojoId ? { dojo_id: dojoId } : undefined,
    );
  }
}
