import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../../core/api.service';
import { DialogService } from '../../../core/dialog.service';
import { fmtDateTime, limaInputToIso, utcToLimaInput } from '../../../core/format';
import {
  Dojo,
  DojoAdminRequest,
  Invitation,
  RegistrationDecision,
  RegistrationRequests,
  Tournament,
} from '../../../core/models';
import { MutationService } from '../../../core/mutation.service';
import { ToastService } from '../../../core/toast.service';
import { Icon } from '../../../shared/icon';
import { TournamentContext } from '../tournament-context';

/**
 * Pestaña «Solicitudes» del organizador: abrir la inscripción en línea por dojos, repartir
 * enlaces de invitación y aprobar o rechazar (en lote) lo que envían los senseis.
 */
@Component({
  selector: 'app-requests-tab',
  imports: [FormsModule, Icon],
  template: `
    @if (ctx.tournament(); as t) {
      <div class="cols">
        <section class="card">
          <h3>Inscripción en línea</h3>
          <p class="small muted">
            Los senseis (administradores de dojo) inscriben a sus alumnos con las mismas sugerencias
            y advertencias que ves tú. Sus inscripciones quedan pendientes hasta que las apruebes:
            no entran a las llaves mientras tanto.
          </p>
          <form class="stack" (ngSubmit)="saveSettings(t)">
            <label class="field inline"
              ><input type="checkbox" name="open" [(ngModel)]="open" /> Inscripción en línea
              abierta</label
            >
            <label class="field">
              <span>Cierre (hora de Lima, opcional)</span>
              <input
                type="datetime-local"
                name="closes"
                [(ngModel)]="closesAt"
                [disabled]="!open"
              />
            </label>
            <div class="form-actions">
              <button class="btn primary" [disabled]="busy()">Guardar</button>
            </div>
          </form>
        </section>

        <section class="card">
          <h3>Enlaces de invitación</h3>
          <p class="small muted">
            Un enlace por dojo vincula al sensei como administrador de ese dojo (si el dojo ya tiene
            otro, te llega el pedido aquí). El enlace general sirve para cualquier dojo y siempre
            pide tu aprobación.
          </p>
          <div class="row gen">
            <select [(ngModel)]="invDojo" aria-label="Dojo del enlace">
              <option [ngValue]="null">Enlace general (cualquier dojo)</option>
              @for (d of dojos(); track d.id) {
                <option [ngValue]="d.id">{{ d.name }}</option>
              }
            </select>
            <button class="btn" (click)="createInvitation(t)" [disabled]="busy()">
              <app-icon name="plus" /> Generar enlace
            </button>
          </div>
          <ul class="list-plain invs">
            @for (i of invitations(); track i.id) {
              <li [class.revoked]="i.revoked_at">
                <div class="grow">
                  <strong>{{ i.dojo_name ?? 'General' }}</strong>
                  <span class="muted small">
                    · {{ i.uses }} {{ i.uses === 1 ? 'uso' : 'usos' }}
                    @if (i.revoked_at) {
                      · revocado
                    }
                  </span>
                  @if (!i.revoked_at) {
                    <input
                      readonly
                      [value]="link(i)"
                      (focus)="$any($event.target).select()"
                      [attr.aria-label]="'Enlace de ' + (i.dojo_name ?? 'invitación general')"
                    />
                  }
                </div>
                @if (!i.revoked_at) {
                  <button class="btn sm" (click)="copy(link(i))">Copiar</button>
                  <button class="btn sm ghost" (click)="revoke(i)">Revocar</button>
                }
              </li>
            } @empty {
              <li class="muted small">Aún no hay enlaces.</li>
            }
          </ul>
        </section>
      </div>

      <section class="card">
        <div class="row head">
          <h3 class="grow">
            Inscripciones por aprobar <span class="muted small">{{ regs().length }}</span>
          </h3>
          <button class="btn sm" (click)="toggleAll()" [disabled]="!regs().length">
            {{ allSelected() ? 'Quitar selección' : 'Seleccionar todas' }}
          </button>
          <button
            class="btn sm primary"
            (click)="decide('approve')"
            [disabled]="!selected().size || busy()"
          >
            Aprobar ({{ selected().size }})
          </button>
          <button
            class="btn sm danger"
            (click)="decide('reject')"
            [disabled]="!selected().size || busy()"
          >
            Rechazar…
          </button>
        </div>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th><span class="sr-only">Elegir</span></th>
                <th>Competidor</th>
                <th>Dojo</th>
                <th>Categoría</th>
                <th>Grado</th>
                <th>Peso</th>
                <th>Edad</th>
              </tr>
            </thead>
            <tbody>
              @for (r of regs(); track r.id) {
                <tr>
                  <td>
                    <input
                      type="checkbox"
                      [checked]="selected().has(r.id)"
                      (change)="toggle(r.id)"
                      [attr.aria-label]="'Elegir ' + r.person_name"
                    />
                  </td>
                  <td>
                    <strong>{{ r.person_name }}</strong>
                  </td>
                  <td>{{ r.dojo_name }}</td>
                  <td>{{ r.category_name }}</td>
                  <td>{{ r.grade ?? '—' }}</td>
                  <td>{{ r.weight_class ?? '—' }}</td>
                  <td class="num">{{ r.age_at_reference ?? '—' }}</td>
                </tr>
              } @empty {
                <tr>
                  <td colspan="7" class="muted small">No hay inscripciones pendientes.</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </section>

      @if (adminReqs().length) {
        <section class="card">
          <h3>Pedidos para administrar un dojo</h3>
          <ul class="list-plain invs">
            @for (a of adminReqs(); track a.id) {
              <li>
                <div class="grow">
                  <strong>{{ a.display_name || a.username }}</strong>
                  <span class="muted small">({{ a.username }})</span> pide administrar
                  <strong>{{ a.dojo_name }}</strong>
                  <div class="small muted">
                    {{ when(a.created_at) }}
                    @if (a.current_admins.length) {
                      · Admin actual: {{ a.current_admins.join(', ') }}
                    }
                  </div>
                </div>
                <button class="btn sm primary" (click)="decideAdmin(a, true)">Aprobar</button>
                <button class="btn sm ghost" (click)="decideAdmin(a, false)">Rechazar</button>
              </li>
            }
          </ul>
        </section>
      }
    }
  `,
  styles: `
    .cols {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr));
      gap: 1.25rem;
      margin-bottom: 1.25rem;
    }
    .gen {
      gap: 0.5rem;
      margin-bottom: 0.75rem;
      select {
        flex: 1;
        min-width: 12rem;
      }
    }
    .invs li {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem 0;
      border-bottom: 1px solid var(--kasumi);
      input {
        display: block;
        width: 100%;
        margin-top: 0.3rem;
        font-size: var(--fs-12);
      }
      &.revoked {
        opacity: 0.6;
      }
    }
    .head {
      gap: 0.5rem;
      flex-wrap: wrap;
      align-items: center;
      margin-bottom: 0.5rem;
    }
  `,
})
export class RequestsTab {
  readonly ctx = inject(TournamentContext);
  private api = inject(ApiService);
  private mut = inject(MutationService);
  private dialog = inject(DialogService);
  private toast = inject(ToastService);

  readonly data = signal<RegistrationRequests | null>(null);
  readonly invitations = signal<Invitation[]>([]);
  readonly dojos = signal<Dojo[]>([]);
  readonly selected = signal<Set<number>>(new Set());
  readonly busy = signal(false);
  readonly regs = computed(() => this.data()?.registrations ?? []);
  readonly adminReqs = computed(() => this.data()?.dojo_admin_requests ?? []);
  readonly allSelected = computed(
    () => this.regs().length > 0 && this.selected().size === this.regs().length,
  );

  open = false;
  closesAt = '';
  invDojo: number | null = null;

  constructor() {
    this.api.get<Dojo[]>('/dojos').subscribe({ next: (d) => this.dojos.set(d), error: () => {} });
    effect(() => {
      const t = this.ctx.tournament();
      if (!t) return;
      this.open = !!t.self_registration_open;
      this.closesAt = utcToLimaInput(t.self_registration_closes_at);
    });
    effect(() => {
      if (this.ctx.id()) void this.load();
    });
  }

  async load(): Promise<void> {
    const tid = this.ctx.id();
    try {
      const [data, invs] = await Promise.all([
        firstValueFrom(
          this.api.get<RegistrationRequests>(`/tournaments/${tid}/registration-requests`),
        ),
        firstValueFrom(this.api.get<Invitation[]>(`/tournaments/${tid}/invitations`)),
      ]);
      this.data.set(data);
      this.invitations.set(invs);
      this.ctx.pendingCount.set(data.count);
      const ids = new Set(data.registrations.map((r) => r.id));
      this.selected.update((s) => new Set([...s].filter((id) => ids.has(id))));
    } catch {
      /* sin permiso de organizador: la pestaña queda vacía */
    }
  }

  link(i: Invitation): string {
    return `${location.origin}/invitacion/${i.token}`;
  }
  when(v: string): string {
    return fmtDateTime(v);
  }

  async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.toast.ok('Enlace copiado');
    } catch {
      this.toast.warn('No se pudo copiar: selecciona el enlace y cópialo a mano');
    }
  }

  async saveSettings(t: Tournament): Promise<void> {
    this.busy.set(true);
    const body = { open: this.open, closes_at: this.open ? limaInputToIso(this.closesAt) : null };
    const out = await this.mut.put<Tournament>(`/tournaments/${t.id}/self-registration`, body, {
      success: this.open ? 'Inscripción en línea abierta' : 'Inscripción en línea cerrada',
    });
    this.busy.set(false);
    if (out) this.ctx.tournament.set(out);
  }

  async createInvitation(t: Tournament): Promise<void> {
    this.busy.set(true);
    const inv = await this.mut.post<Invitation>(
      `/tournaments/${t.id}/invitations`,
      { dojo_id: this.invDojo },
      { success: 'Enlace generado' },
    );
    this.busy.set(false);
    if (inv) this.invitations.update((l) => [inv, ...l]);
  }

  async revoke(i: Invitation): Promise<void> {
    const ok = await this.dialog.confirm({
      title: 'Revocar enlace',
      message:
        'El enlace dejará de funcionar. Los senseis que ya lo usaron conservan su acceso al dojo.',
      confirmText: 'Revocar',
      danger: true,
    });
    if (!ok) return;
    await this.mut.run(() => this.api.delete<void>(`/invitations/${i.id}`), {
      success: 'Enlace revocado',
    });
    await this.load();
  }

  toggle(id: number): void {
    this.selected.update((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  toggleAll(): void {
    this.selected.set(this.allSelected() ? new Set() : new Set(this.regs().map((r) => r.id)));
  }

  async decide(action: 'approve' | 'reject'): Promise<void> {
    const ids = [...this.selected()];
    let reason: string | null = null;
    if (action === 'reject') {
      reason = await this.dialog.prompt({
        title: `Rechazar ${ids.length === 1 ? 'la inscripción' : ids.length + ' inscripciones'}`,
        message: 'El sensei verá este motivo.',
        label: 'Motivo',
        minLength: 3,
        confirmText: 'Rechazar',
      });
      if (reason === null) return;
    }
    this.busy.set(true);
    const out = await this.mut.post<RegistrationDecision>(
      `/tournaments/${this.ctx.id()}/registration-requests/decide`,
      { ids, action, reason },
    );
    this.busy.set(false);
    if (!out) return;
    const n = action === 'approve' ? out.approved.length : out.rejected.length;
    if (n)
      this.toast.ok(
        `${n} ${n === 1 ? 'inscripción' : 'inscripciones'} ${action === 'approve' ? 'aprobada' : 'rechazada'}${n === 1 ? '' : 's'}`,
      );
    if (out.skipped.length) {
      const names = new Map(this.regs().map((r) => [r.id, r.person_name]));
      await this.dialog.alert(
        'Algunas no se pudieron aprobar',
        'Revísalas: puedes moverlas a otra categoría o rechazarlas.',
        out.skipped.map((x) => `${names.get(x.id) ?? '#' + x.id}: ${x.reason}`),
      );
    }
    this.selected.set(new Set());
    await this.load();
    await this.ctx.loadCategories();
  }

  async decideAdmin(a: DojoAdminRequest, approve: boolean): Promise<void> {
    const out = await this.mut.post<DojoAdminRequest>(
      `/dojo-admin-requests/${a.id}/decide`,
      { approve },
      {
        success: approve ? 'Ahora administra el dojo' : 'Pedido rechazado',
      },
    );
    if (out) await this.load();
  }
}
