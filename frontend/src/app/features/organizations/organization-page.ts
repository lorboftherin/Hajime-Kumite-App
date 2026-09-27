import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { DialogService } from '../../core/dialog.service';
import { fmtDate, ORG_KIND_LABEL, ORG_ROLE_LABEL, SUBSCRIPTION_STATUS } from '../../core/format';
import { INVOICE_STATUS, invoiceNumber, PAYMENT_STATUS, penFromCents } from '../../core/billing';
import {
  BillingConfig,
  Organization,
  OrgMember,
  OrgRole,
  PaymentOut,
  Plan,
  PlansOut,
  Subscription,
} from '../../core/models';
import { MutationService } from '../../core/mutation.service';
import { Icon } from '../../shared/icon';
import { Modal } from '../../shared/modal';
import { PageHead } from '../../shared/page-head';
import { SubscribeDialog } from '../billing/subscribe-dialog';

/**
 * Página «Organización»: datos, miembros y plan actual. El dueño (owner) o un administrador
 * editan; el Admin Global crea organizaciones y asigna suscripciones manuales.
 */
@Component({
  selector: 'app-organization-page',
  imports: [FormsModule, RouterLink, PageHead, Icon, Modal, SubscribeDialog],
  template: `
    <div class="container">
      <app-page-head kanji="組" [title]="org()?.name ?? txtOrganizacion">
        <div meta class="meta-line">
          @if (org(); as o) {
            <span>{{ kindLabel(o.kind) }}</span>
            @if (o.my_role) {
              <span class="badge plain">{{ roleLabel(o.my_role) }}</span>
            }
            <span class="small"
              i18n="@@organizacion.n-torneos">{o.tournament_count, plural, =1 {1 torneo} other {{{ o.tournament_count }} torneos}}</span
            >
          }
        </div>
        @if (orgs().length > 1) {
          <label class="field inline small">
            <span i18n="@@organizacion.organizacion" class="sr-only">Organización</span>
            <select i18n-aria-label="@@organizacion.elegir-organizacion"
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
          <button i18n="@@organizacion.nueva-organizacion" class="btn primary" (click)="openNew()">
            <app-icon name="plus" /> Nueva organización
          </button>
        }
      </app-page-head>

      @if (loading()) {
        <div class="empty"><span class="spinner"></span></div>
      } @else if (!org()) {
        <div class="card empty">
          <p><strong i18n="@@organizacion.no-perteneces-ninguna">No perteneces a ninguna organización.</strong></p><ng-container i18n="@@organizacion.pide-dueno-liga-club-dojo-te">
          Pide al dueño de tu liga, club o dojo que te invite con tu nombre de usuario.
        </ng-container></div>
      } @else {
        @let o = org()!;
        <div class="layout">
          <section class="card" aria-labelledby="h-datos">
            <h2 i18n="@@organizacion.datos" id="h-datos">Datos</h2>
            <form class="stack" (ngSubmit)="save()">
              <div class="grid-2">
                <label class="field"
                  ><span i18n="@@organizacion.nombre">Nombre *</span
                  ><input
                    name="n"
                    [(ngModel)]="f.name"
                    [disabled]="!o.can_manage"
                    required
                    minlength="2"
                /></label>
                <label class="field"
                  ><span i18n="@@organizacion.identificador-slug">Identificador (slug)</span
                  ><input name="s" [(ngModel)]="f.slug" [disabled]="!o.can_manage"
                /></label>
                <label class="field">
                  <span i18n="@@organizacion.tipo">Tipo</span>
                  <select name="k" [(ngModel)]="f.kind" [disabled]="!o.can_manage">
                    <option i18n="@@organizacion.liga" value="league">Liga</option>
                    <option i18n="@@organizacion.dojo" value="dojo">Dojo</option>
                    <option i18n="@@organizacion.organizador" value="organizer">Organizador</option>
                  </select>
                </label>
                <label class="field"
                  ><span i18n="@@organizacion.logo-ruta-url">Logo (ruta o URL)</span
                  ><input i18n-placeholder="@@organizacion.https"
                    name="l"
                    [(ngModel)]="f.logo"
                    [disabled]="!o.can_manage"
                    placeholder="https://…"
                /></label>
                <label class="field"
                  ><span i18n="@@organizacion.pais">País</span
                  ><input name="c" [(ngModel)]="f.country" maxlength="2" [disabled]="!o.can_manage"
                /></label>
                <label class="field"
                  ><span i18n="@@organizacion.zona-horaria">Zona horaria</span
                  ><input name="tz" [(ngModel)]="f.timezone" [disabled]="!o.can_manage"
                /></label>
                <label class="field"
                  ><span i18n="@@organizacion.moneda">Moneda</span
                  ><input
                    name="cu"
                    [(ngModel)]="f.currency"
                    maxlength="3"
                    [disabled]="!o.can_manage"
                /></label>
              </div>
              <h3 i18n="@@organizacion.datos-para-comprobante">Datos para el comprobante</h3>
              <p i18n="@@organizacion.ruc-emite-factura-razon-social" class="small muted">
                Con RUC se emite factura a la razón social; sin RUC, boleta.
              </p>
              <div class="grid-2">
                <label class="field"
                  ><span i18n="@@organizacion.ruc">RUC</span
                  ><input
                    name="ruc"
                    [(ngModel)]="f.tax_id"
                    inputmode="numeric"
                    maxlength="11"
                    pattern="[0-9]{11}"
                    [disabled]="!o.can_manage"
                /></label>
                <label class="field"
                  ><span i18n="@@organizacion.razon-social">Razón social</span
                  ><input name="rs" [(ngModel)]="f.legal_name" [disabled]="!o.can_manage"
                /></label>
                <label class="field"
                  ><span i18n="@@organizacion.domicilio-fiscal">Domicilio fiscal</span
                  ><input name="df" [(ngModel)]="f.tax_address" [disabled]="!o.can_manage"
                /></label>
                <label class="field"
                  ><span i18n="@@organizacion.correo-para-comprobantes">Correo para comprobantes</span
                  ><input
                    name="be"
                    type="email"
                    [(ngModel)]="f.billing_email"
                    [disabled]="!o.can_manage"
                /></label>
              </div>
              @if (o.can_manage) {
                <div class="form-actions">
                  <button i18n="@@organizacion.guardar" class="btn primary" [disabled]="f.name.trim().length < 2 || busy()">
                    Guardar
                  </button>
                </div>
              }
            </form>
          </section>

          <section class="card" aria-labelledby="h-plan">
            <h2 i18n="@@organizacion.plan-actual" id="h-plan">Plan actual</h2>
            @if (plans()?.mode === 'marcha_blanca') {
              <p i18n="@@organizacion.marcha-blanca-todo-esta" class="alert ok small">
                Marcha blanca: todo está disponible sin costo mientras dure la etapa de pruebas.
              </p>
            }
            @if (o.subscription; as sub) {
              <p>
                <strong>{{ sub.plan_name }}</strong> · {{ statusLabel(sub.status) }}
                @if (sub.current_period_end) {<ng-container i18n="@@organizacion.termina-vigente-hasta">
                  · @if (sub.cancel_at_period_end) {termina} @else {vigente hasta} el
                  {{ date(sub.current_period_end) }}
                </ng-container>}
                @if (sub.recurring) {
                  <span i18n="@@organizacion.renovacion-automatica" class="badge matcha">Renovación automática</span>
                }
              </p>
              @if (sub.in_grace) {
                <p i18n="@@organizacion.ultimo-pago-no-completo" class="alert warn small">
                  El último pago no se completó. Mantienes el acceso hasta el
                  {{ date(sub.access_until ?? sub.grace_until ?? '') }}: renueva para no perderlo.
                </p>
              }
              @if (o.can_manage && plans()?.mode === 'enforced') {
                <div class="row actions">
                  @if (!sub.recurring && planOf(sub.plan_code); as p) {
                    <button i18n="@@organizacion.renovar" class="btn sm primary" type="button" (click)="renew.set(p)">
                      Renovar
                    </button>
                  }
                  @if (sub.status !== 'canceled' && !sub.cancel_at_period_end) {
                    <button i18n="@@organizacion.cancelar-suscripcion" class="btn sm ghost" type="button" (click)="cancelOwn(sub)">
                      Cancelar suscripción
                    </button>
                  }
                </div>
              }
            } @else {
              <p i18n="@@organizacion.sin-suscripcion-vigente" class="muted">Sin suscripción vigente.</p>
              @if (o.can_manage && plans()?.mode === 'enforced') {
                <p><a i18n="@@organizacion.elegir-plan" class="btn sm primary" routerLink="/planes">Elegir un plan</a></p>
              }
            }
            <div class="features">
              @for (feat of o.features; track feat) {
                <span class="badge matcha">{{ plans()?.features?.[feat] ?? feat }}</span>
              } @empty {
                <span i18n="@@organizacion.ninguna-funcion-pago-disponible" class="muted small">Ninguna función de pago disponible.</span>
              }
            </div>
            <p><a i18n="@@organizacion.ver-planes-precios" routerLink="/planes">Ver planes y precios</a></p>

            @if (auth.isAdmin()) {
              <h3 i18n="@@organizacion.suscripciones-admin">Suscripciones (Admin)</h3>
              <form class="row assign" (ngSubmit)="assign()">
                <select i18n-aria-label="@@organizacion.plan" name="pc" [(ngModel)]="sub.plan_code" aria-label="Plan">
                  @for (p of orgPlans(); track p.code) {
                    <option [value]="p.code">{{ p.name }}</option>
                  }
                </select>
                <select i18n-aria-label="@@organizacion.estado" name="st" [(ngModel)]="sub.status" aria-label="Estado">
                  <option i18n="@@organizacion.activa" value="active">Activa</option>
                  <option i18n="@@organizacion.prueba" value="trial">Prueba</option>
                </select>
                <input i18n-title="@@organizacion.vigente-hasta-vacio-sin" i18n-aria-label="@@organizacion.vigente-hasta"
                  type="date"
                  name="pe"
                  [(ngModel)]="sub.period_end"
                  aria-label="Vigente hasta"
                  title="Vigente hasta (vacío = sin vencimiento)"
                />
                <button i18n="@@organizacion.asignar-plan" class="btn" [disabled]="busy()">Asignar plan</button>
              </form>
              <div class="table-wrap">
                <table class="table">
                  <thead>
                    <tr>
                      <th i18n="@@organizacion.plan-2">Plan</th>
                      <th i18n="@@organizacion.estado-2">Estado</th>
                      <th i18n="@@organizacion.hasta">Hasta</th>
                      <th i18n="@@organizacion.origen">Origen</th>
                      <th><span i18n="@@organizacion.acciones" class="sr-only">Acciones</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (s of subscriptions(); track s.id) {
                      <tr>
                        <td>
                          {{ s.plan_name }}
                          @if (s.is_current) {
                            <span i18n="@@organizacion.vigente" class="badge matcha">Vigente</span>
                          }
                        </td>
                        <td>{{ statusLabel(s.status) }}</td>
                        <td class="nowrap">
                          {{ s.current_period_end ? date(s.current_period_end) : '—' }}
                        </td>
                        <td class="small">
                          <ng-container i18n="@@organizacion.manual-pago">{s.source, select, manual {Manual} other {Pago}}</ng-container>
                          @if (s.reference) {
                            · {{ s.reference }}
                          }
                        </td>
                        <td class="right nowrap">
                          @if (s.status !== 'canceled') {
                            <button i18n="@@organizacion.pagado-1-mes" class="btn sm" (click)="markPaid(s, 'month')">
                              Pagado 1 mes
                            </button>
                            <button i18n="@@organizacion.pagado-1-ano" class="btn sm" (click)="markPaid(s, 'year')">
                              Pagado 1 año
                            </button>
                            <button i18n="@@organizacion.cancelar" class="btn sm ghost" (click)="cancelSub(s)">Cancelar</button>
                          }
                        </td>
                      </tr>
                    } @empty {
                      <tr>
                        <td i18n="@@organizacion.sin-suscripciones" colspan="5" class="muted small">Sin suscripciones.</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          </section>

          @if (o.can_manage) {
            <section class="card wide" aria-labelledby="h-pagos">
              <h2 i18n="@@organizacion.pagos-comprobantes" id="h-pagos">Pagos y comprobantes</h2>
              <div class="table-wrap">
                <table class="table">
                  <thead>
                    <tr>
                      <th i18n="@@organizacion.fecha">Fecha</th>
                      <th i18n="@@organizacion.plan-2">Plan</th>
                      <th i18n="@@organizacion.monto" class="right">Monto</th>
                      <th i18n="@@organizacion.estado-2">Estado</th>
                      <th i18n="@@organizacion.comprobante">Comprobante</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (pay of payments(); track pay.id) {
                      <tr>
                        <td class="nowrap">{{ date(pay.created_at) }}</td>
                        <td>
                          {{ pay.plan_name }}
                          <span i18n="@@cobro.culqi.periodo" class="small muted">{pay.period, select, year {anual} other {mensual}}</span>
                        </td>
                        <td class="right num nowrap">{{ cents(pay.amount_pen) }}</td>
                        <td>{{ payStatus(pay.status) }}</td>
                        <td class="small">
                          @if (pay.invoice; as inv) {
                            {{ num(inv.serie, inv.numero) }} · {{ invStatus(inv.status) }}
                            @if (inv.pdf_url) {
                              · <a i18n="@@organizacion.pdf" [href]="inv.pdf_url" target="_blank" rel="noopener">PDF</a>
                            }
                            @if (inv.xml_url) {
                              · <a i18n="@@organizacion.xml" [href]="inv.xml_url" target="_blank" rel="noopener">XML</a>
                            }
                            @if (pay.credit_note; as nc) {
                              <ng-container i18n="@@organizacion.nota-credito"><br />Nota de crédito {{ num(nc.serie, nc.numero) }}
                              </ng-container>@if (nc.pdf_url) {
                                · <a i18n="@@organizacion.pdf" [href]="nc.pdf_url" target="_blank" rel="noopener">PDF</a>
                              }
                            }
                          } @else {
                            —
                          }
                        </td>
                      </tr>
                    } @empty {
                      <tr>
                        <td i18n="@@organizacion.sin-pagos-todavia" colspan="5" class="muted small">Sin pagos todavía.</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </section>
          }

          <section class="card wide" aria-labelledby="h-miembros">
            <h2 i18n="@@organizacion.miembros" id="h-miembros">Miembros</h2>
            <p i18n="@@organizacion.dueno-administrador-gestionan" class="small muted">
              Dueño y administrador gestionan la organización y todos sus torneos; un miembro solo
              los consulta.
            </p>
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr>
                    <th i18n="@@organizacion.usuario">Usuario</th>
                    <th i18n="@@organizacion.nombre-2">Nombre</th>
                    <th i18n="@@organizacion.rol">Rol</th>
                    <th><span i18n="@@organizacion.acciones" class="sr-only">Acciones</span></th>
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
                            [attr.aria-label]="ariaRolDe(m.username)"
                          >
                            <option i18n="@@organizacion.dueno" value="owner">Dueño</option>
                            <option i18n="@@organizacion.administrador" value="admin">Administrador</option>
                            <option i18n="@@organizacion.miembro" value="member">Miembro</option>
                          </select>
                        } @else {
                          {{ roleLabel(m.role) }}
                        }
                      </td>
                      <td class="right">
                        @if (o.can_manage) {
                          <button i18n="@@organizacion.quitar" class="btn sm ghost" (click)="remove(m)">Quitar</button>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            @if (o.can_manage) {
              <form class="row invite" (ngSubmit)="invite()">
                <input i18n-aria-label="@@organizacion.usuario-invitar" i18n-placeholder="@@organizacion.usuario-existente"
                  name="u"
                  [(ngModel)]="inv.username"
                  placeholder="Usuario existente"
                  aria-label="Usuario a invitar"
                />
                <select i18n-aria-label="@@organizacion.rol-2" name="r" [(ngModel)]="inv.role" aria-label="Rol">
                  <option i18n="@@organizacion.miembro" value="member">Miembro</option>
                  <option i18n="@@organizacion.administrador" value="admin">Administrador</option>
                  <option i18n="@@organizacion.dueno" value="owner">Dueño</option>
                </select>
                <button i18n="@@organizacion.invitar" class="btn" [disabled]="!inv.username.trim() || busy()">
                  <app-icon name="plus" /> Invitar
                </button>
              </form>
            }
          </section>
        </div>
      }
    </div>

    @if (renew(); as p) {
      <app-subscribe-dialog [plan]="p" [config]="config()" (closed)="renew.set(null)" />
    }

    @if (showNew()) {
      <app-modal i18n-title="@@organizacion.nueva-organizacion-2" title="Nueva organización" (closed)="showNew.set(false)">
        <form class="stack" (ngSubmit)="create()">
          <label class="field"
            ><span i18n="@@organizacion.nombre">Nombre *</span><input name="n" [(ngModel)]="nf.name" required minlength="2"
          /></label>
          <div class="grid-2">
            <label class="field">
              <span i18n="@@organizacion.tipo">Tipo</span>
              <select name="k" [(ngModel)]="nf.kind">
                <option i18n="@@organizacion.liga" value="league">Liga</option>
                <option i18n="@@organizacion.dojo" value="dojo">Dojo</option>
                <option i18n="@@organizacion.organizador" value="organizer">Organizador</option>
              </select>
            </label>
            <label class="field"
              ><span i18n="@@organizacion.identificador-opcional">Identificador (opcional)</span
              ><input i18n-placeholder="@@organizacion.liga-lima" name="s" [(ngModel)]="nf.slug" placeholder="liga-de-lima"
            /></label>
          </div>
          <p i18n="@@organizacion.luego-invita-dueno-desde" class="small muted">Luego invita al dueño desde «Miembros» con su usuario.</p>
          <div class="form-actions">
            <button i18n="@@organizacion.cancelar" type="button" class="btn" (click)="showNew.set(false)">Cancelar</button>
            <button i18n="@@organizacion.crear" class="btn primary" [disabled]="nf.name.trim().length < 2 || busy()">
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
    .actions {
      gap: 0.5rem;
      flex-wrap: wrap;
      margin-bottom: 0.5rem;
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
  readonly txtOrganizacion = $localize`:@@organizacion.organizacion:Organización`;
  ariaRolDe = (usuario: string) => $localize`:@@organizacion.rol-de:Rol de ${usuario}:usuario:`;
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
  readonly payments = signal<PaymentOut[]>([]);
  readonly plans = signal<PlansOut | null>(null);
  readonly config = signal<BillingConfig | null>(null);
  /** Plan a renovar (abre el diálogo de suscripción). */
  readonly renew = signal<Plan | null>(null);
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
    tax_id: '',
    legal_name: '',
    tax_address: '',
    billing_email: '',
  };
  inv = { username: '', role: 'member' as OrgRole };
  sub = { plan_code: 'dojo', status: 'active', period_end: '' };
  nf = { name: '', kind: 'league', slug: '' };

  constructor() {
    this.api.get<PlansOut>('/plans').subscribe({ next: (p) => this.plans.set(p), error: () => {} });
    this.api
      .get<BillingConfig>('/billing/config')
      .subscribe({ next: (c) => this.config.set(c), error: () => {} });
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
        tax_id: o.tax_id ?? '',
        legal_name: o.legal_name ?? '',
        tax_address: o.tax_address ?? '',
        billing_email: o.billing_email ?? '',
      };
    }
  }

  planOf(code: string): Plan | null {
    return this.plans()?.plans.find((p) => p.code === code) ?? null;
  }
  cents(v: number): string {
    return penFromCents(v);
  }
  num(serie: string, numero: number): string {
    return invoiceNumber(serie, numero);
  }
  payStatus(s: PaymentOut['status']): string {
    return PAYMENT_STATUS[s] ?? s;
  }
  invStatus(s: string): string {
    return INVOICE_STATUS[s] ?? s;
  }

  async cancelOwn(s: Subscription): Promise<void> {
    const ok = await this.dialog.confirm({
      title: $localize`:@@organizacion.cancelar-suscripcion-2:Cancelar suscripción`,
      message: $localize`:@@organizacion.no-renovara-organizacion:${s.plan_name}:plan_name: no se renovará. La organización conserva el acceso hasta el fin del periodo pagado.`,
      confirmText: $localize`:@@organizacion.cancelar-suscripcion-2:Cancelar suscripción`,
      danger: true,
    });
    if (!ok) return;
    const out = await this.mut.post<Subscription>(
      `/subscriptions/${s.id}/cancel`,
      {},
      { success: $localize`:@@organizacion.suscripcion-cancelada:Suscripción cancelada` },
    );
    if (out) await this.refreshOrg();
  }

  private async loadDetails(oid: number): Promise<void> {
    this.members.set(
      await firstValueFrom(this.api.get<OrgMember[]>(`/organizations/${oid}/members`)).catch(
        () => [],
      ),
    );
    const org = this.orgs().find((x) => x.id === oid);
    if (org?.can_manage) {
      this.payments.set(
        await firstValueFrom(this.api.get<PaymentOut[]>(`/organizations/${oid}/payments`)).catch(
          () => [],
        ),
      );
    }
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
      tax_id: this.f.tax_id.trim(),
      legal_name: this.f.legal_name.trim(),
      tax_address: this.f.tax_address.trim(),
      billing_email: this.f.billing_email.trim(),
    };
    const out = await this.mut.patch<Organization>(`/organizations/${o.id}`, body, {
      success: $localize`:@@organizacion.organizacion-guardada:Organización guardada`,
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
      { success: $localize`:@@organizacion.miembro-agregado:Miembro agregado` },
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
      { success: $localize`:@@organizacion.rol-actualizado:Rol actualizado` },
    );
    this.members.set(out ?? [...this.members()]);
  }

  async remove(m: OrgMember): Promise<void> {
    const o = this.org();
    if (!o) return;
    const ok = await this.dialog.confirm({
      title: $localize`:@@organizacion.quitar-miembro:Quitar miembro`,
      message: $localize`:@@organizacion.dejara-ver-administrar-torneos:${m.display_name || m.username}:miembro: dejará de ver y administrar los torneos de ${o.name}:name:.`,
      confirmText: $localize`:@@organizacion.quitar-2:Quitar`,
      danger: true,
    });
    if (!ok) return;
    const out = await this.mut.run(
      () => this.api.delete<OrgMember[]>(`/organizations/${o.id}/members/${m.user_id}`),
      { success: $localize`:@@organizacion.miembro-quitado:Miembro quitado` },
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
      success: $localize`:@@organizacion.plan-asignado:Plan asignado`,
    });
    this.busy.set(false);
    if (out) await this.refreshOrg();
  }

  async markPaid(s: Subscription, period: 'month' | 'year'): Promise<void> {
    const reference = await this.dialog.prompt({
      title: $localize`:@@organizacion.confirmar-pago:Confirmar pago`,
      message:
        period === 'year'
          ? $localize`:@@organizacion.suscripcion-activa-ano-mas:La suscripción ${s.plan_name}:plan: quedará activa un año más.`
          : $localize`:@@organizacion.suscripcion-activa-mes-mas:La suscripción ${s.plan_name}:plan: quedará activa un mes más.`,
      label: $localize`:@@organizacion.referencia-pago-operacion-yape:Referencia del pago (operación, Yape…)`,
      minLength: 0,
      confirmText: $localize`:@@organizacion.marcar-pagado:Marcar pagado`,
    });
    if (reference === null) return;
    const out = await this.mut.post<Subscription>(
      `/subscriptions/${s.id}/mark-paid`,
      { period, reference: reference.trim() || null },
      { success: $localize`:@@organizacion.pago-registrado:Pago registrado` },
    );
    if (out) await this.refreshOrg();
  }

  async cancelSub(s: Subscription): Promise<void> {
    const ok = await this.dialog.confirm({
      title: $localize`:@@organizacion.cancelar-suscripcion-2:Cancelar suscripción`,
      message: $localize`:@@organizacion.cancelar-2:¿Cancelar ${s.plan_name}:plan_name:?`,
      confirmText: $localize`:@@organizacion.cancelar-suscripcion-2:Cancelar suscripción`,
      danger: true,
    });
    if (!ok) return;
    const out = await this.mut.patch<Subscription>(
      `/subscriptions/${s.id}`,
      { status: 'canceled' },
      { success: $localize`:@@organizacion.suscripcion-cancelada:Suscripción cancelada` },
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
      { success: $localize`:@@organizacion.organizacion-creada:Organización creada` },
    );
    this.busy.set(false);
    if (out) {
      this.showNew.set(false);
      this.go(out.id);
    }
  }
}
