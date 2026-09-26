import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { DialogService } from '../../core/dialog.service';
import { fmtDate, ORG_KIND_LABEL, ORG_ROLE_LABEL, SUBSCRIPTION_STATUS } from '../../core/format';
import { Organization, OrgMember, OrgRole, PlansOut, Subscription } from '../../core/models';
import { MutationService } from '../../core/mutation.service';
import { Icon } from '../../shared/icon';
import { Modal } from '../../shared/modal';
import { PageHead } from '../../shared/page-head';

/**
 * Página «Organización»: datos, miembros y plan actual. El dueño (owner) o un administrador
 * editan; el Admin Global crea organizaciones y asigna suscripciones manuales.
 */
@Component({
  selector: 'app-organization-page',
  imports: [FormsModule, RouterLink, PageHead, Icon, Modal],
  template: `
    <div class="container">
      <app-page-head kanji="組" [title]="org()?.name ?? 'Organización'">
        <div meta class="meta-line">
          @if (org(); as o) {
            <span>{{ kindLabel(o.kind) }}</span>
            @if (o.my_role) {
              <span class="badge plain">{{ roleLabel(o.my_role) }}</span>
            }
            <span class="small"
              >{{ o.tournament_count }} {{ o.tournament_count === 1 ? 'torneo' : 'torneos' }}</span
            >
          }
        </div>
        @if (orgs().length > 1) {
          <label class="field inline small">
            <span class="sr-only">Organización</span>
            <select
              [ngModel]="org()?.id"
              (ngModelChange)="go($event)"
              aria-label="Elegir organización"
            >
              @for (o of orgs(); track o.id) {
                <option [ngValue]="o.id">{{ o.name }}</option>
              }
            </select>
          </label>
        }
        @if (auth.isAdmin()) {
          <button class="btn primary" (click)="openNew()">
            <app-icon name="plus" /> Nueva organización
          </button>
        }
      </app-page-head>

      @if (loading()) {
        <div class="empty"><span class="spinner"></span></div>
      } @else if (!org()) {
        <div class="card empty">
          <p><strong>No perteneces a ninguna organización.</strong></p>
          Pide al dueño de tu liga, club o dojo que te invite con tu nombre de usuario.
        </div>
      } @else {
        @let o = org()!;
        <div class="layout">
          <section class="card" aria-labelledby="h-datos">
            <h2 id="h-datos">Datos</h2>
            <form class="stack" (ngSubmit)="save()">
              <div class="grid-2">
                <label class="field"
                  ><span>Nombre *</span
                  ><input
                    name="n"
                    [(ngModel)]="f.name"
                    [disabled]="!o.can_manage"
                    required
                    minlength="2"
                /></label>
                <label class="field"
                  ><span>Identificador (slug)</span
                  ><input name="s" [(ngModel)]="f.slug" [disabled]="!o.can_manage"
                /></label>
                <label class="field">
                  <span>Tipo</span>
                  <select name="k" [(ngModel)]="f.kind" [disabled]="!o.can_manage">
                    <option value="league">Liga</option>
                    <option value="dojo">Dojo</option>
                    <option value="organizer">Organizador</option>
                  </select>
                </label>
                <label class="field"
                  ><span>Logo (ruta o URL)</span
                  ><input
                    name="l"
                    [(ngModel)]="f.logo"
                    [disabled]="!o.can_manage"
                    placeholder="https://…"
                /></label>
                <label class="field"
                  ><span>País</span
                  ><input name="c" [(ngModel)]="f.country" maxlength="2" [disabled]="!o.can_manage"
                /></label>
                <label class="field"
                  ><span>Zona horaria</span
                  ><input name="tz" [(ngModel)]="f.timezone" [disabled]="!o.can_manage"
                /></label>
                <label class="field"
                  ><span>Moneda</span
                  ><input
                    name="cu"
                    [(ngModel)]="f.currency"
                    maxlength="3"
                    [disabled]="!o.can_manage"
                /></label>
              </div>
              @if (o.can_manage) {
                <div class="form-actions">
                  <button class="btn primary" [disabled]="f.name.trim().length < 2 || busy()">
                    Guardar
                  </button>
                </div>
              }
            </form>
          </section>

          <section class="card" aria-labelledby="h-plan">
            <h2 id="h-plan">Plan actual</h2>
            @if (plans()?.mode === 'marcha_blanca') {
              <p class="alert ok small">
                Marcha blanca: todo está disponible sin costo mientras dure la etapa de pruebas.
              </p>
            }
            @if (o.subscription; as sub) {
              <p>
                <strong>{{ sub.plan_name }}</strong> · {{ statusLabel(sub.status) }}
                @if (sub.current_period_end) {
                  · vigente hasta el {{ date(sub.current_period_end) }}
                }
              </p>
            } @else {
              <p class="muted">Sin suscripción vigente.</p>
            }
            <div class="features">
              @for (feat of o.features; track feat) {
                <span class="badge matcha">{{ plans()?.features?.[feat] ?? feat }}</span>
              } @empty {
                <span class="muted small">Ninguna función de pago disponible.</span>
              }
            </div>
            <p><a routerLink="/planes">Ver planes y precios</a></p>

            @if (auth.isAdmin()) {
              <h3>Suscripciones (Admin)</h3>
              <form class="row assign" (ngSubmit)="assign()">
                <select name="pc" [(ngModel)]="sub.plan_code" aria-label="Plan">
                  @for (p of orgPlans(); track p.code) {
                    <option [value]="p.code">{{ p.name }}</option>
                  }
                </select>
                <select name="st" [(ngModel)]="sub.status" aria-label="Estado">
                  <option value="active">Activa</option>
                  <option value="trial">Prueba</option>
                </select>
                <input
                  type="date"
                  name="pe"
                  [(ngModel)]="sub.period_end"
                  aria-label="Vigente hasta"
                  title="Vigente hasta (vacío = sin vencimiento)"
                />
                <button class="btn" [disabled]="busy()">Asignar plan</button>
              </form>
              <div class="table-wrap">
                <table class="table">
                  <thead>
                    <tr>
                      <th>Plan</th>
                      <th>Estado</th>
                      <th>Hasta</th>
                      <th>Origen</th>
                      <th><span class="sr-only">Acciones</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (s of subscriptions(); track s.id) {
                      <tr>
                        <td>
                          {{ s.plan_name }}
                          @if (s.is_current) {
                            <span class="badge matcha">Vigente</span>
                          }
                        </td>
                        <td>{{ statusLabel(s.status) }}</td>
                        <td class="nowrap">
                          {{ s.current_period_end ? date(s.current_period_end) : '—' }}
                        </td>
                        <td class="small">
                          {{ s.source === 'manual' ? 'Manual' : 'Pago' }}
                          @if (s.reference) {
                            · {{ s.reference }}
                          }
                        </td>
                        <td class="right nowrap">
                          @if (s.status !== 'canceled') {
                            <button class="btn sm" (click)="markPaid(s, 'month')">
                              Pagado 1 mes
                            </button>
                            <button class="btn sm" (click)="markPaid(s, 'year')">
                              Pagado 1 año
                            </button>
                            <button class="btn sm ghost" (click)="cancelSub(s)">Cancelar</button>
                          }
                        </td>
                      </tr>
                    } @empty {
                      <tr>
                        <td colspan="5" class="muted small">Sin suscripciones.</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          </section>

          <section class="card wide" aria-labelledby="h-miembros">
            <h2 id="h-miembros">Miembros</h2>
            <p class="small muted">
              Dueño y administrador gestionan la organización y todos sus torneos; un miembro solo
              los consulta.
            </p>
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr>
                    <th>Usuario</th>
                    <th>Nombre</th>
                    <th>Rol</th>
                    <th><span class="sr-only">Acciones</span></th>
                  </tr>
                </thead>
                <tbody>
                  @for (m of members(); track m.user_id) {
                    <tr>
                      <td>
                        <span class="code">{{ m.username }}</span>
                      </td>
                      <td>{{ m.display_name }}</td>
                      <td>
                        @if (o.can_manage) {
                          <select
                            [ngModel]="m.role"
                            (ngModelChange)="changeRole(m, $event)"
                            [attr.aria-label]="'Rol de ' + m.username"
                          >
                            <option value="owner">Dueño</option>
                            <option value="admin">Administrador</option>
                            <option value="member">Miembro</option>
                          </select>
                        } @else {
                          {{ roleLabel(m.role) }}
                        }
                      </td>
                      <td class="right">
                        @if (o.can_manage) {
                          <button class="btn sm ghost" (click)="remove(m)">Quitar</button>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            @if (o.can_manage) {
              <form class="row invite" (ngSubmit)="invite()">
                <input
                  name="u"
                  [(ngModel)]="inv.username"
                  placeholder="Usuario existente"
                  aria-label="Usuario a invitar"
                />
                <select name="r" [(ngModel)]="inv.role" aria-label="Rol">
                  <option value="member">Miembro</option>
                  <option value="admin">Administrador</option>
                  <option value="owner">Dueño</option>
                </select>
                <button class="btn" [disabled]="!inv.username.trim() || busy()">
                  <app-icon name="plus" /> Invitar
                </button>
              </form>
            }
          </section>
        </div>
      }
    </div>

    @if (showNew()) {
      <app-modal title="Nueva organización" (closed)="showNew.set(false)">
        <form class="stack" (ngSubmit)="create()">
          <label class="field"
            ><span>Nombre *</span><input name="n" [(ngModel)]="nf.name" required minlength="2"
          /></label>
          <div class="grid-2">
            <label class="field">
              <span>Tipo</span>
              <select name="k" [(ngModel)]="nf.kind">
                <option value="league">Liga</option>
                <option value="dojo">Dojo</option>
                <option value="organizer">Organizador</option>
              </select>
            </label>
            <label class="field"
              ><span>Identificador (opcional)</span
              ><input name="s" [(ngModel)]="nf.slug" placeholder="liga-de-lima"
            /></label>
          </div>
          <p class="small muted">Luego invita al dueño desde «Miembros» con su usuario.</p>
          <div class="form-actions">
            <button type="button" class="btn" (click)="showNew.set(false)">Cancelar</button>
            <button class="btn primary" [disabled]="nf.name.trim().length < 2 || busy()">
              Crear
            </button>
          </div>
        </form>
      </app-modal>
    }
  `,
  styles: `
    .layout {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr));
      gap: 1.25rem;
      align-items: start;
    }
    .wide {
      grid-column: 1 / -1;
    }
    .card h2 {
      margin-bottom: 0.75rem;
      font-size: var(--fs-20);
    }
    .card h3 {
      margin: 1.25rem 0 0.5rem;
      font-size: var(--fs-16);
    }
    .features {
      display: flex;
      flex-wrap: wrap;
      gap: 0.35rem;
      margin: 0.5rem 0 0.75rem;
    }
    .invite,
    .assign {
      margin-top: 0.75rem;
      gap: 0.5rem;
      flex-wrap: wrap;
      input {
        min-width: 12rem;
      }
    }
  `,
})
export class OrganizationPage {
  private api = inject(ApiService);
  private mut = inject(MutationService);
  private dialog = inject(DialogService);
  private router = inject(Router);
  readonly auth = inject(AuthService);

  /** Id de la ruta /organizacion/:id (opcional). */
  readonly id = input<string>();
  readonly orgs = signal<Organization[]>([]);
  readonly org = signal<Organization | null>(null);
  readonly members = signal<OrgMember[]>([]);
  readonly subscriptions = signal<Subscription[]>([]);
  readonly plans = signal<PlansOut | null>(null);
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly showNew = signal(false);
  readonly orgPlans = computed(() =>
    (this.plans()?.plans ?? []).filter((p) => p.audience !== 'person'),
  );

  f = {
    name: '',
    slug: '',
    kind: 'organizer',
    logo: '',
    country: 'PE',
    timezone: 'America/Lima',
    currency: 'PEN',
  };
  inv = { username: '', role: 'member' as OrgRole };
  sub = { plan_code: 'dojo', status: 'active', period_end: '' };
  nf = { name: '', kind: 'league', slug: '' };

  constructor() {
    this.api.get<PlansOut>('/plans').subscribe({ next: (p) => this.plans.set(p), error: () => {} });
    effect(() => {
      const wanted = Number(this.id() ?? 0) || null;
      void this.load(wanted);
    });
  }

  kindLabel(k: string): string {
    return ORG_KIND_LABEL[k] ?? k;
  }
  roleLabel(r: string): string {
    return ORG_ROLE_LABEL[r] ?? r;
  }
  statusLabel(s: string): string {
    return SUBSCRIPTION_STATUS[s] ?? s;
  }
  date(v: string): string {
    return fmtDate(v.slice(0, 10));
  }

  go(id: number): void {
    this.router.navigate(['/organizacion', id]);
  }

  async load(wanted: number | null): Promise<void> {
    this.loading.set(true);
    try {
      const list = await firstValueFrom(this.api.get<Organization[]>('/organizations'));
      this.orgs.set(list);
      const o = list.find((x) => x.id === wanted) ?? list[0] ?? null;
      this.setOrg(o);
      if (o) await this.loadDetails(o.id);
    } catch {
      this.org.set(null);
    }
    this.loading.set(false);
  }

  private setOrg(o: Organization | null): void {
    this.org.set(o);
    if (o) {
      this.f = {
        name: o.name,
        slug: o.slug,
        kind: o.kind,
        logo: o.logo ?? '',
        country: o.country,
        timezone: o.timezone,
        currency: o.currency,
      };
    }
  }

  private async loadDetails(oid: number): Promise<void> {
    this.members.set(
      await firstValueFrom(this.api.get<OrgMember[]>(`/organizations/${oid}/members`)).catch(
        () => [],
      ),
    );
    if (this.auth.isAdmin()) {
      this.subscriptions.set(
        await firstValueFrom(
          this.api.get<Subscription[]>(`/organizations/${oid}/subscriptions`),
        ).catch(() => []),
      );
    }
  }

  private async refreshOrg(): Promise<void> {
    const o = this.org();
    if (!o) return;
    const fresh = await firstValueFrom(this.api.get<Organization>(`/organizations/${o.id}`)).catch(
      () => null,
    );
    if (fresh) {
      this.setOrg(fresh);
      this.orgs.update((l) => l.map((x) => (x.id === fresh.id ? fresh : x)));
    }
    await this.loadDetails(o.id);
  }

  async save(): Promise<void> {
    const o = this.org();
    if (!o) return;
    this.busy.set(true);
    const body = {
      ...this.f,
      version: o.version,
      logo: this.f.logo.trim() || null,
      slug: this.f.slug.trim() || null,
    };
    const out = await this.mut.patch<Organization>(`/organizations/${o.id}`, body, {
      success: 'Organización guardada',
      onConflict: () => void this.refreshOrg(),
    });
    this.busy.set(false);
    if (out) {
      this.setOrg(out);
      this.auth.refreshMe();
    }
  }

  async invite(): Promise<void> {
    const o = this.org();
    if (!o) return;
    this.busy.set(true);
    const out = await this.mut.post<OrgMember[]>(
      `/organizations/${o.id}/members`,
      { username: this.inv.username.trim(), role: this.inv.role },
      { success: 'Miembro agregado' },
    );
    this.busy.set(false);
    if (out) {
      this.members.set(out);
      this.inv = { username: '', role: 'member' };
    }
  }

  async changeRole(m: OrgMember, role: OrgRole): Promise<void> {
    const o = this.org();
    if (!o || role === m.role) return;
    const out = await this.mut.patch<OrgMember[]>(
      `/organizations/${o.id}/members/${m.user_id}`,
      { role },
      { success: 'Rol actualizado' },
    );
    this.members.set(out ?? [...this.members()]);
  }

  async remove(m: OrgMember): Promise<void> {
    const o = this.org();
    if (!o) return;
    const ok = await this.dialog.confirm({
      title: 'Quitar miembro',
      message: `${m.display_name || m.username} dejará de ver y administrar los torneos de ${o.name}.`,
      confirmText: 'Quitar',
      danger: true,
    });
    if (!ok) return;
    const out = await this.mut.run(
      () => this.api.delete<OrgMember[]>(`/organizations/${o.id}/members/${m.user_id}`),
      { success: 'Miembro quitado' },
    );
    if (out) this.members.set(out);
  }

  async assign(): Promise<void> {
    const o = this.org();
    if (!o) return;
    this.busy.set(true);
    const body = {
      organization_id: o.id,
      plan_code: this.sub.plan_code,
      status: this.sub.status,
      current_period_end: this.sub.period_end ? `${this.sub.period_end}T23:59:59-05:00` : null,
    };
    const out = await this.mut.post<Subscription>('/subscriptions', body, {
      success: 'Plan asignado',
    });
    this.busy.set(false);
    if (out) await this.refreshOrg();
  }

  async markPaid(s: Subscription, period: 'month' | 'year'): Promise<void> {
    const reference = await this.dialog.prompt({
      title: 'Confirmar pago',
      message: `La suscripción ${s.plan_name} quedará activa ${period === 'year' ? 'un año' : 'un mes'} más.`,
      label: 'Referencia del pago (operación, Yape…)',
      minLength: 0,
      confirmText: 'Marcar pagado',
    });
    if (reference === null) return;
    const out = await this.mut.post<Subscription>(
      `/subscriptions/${s.id}/mark-paid`,
      { period, reference: reference.trim() || null },
      { success: 'Pago registrado' },
    );
    if (out) await this.refreshOrg();
  }

  async cancelSub(s: Subscription): Promise<void> {
    const ok = await this.dialog.confirm({
      title: 'Cancelar suscripción',
      message: `¿Cancelar ${s.plan_name}?`,
      confirmText: 'Cancelar suscripción',
      danger: true,
    });
    if (!ok) return;
    const out = await this.mut.patch<Subscription>(
      `/subscriptions/${s.id}`,
      { status: 'canceled' },
      { success: 'Suscripción cancelada' },
    );
    if (out) await this.refreshOrg();
  }

  openNew(): void {
    this.nf = { name: '', kind: 'league', slug: '' };
    this.showNew.set(true);
  }

  async create(): Promise<void> {
    this.busy.set(true);
    const out = await this.mut.post<Organization>(
      '/organizations',
      { name: this.nf.name.trim(), kind: this.nf.kind, slug: this.nf.slug.trim() || null },
      { success: 'Organización creada' },
    );
    this.busy.set(false);
    if (out) {
      this.showNew.set(false);
      this.go(out.id);
    }
  }
}
