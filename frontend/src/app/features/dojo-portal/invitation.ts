import { Component, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiError } from '../../core/api-error';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { fmtDate } from '../../core/format';
import { Dojo, InvitationInfo } from '../../core/models';
import { MutationService } from '../../core/mutation.service';
import { PageHead } from '../../shared/page-head';

/**
 * Enlace de invitación a la inscripción en línea de un torneo. Con un enlace de dojo, la
 * cuenta queda como administradora de ese dojo (o pide aprobación si ya tiene otro admin);
 * con el enlace general, elige su dojo y el organizador aprueba.
 */
@Component({
  selector: 'app-invitation',
  imports: [FormsModule, RouterLink, PageHead],
  template: `
    <div class="container narrow">
      <app-page-head
        i18n-title="@@portal-dojo.invitacion.invitacion"
        kanji="招"
        title="Invitación"
      />
      @if (info(); as i) {
        <div class="card stack">
          <p i18n="@@portal-dojo.invitacion.te-invita-inscribir-tus">
            <strong>{{ i.organization_name }}</strong> te invita a inscribir a tus competidores en
            <strong>{{ i.tournament_name }}</strong> ({{ date(i.start_date) }}).
          </p>
          @if (!i.self_registration_open) {
            <div i18n="@@portal-dojo.invitacion.inscripcion-linea-este-torneo" class="alert warn">
              La inscripción en línea de este torneo está cerrada por ahora.
            </div>
          }
          @if (result() === 'granted' || result() === 'already_admin' || i.already_admin) {
            <div i18n="@@portal-dojo.invitacion.cuenta-administra-dojo-ya-puedes" class="alert ok">
              Tu cuenta administra el dojo{{ i.dojo_name ? ' ' + i.dojo_name : '' }}. Ya puedes
              inscribir.
            </div>
            <div class="form-actions">
              <a
                i18n="@@portal-dojo.invitacion.ir-mis-competidores"
                class="btn primary"
                routerLink="/mis-competidores"
                >Ir a Mis competidores</a
              >
            </div>
          } @else if (result() === 'pending_approval') {
            <div i18n="@@portal-dojo.invitacion.pedido-quedo-registrado" class="alert info">
              Tu pedido quedó registrado: el organizador debe aprobar que administres el dojo. Te
              avisaremos.
            </div>
          } @else {
            @if (i.dojo_id) {
              <p i18n="@@portal-dojo.invitacion.dojo-aceptar-cuenta-quedara-como">
                Dojo: <strong>{{ i.dojo_name }}</strong
                >. Al aceptar, tu cuenta quedará como administradora de este dojo.
              </p>
            } @else {
              <label class="field">
                <span i18n="@@portal-dojo.invitacion.dojo">Tu dojo</span>
                <select [(ngModel)]="dojoId">
                  <option i18n="@@portal-dojo.invitacion.elige-dojo" [ngValue]="null"
                    >— Elige tu dojo —</option
                  >
                  @for (d of dojos(); track d.id) {
                    <option [ngValue]="d.id">{{ d.name }}</option>
                  }
                </select>
              </label>
              <p
                i18n="@@portal-dojo.invitacion.organizador-aprobara-administres"
                class="small muted"
                >El organizador aprobará que administres el dojo elegido.</p
              >
            }
            <div class="form-actions">
              <button
                i18n="@@portal-dojo.invitacion.aceptar-invitacion"
                class="btn primary"
                (click)="accept()"
                [disabled]="busy() || (!i.dojo_id && !dojoId)"
              >
                Aceptar invitación
              </button>
            </div>
          }
        </div>
      } @else if (error()) {
        <div class="alert danger">{{ error() }}</div>
      } @else {
        <div class="empty"><span class="spinner"></span></div>
      }
    </div>
  `,
  styles: `
    .narrow {
      max-width: 44rem;
    }
  `,
})
export class InvitationPage {
  private api = inject(ApiService);
  private mut = inject(MutationService);
  private auth = inject(AuthService);
  private router = inject(Router);

  readonly token = input.required<string>();
  readonly info = signal<InvitationInfo | null>(null);
  readonly dojos = signal<Dojo[]>([]);
  readonly error = signal('');
  readonly busy = signal(false);
  readonly result = signal<string>('');
  dojoId: number | null = null;

  constructor() {
    effect(() => {
      const tok = this.token();
      if (tok) void this.load(tok);
    });
  }

  date(v: string): string {
    return fmtDate(v);
  }

  async load(token: string): Promise<void> {
    try {
      const i = await firstValueFrom(this.api.get<InvitationInfo>(`/invitations/${token}`));
      this.info.set(i);
      if (!i.dojo_id)
        this.dojos.set(await firstValueFrom(this.api.get<Dojo[]>('/dojos')).catch(() => []));
    } catch (e) {
      this.error.set(ApiError.from(e).message);
    }
  }

  async accept(): Promise<void> {
    this.busy.set(true);
    const out = await this.mut.post<{ status: string; dojo_id: number }>(
      `/invitations/${this.token()}/accept`,
      { dojo_id: this.dojoId },
    );
    this.busy.set(false);
    if (!out) return;
    this.result.set(out.status);
    if (out.status !== 'pending_approval') {
      await this.auth.refreshMe(); // aparece «Mis competidores» en el menú
      this.router.navigate(['/mis-competidores']);
    }
  }
}
