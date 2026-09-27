import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import { CLAIM_STATUS_LABEL, ClaimReview, ClaimStatus, RELATION_LABEL } from '../../core/cuentas';
import { DialogService } from '../../core/dialog.service';
import { fmtDate, fmtDateTime } from '../../core/format';
import { MutationService } from '../../core/mutation.service';
import { Modal } from '../../shared/modal';
import { PageHead } from '../../shared/page-head';

/**
 * Revisión de solicitudes de perfil: el dojo de la persona (sensei o administrador del dojo),
 * los organizadores o el Admin aprueban o rechazan. Los menores siempre pasan por aquí.
 */
@Component({
  selector: 'app-claims-review',
  imports: [FormsModule, PageHead, Modal],
  template: `
    <div class="container">
      <app-page-head
        i18n-title="@@cuenta.reclamos.solicitudes-perfil"
        kanji="申請"
        title="Solicitudes de perfil"
      >
        <div meta class="meta-line">
          <span i18n="@@cuenta.reclamos.cuentas-piden-ligarse-competidor"
            >Cuentas que piden ligarse a un competidor: la propia persona adulta o su padre, madre o
            apoderado.</span
          >
        </div>
        <label class="field inline">
          <span i18n="@@cuenta.reclamos.estado" class="sr-only">Estado</span>
          <select
            i18n-aria-label="@@cuenta.reclamos.estado-2"
            [ngModel]="filter()"
            (ngModelChange)="filter.set($event); load()"
            aria-label="Estado"
          >
            <option i18n="@@cuenta.reclamos.pendientes" value="pending">Pendientes</option>
            <option i18n="@@cuenta.reclamos.aprobadas" value="approved">Aprobadas</option>
            <option i18n="@@cuenta.reclamos.no-aprobadas" value="rejected">No aprobadas</option>
            <option i18n="@@cuenta.reclamos.todas" value="">Todas</option>
          </select>
        </label>
      </app-page-head>

      @if (error()) {
        <div class="alert danger">{{ error() }}</div>
      }
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th i18n="@@cuenta.reclamos.competidor">Competidor</th>
              <th i18n="@@cuenta.reclamos.quien-pide">Quién lo pide</th>
              <th i18n="@@cuenta.reclamos.relacion">Relación</th>
              <th i18n="@@cuenta.reclamos.comprobacion">Comprobación</th>
              <th i18n="@@cuenta.reclamos.estado">Estado</th>
              <th class="right"
                ><span i18n="@@cuenta.reclamos.acciones" class="sr-only">Acciones</span></th
              >
            </tr>
          </thead>
          <tbody>
            @for (c of claims(); track c.id) {
              <tr>
                <td>
                  <strong>{{ c.person_name }}</strong>
                  @if (c.is_minor) {
                    <span i18n="@@cuenta.reclamos.menor" class="badge yamabuki">Menor</span>
                  }
                  <div class="small muted">
                    {{ c.dojo || sinDojo }}
                    @if (c.birth_date) {
                      · {{ fdate(c.birth_date) }}
                    }
                  </div>
                </td>
                <td>
                  {{ c.user_name }}
                  <div class="small muted mono">{{ c.user_email }}</div>
                  @if (c.evidence) {
                    <div class="small evidence">«{{ c.evidence }}»</div>
                  }
                </td>
                <td>{{ relation[c.relationship] }}</td>
                <td class="small">
                  @if (c.document_match === true) {
                    <span i18n="@@cuenta.reclamos.documento-coincide" class="badge matcha"
                      >Documento coincide</span
                    >
                  } @else if (c.document_match === false) {
                    <span i18n="@@cuenta.reclamos.documento-no-coincide" class="badge shu"
                      >Documento no coincide</span
                    >
                  } @else {
                    <span i18n="@@cuenta.reclamos.sin-documento" class="muted">Sin documento</span>
                  }
                  <div class="muted">{{ when(c.created_at) }}</div>
                </td>
                <td>
                  <span
                    class="badge"
                    [class.yamabuki]="c.status === 'pending'"
                    [class.matcha]="c.status === 'approved'"
                    [class.nezumi]="c.status === 'rejected'"
                    >{{ status[c.status] }}</span
                  >
                  @if (c.reason) {
                    <div class="small muted">{{ c.reason }}</div>
                  }
                </td>
                <td class="right nowrap">
                  @if (c.status === 'pending') {
                    <button
                      i18n="@@cuenta.reclamos.aprobar"
                      class="btn sm primary"
                      (click)="approve(c)"
                      >Aprobar</button
                    >
                    <button
                      i18n="@@cuenta.reclamos.rechazar"
                      class="btn sm"
                      (click)="rejectFor.set(c); reason = ''"
                      >Rechazar</button
                    >
                  }
                </td>
              </tr>
            } @empty {
              <tr>
                <td colspan="6" class="empty">
                  <p i18n="@@cuenta.reclamos.no-hay-solicitudes"
                    >No hay solicitudes
                    @if (filter() === 'pending') {
                      pendientes
                    }
                    .</p
                  >
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </div>

    @if (rejectFor(); as c) {
      <app-modal
        i18n-title="@@cuenta.reclamos.rechazar-titulo"
        title="Rechazar · {{ c.person_name }}"
        (closed)="rejectFor.set(null)"
      >
        <form class="stack" (ngSubmit)="reject(c)">
          <label class="field">
            <span i18n="@@cuenta.reclamos.motivo-recibe-cuenta-pidio"
              >Motivo (lo recibe la cuenta que lo pidió)</span
            >
            <textarea name="r" rows="3" [(ngModel)]="reason" maxlength="500"></textarea>
          </label>
          <div class="form-actions">
            <button
              i18n="@@cuenta.reclamos.cancelar"
              type="button"
              class="btn"
              (click)="rejectFor.set(null)"
              >Cancelar</button
            >
            <button i18n="@@cuenta.reclamos.rechazar-solicitud" class="btn danger"
              >Rechazar solicitud</button
            >
          </div>
        </form>
      </app-modal>
    }
  `,
  styles: `
    .evidence {
      font-style: italic;
      margin-top: 0.25rem;
    }
    .nowrap {
      white-space: nowrap;
    }
  `,
})
export class ClaimsReviewPage {
  private api = inject(ApiService);
  private mut = inject(MutationService);
  private dialog = inject(DialogService);
  readonly relation = RELATION_LABEL;
  readonly sinDojo = $localize`:@@comun.sin-dojo:Sin dojo`;
  readonly status = CLAIM_STATUS_LABEL;
  readonly when = fmtDateTime;
  readonly fdate = fmtDate;
  readonly filter = signal<ClaimStatus | ''>('pending');
  readonly claims = signal<ClaimReview[]>([]);
  readonly error = signal('');
  readonly rejectFor = signal<ClaimReview | null>(null);
  reason = '';

  constructor() {
    this.load();
  }

  load(): void {
    this.api.get<ClaimReview[]>('/profile-claims', { status: this.filter() }).subscribe({
      next: (c) => {
        this.claims.set(c);
        this.error.set('');
      },
      error: () =>
        this.error.set(
          $localize`:@@cuenta.reclamos.no-tienes-solicitudes-para:No tienes solicitudes para revisar.`,
        ),
    });
  }

  async approve(c: ClaimReview): Promise<void> {
    const ok = await this.dialog.confirm({
      title: $localize`:@@cuenta.reclamos.aprobar-solicitud:Aprobar solicitud`,
      message: c.is_minor
        ? $localize`:@@cuenta.reclamos.vera-historial-completo-como:${c.user_name}:user_name: verá el historial completo de ${c.person_name}:person_name: como ${this.relation[c.relationship].toLowerCase()}:relacion:. Confirma que lo conoces.`
        : $localize`:@@cuenta.reclamos.cuenta-quedara-ligada-perfil:La cuenta de ${c.user_name}:user_name: quedará ligada al perfil de ${c.person_name}:person_name:.`,
      confirmText: $localize`:@@cuenta.reclamos.aprobar-2:Aprobar`,
    });
    if (!ok) return;
    const r = await this.mut.post(
      `/profile-claims/${c.id}/review`,
      { approve: true },
      { success: $localize`:@@cuenta.reclamos.solicitud-aprobada:Solicitud aprobada` },
    );
    if (r) this.load();
  }

  async reject(c: ClaimReview): Promise<void> {
    const r = await this.mut.post(
      `/profile-claims/${c.id}/review`,
      { approve: false, reason: this.reason.trim() || null },
      { success: $localize`:@@cuenta.reclamos.solicitud-rechazada:Solicitud rechazada` },
    );
    this.rejectFor.set(null);
    if (r) this.load();
  }
}
