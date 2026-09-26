import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import {
  CLAIM_STATUS_LABEL,
  Claim,
  MyProfile,
  PublicProfile,
  RELATION_LABEL,
} from '../../core/cuentas';
import { DialogService } from '../../core/dialog.service';
import { fmtDateTime } from '../../core/format';
import { toggled } from '../../core/push-logic';
import { PushService } from '../../core/push.service';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../shared/icon';
import { PageHead } from '../../shared/page-head';
import { personLink } from '../../shared/person-link';
import { PushButton, PushHint } from '../../shared/push-button';
import { shareProfileCard } from '../../shared/profile-share-card';
import { PersonAwards } from '../persons/person-awards';
import { PersonHistoryView } from '../persons/person-history';
import { ClaimForm } from './claim-form';

/**
 * «Mi perfil» y «Mis competidores (familia)»: los perfiles ligados a la cuenta (el propio y
 * los de los menores a cargo) con historial completo, estadísticas, insignias y tarjeta para
 * compartir; y el formulario para reclamar uno nuevo.
 */
@Component({
  selector: 'app-my-profiles',
  imports: [
    RouterLink,
    PageHead,
    Icon,
    PersonHistoryView,
    PersonAwards,
    ClaimForm,
    PushButton,
    PushHint,
  ],
  template: `
    <div class="container">
      <app-page-head i18n-title="@@cuenta.perfiles.mis-perfiles" kanji="選手" title="Mis perfiles">
        <div meta class="meta-line">
          <span i18n="@@cuenta.perfiles.perfil-deportivo-tus-hijos-hijas"
            >Tu perfil deportivo y el de tus hijos o hijas: historial, estadísticas e
            insignias.</span
          >
        </div>
        <button i18n="@@cuenta.perfiles.reclamar-perfil" class="btn primary" type="button" (click)="claiming.set(!claiming())">
          <app-icon name="plus" /> Reclamar un perfil
        </button>
      </app-page-head>

      @if (!auth.user()?.email_verified_at) {
        <div class="alert warn">
          <strong i18n="@@cuenta.perfiles.confirma-correo-para-reclamar">Confirma tu correo para reclamar perfiles.</strong>
          <div i18n="@@cuenta.perfiles.te-enviamos-enlace-registrarte" class="small">
            Te enviamos un enlace al registrarte. Puedes pedir otro en
            <a routerLink="/perfil">Mi cuenta</a>.
          </div>
        </div>
      }

      @if (claiming()) {
        <section class="card">
          <h2 i18n="@@cuenta.perfiles.reclamar-perfil-2" class="section-title first">Reclamar un perfil</h2>
          <app-claim-form (sent)="onSent()" />
        </section>
      }

      @if (claims().length) {
        <section class="card">
          <h2 i18n="@@cuenta.perfiles.mis-solicitudes" class="section-title first">Mis solicitudes</h2>
          <ul class="list-plain claims">
            @for (c of claims(); track c.id) {
              <li class="row">
                <span class="grow">
                  <strong>{{ c.person_name }}</strong>
                  <span class="muted small">
                    · {{ relation[c.relationship] }} · {{ c.dojo || sinDojo }} ·
                    {{ when(c.created_at) }}</span
                  >
                  @if (c.reason && c.status === 'rejected') {
                    <span i18n="@@cuenta.perfiles.motivo" class="small block">Motivo: {{ c.reason }}</span>
                  }
                </span>
                <span
                  class="badge"
                  [class.yamabuki]="c.status === 'pending'"
                  [class.matcha]="c.status === 'approved'"
                  [class.nezumi]="c.status === 'rejected'"
                >
                  {{ status[c.status] }}
                </span>
              </li>
            }
          </ul>
        </section>
      }

      @if (profiles(); as ps) {
        @if (ps.length) {
          <div i18n-aria-label="@@cuenta.perfiles.perfiles" class="tabs" role="tablist" aria-label="Perfiles">
            @for (p of ps; track p.person_id) {
              <button
                type="button"
                role="tab"
                [attr.aria-selected]="current()?.person_id === p.person_id"
                [class.on]="current()?.person_id === p.person_id"
                (click)="selectedId.set(p.person_id)"
              >
                <span class="name">{{ p.name }}</span>
                <span i18n="@@cuenta.perfiles.mi-perfil-familia" class="small muted">{p.relationship, select, self {Mi perfil} other {Familia}}</span>
              </button>
            }
          </div>
          @if (current(); as p) {
            <div class="profile-head">
              <div class="grow">
                <h2>{{ p.name }}</h2>
                <p class="muted small">
                  {{ p.dojo || sinDojo }} · {{ relation[p.relationship] }}
                </p>
              </div>
              @if (p.public_id) {
                <a i18n="@@cuenta.perfiles.perfil-publico" class="btn sm" [routerLink]="link(p.public_id)"
                  ><app-icon name="open" /> Perfil público</a
                >
                <button i18n="@@cuenta.perfiles.compartir-tarjeta" class="btn sm" type="button" (click)="share(p)" [disabled]="sharing()">
                  Compartir tarjeta
                </button>
              }
              <app-push-button
                [on]="pushPersons().has(p.person_id)"
                [busy]="pushBusy()"
                [label]="p.name"
                (toggled)="togglePush(p, $event)"
              />
              @if (p.guardianship_id) {
                <button i18n="@@cuenta.perfiles.dejar-seguir" class="btn sm ghost" type="button" (click)="leave(p)">
                  Dejar de seguir
                </button>
              }
            </div>
            <app-push-hint [always]="false" />
            <app-person-history [personId]="p.person_id" [links]="false" />
            <app-person-awards [personId]="p.person_id" [links]="false" />
          }
        } @else if (!claiming()) {
          <div class="card empty">
            <p><strong i18n="@@cuenta.perfiles.aun-no-tienes-perfiles-ligados">Aún no tienes perfiles ligados.</strong></p>
            <p i18n="@@cuenta.perfiles.busca-perfil-hijo-hija-reclamar" class="small">
              Busca tu perfil (o el de tu hijo o hija) con «Reclamar un perfil». Lo aprueba el dojo
              o la organización.
            </p>
          </div>
        }
      } @else {
        <div class="empty"><span class="spinner"></span></div>
      }
    </div>
  `,
  styles: `
    .first {
      margin-top: 0;
    }
    .claims li {
      padding: 0.5rem 0;
      border-bottom: 1px solid var(--kasumi);
      &:last-child {
        border-bottom: 0;
      }
    }
    .block {
      display: block;
    }
    .tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin: 1rem 0;
      button {
        all: unset;
        cursor: pointer;
        display: flex;
        flex-direction: column;
        padding: 0.6rem 0.9rem;
        border: 1px solid var(--kasumi);
        border-radius: var(--radius-sm);
        background: var(--kinu);
        &.on {
          border-color: var(--ai);
          box-shadow: inset 0 -3px 0 var(--ai);
        }
        &:focus-visible {
          outline: 2px solid var(--ai);
          outline-offset: 2px;
        }
      }
      .name {
        font-weight: 700;
      }
    }
    .profile-head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 1rem;
      h2 {
        margin: 0;
        font-family: var(--font-display);
      }
      p {
        margin: 0.2rem 0 0;
      }
    }
  `,
})
export class MyProfilesPage {
  readonly auth = inject(AuthService);
  private api = inject(ApiService);
  private dialog = inject(DialogService);
  private toast = inject(ToastService);

  readonly relation = RELATION_LABEL;
  readonly sinDojo = $localize`:@@comun.sin-dojo:Sin dojo`;
  readonly status = CLAIM_STATUS_LABEL;
  readonly when = fmtDateTime;
  readonly link = personLink;
  readonly profiles = signal<MyProfile[] | null>(null);
  readonly claims = signal<Claim[]>([]);
  readonly selectedId = signal<number | null>(null);
  readonly claiming = signal(false);
  readonly sharing = signal(false);
  private push = inject(PushService);
  /** Perfiles con aviso en este dispositivo («te toca», resultados, medallas). */
  readonly pushPersons = signal<Set<number>>(new Set());
  readonly pushBusy = signal(false);
  readonly current = computed<MyProfile | null>(() => {
    const ps = this.profiles() ?? [];
    return ps.find((p) => p.person_id === this.selectedId()) ?? ps[0] ?? null;
  });

  constructor() {
    this.load();
    void this.auth.refreshMe();
    effect(() => {
      if (!this.push.subscription()) return;
      untracked(
        () => void this.push.state().then((s) => this.pushPersons.set(new Set(s.person_ids))),
      );
    });
  }

  async togglePush(p: MyProfile, on: boolean): Promise<void> {
    this.pushBusy.set(true);
    try {
      const s = await this.push.followAccount({ person_id: p.person_id }, on);
      if (!s) return;
      this.pushPersons.set(new Set(s.person_ids));
      this.toast.ok(on ? $localize`:@@cuenta.perfiles.te-avisaremos-combates:Te avisaremos de los combates de ${p.name}:name:` : $localize`:@@cuenta.perfiles.aviso-quitado:Aviso quitado`);
    } catch {
      this.pushPersons.update((set) => toggled(set, p.person_id, !on));
      this.toast.error($localize`:@@cuenta.perfiles.no-pudo-guardar-aviso:No se pudo guardar el aviso`);
    } finally {
      this.pushBusy.set(false);
    }
  }

  load(): void {
    this.api
      .get<MyProfile[]>('/me/profiles')
      .subscribe({ next: (p) => this.profiles.set(p), error: () => this.profiles.set([]) });
    this.api
      .get<Claim[]>('/profile-claims/mine')
      .subscribe({ next: (c) => this.claims.set(c), error: () => {} });
  }

  onSent(): void {
    this.claiming.set(false);
    this.load();
  }

  async share(p: MyProfile): Promise<void> {
    if (!p.public_id) return;
    this.sharing.set(true);
    try {
      const pub = await firstValueFrom(
        this.api.get<PublicProfile>(`/public/persons/${p.public_id}`),
      );
      await shareProfileCard(pub, `${location.origin}/competidor/${p.public_id}`);
    } catch {
      this.toast.error($localize`:@@cuenta.perfiles.no-pudo-preparar-tarjeta:No se pudo preparar la tarjeta`);
    } finally {
      this.sharing.set(false);
    }
  }

  async leave(p: MyProfile): Promise<void> {
    const ok = await this.dialog.confirm({
      title: $localize`:@@cuenta.perfiles.dejar-seguir-este-perfil:Dejar de seguir este perfil`,
      message: $localize`:@@cuenta.perfiles.dejaras-ver-historial-completo:Dejarás de ver el historial completo de ${p.name}:name:. Para volver a verlo tendrás que pedirlo otra vez.`,
      confirmText: $localize`:@@cuenta.perfiles.dejar-seguir-2:Dejar de seguir`,
      danger: true,
    });
    if (!ok || !p.guardianship_id) return;
    this.api.delete<void>(`/me/guardianships/${p.guardianship_id}`).subscribe({
      next: () => {
        this.toast.ok($localize`:@@cuenta.perfiles.listo:Listo`);
        this.selectedId.set(null);
        this.load();
      },
      error: () => this.toast.error($localize`:@@cuenta.perfiles.no-pudo-quitar:No se pudo quitar`),
    });
  }
}
