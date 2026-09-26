import { Component, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiError } from '../../core/api-error';
import { ApiService } from '../../core/api.service';
import { Claim, ClaimRelation, ProfileSearchResult } from '../../core/cuentas';
import { Dojo } from '../../core/models';
import { MutationService } from '../../core/mutation.service';

/**
 * Reclamar un perfil: buscar por nombre (y dojo), elegir el resultado y enviar la solicitud.
 * La búsqueda solo muestra lo público: nombre abreviado, dojo y torneos.
 */
@Component({
  selector: 'app-claim-form',
  imports: [FormsModule],
  template: `
    <div class="stack">
      <fieldset class="relation">
        <legend i18n="@@cuenta.reclamo.quien-perfil">¿De quién es el perfil?</legend>
        <label i18n="@@cuenta.reclamo.mio-soy-mayor-edad"
          ><input type="radio" name="rel" value="self" [(ngModel)]="relation" /> Es mío (soy mayor
          de edad)</label
        >
        <label i18n="@@cuenta.reclamo.mi-hijo-hija"
          ><input type="radio" name="rel" value="parent" [(ngModel)]="relation" /> De mi hijo o
          hija</label
        >
        <label i18n="@@cuenta.reclamo.menor-soy-apoderado"
          ><input type="radio" name="rel" value="guardian" [(ngModel)]="relation" /> De un menor del
          que soy apoderado</label
        >
      </fieldset>

      <form class="search" (ngSubmit)="search()">
        <label class="field grow">
          <span i18n="@@cuenta.reclamo.nombre-apellido">Nombre y apellido</span>
          <input i18n-placeholder="@@cuenta.reclamo.ej-diego-ramirez" name="q" [(ngModel)]="q" placeholder="Ej.: Diego Ramírez" autocomplete="off" />
        </label>
        <label class="field">
          <span i18n="@@cuenta.reclamo.dojo">Dojo</span>
          <select name="dojo" [(ngModel)]="dojoId">
            <option i18n="@@cuenta.reclamo.cualquiera" [ngValue]="null">Cualquiera</option>
            @for (d of dojos(); track d.id) {
              <option [ngValue]="d.id">{{ d.name }}</option>
            }
          </select>
        </label>
        <button i18n="@@cuenta.reclamo.buscar" class="btn" [disabled]="q().trim().length < 3 || busy()">Buscar</button>
      </form>
      @if (searchError()) {
        <div class="alert warn">{{ searchError() }}</div>
      }

      @if (results(); as rs) {
        <ul i18n-aria-label="@@cuenta.reclamo.resultados" class="list-plain results" aria-label="Resultados">
          @for (r of rs; track r.public_id) {
            <li>
              <label class="result" [class.on]="selected()?.public_id === r.public_id">
                <input
                  type="radio"
                  name="pick"
                  [checked]="selected()?.public_id === r.public_id"
                  (change)="selected.set(r)"
                />
                <span class="grow">
                  <strong>{{ r.name }}</strong>
                  <span class="muted">· {{ r.dojo || sinDojo }}</span>
                  <span class="small muted block">
                    @if (r.tournament_count) {
                      {{ r.tournaments.join(', ') }}
                      @if (r.tournament_count > r.tournaments.length) {<ng-container i18n="@@cuenta.reclamo.mas">
                        y {{ r.tournament_count - r.tournaments.length }} más
                      </ng-container>}
                    } @else {<ng-container i18n="@@cuenta.reclamo.sin-torneos-disputados">
                      Sin torneos disputados
                    </ng-container>}
                  </span>
                </span>
              </label>
            </li>
          } @empty {
            <li i18n="@@cuenta.reclamo.sin-resultados-prueba-otro" class="muted small">Sin resultados. Prueba con otro nombre o sin elegir dojo.</li>
          }
        </ul>
      }

      @if (selected(); as sel) {
        <form class="stack card inner" (ngSubmit)="submit(sel)">
          <p i18n="@@cuenta.reclamo.solicitas-perfil-revisa-dojo" class="small">
            Solicitas el perfil de <strong>{{ sel.name }}</strong
            >. Lo revisa su dojo o la organización.
          </p>
          <label class="field">
            <span i18n="@@cuenta.reclamo.ultimos-4-digitos-documento">Últimos 4 dígitos del documento (opcional)</span>
            <input
              name="doc"
              [(ngModel)]="last4"
              maxlength="4"
              inputmode="numeric"
              autocomplete="off"
              class="short"
            />
            <small i18n="@@cuenta.reclamo.comparan-no-guardan-ayudan" class="hint"
              >Se comparan y no se guardan. Ayudan a que la revisión sea más rápida.</small
            >
          </label>
          <label class="field">
            <span i18n="@@cuenta.reclamo.mensaje-para-quien-revisa">Mensaje para quien revisa (opcional)</span>
            <textarea i18n-placeholder="@@cuenta.reclamo.ej-entrena-martes-sensei-luis"
              name="ev"
              rows="2"
              [(ngModel)]="evidence"
              maxlength="500"
              placeholder="Ej.: entrena los martes con el sensei Luis"
            ></textarea>
          </label>
          @if (relation() !== 'self') {
            <label class="check">
              <input type="checkbox" name="consent" [(ngModel)]="consent" />
              <span i18n="@@cuenta.reclamo.como-autorizo-publicacion">
                Como {relation(), select, parent {padre o madre} other {apoderado}}, autorizo la
                publicación de sus resultados deportivos y el uso de sus datos en estadísticas de
                Hajime, como se explica en Privacidad.
              </span>
            </label>
          }
          <div class="form-actions">
            <button i18n="@@cuenta.reclamo.enviar-solicitud"
              class="btn primary"
              [disabled]="
                busy() ||
                (relation() !== 'self' && !consent()) ||
                (last4() !== '' && last4().length !== 4)
              "
            >
              Enviar solicitud
            </button>
          </div>
        </form>
      }
    </div>
  `,
  styles: `
    .relation {
      border: 0;
      padding: 0;
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
      legend {
        font-weight: 700;
        margin-bottom: 0.4rem;
      }
      label {
        display: flex;
        gap: 0.5rem;
        align-items: center;
      }
      input {
        width: auto;
      }
    }
    .search {
      display: flex;
      flex-wrap: wrap;
      gap: 0.75rem;
      align-items: flex-end;
      .field {
        margin: 0;
      }
    }
    .results {
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
    }
    .result {
      display: flex;
      gap: 0.6rem;
      align-items: flex-start;
      padding: 0.6rem 0.75rem;
      border: 1px solid var(--kasumi);
      border-radius: var(--radius-sm);
      cursor: pointer;
      input {
        width: auto;
        margin-top: 0.25rem;
      }
      &.on {
        border-color: var(--ai);
        background: var(--ai-soft);
      }
    }
    .block {
      display: block;
    }
    .inner {
      margin: 0;
    }
    .short {
      max-width: 8rem;
    }
    .check {
      display: flex;
      gap: 0.6rem;
      align-items: flex-start;
      font-size: var(--fs-14);
      input {
        width: auto;
        margin-top: 0.2rem;
      }
    }
  `,
})
export class ClaimForm {
  readonly sinDojo = $localize`:@@comun.sin-dojo:Sin dojo`;
  private api = inject(ApiService);
  private mut = inject(MutationService);
  readonly sent = output<Claim>();

  readonly relation = signal<ClaimRelation>('self');
  readonly q = signal('');
  readonly dojoId = signal<number | null>(null);
  readonly dojos = signal<Dojo[]>([]);
  readonly results = signal<ProfileSearchResult[] | null>(null);
  readonly selected = signal<ProfileSearchResult | null>(null);
  readonly last4 = signal('');
  readonly evidence = signal('');
  readonly consent = signal(false);
  readonly busy = signal(false);
  readonly searchError = signal('');

  constructor() {
    this.api.get<Dojo[]>('/dojos').subscribe({ next: (d) => this.dojos.set(d), error: () => {} });
  }

  async search(): Promise<void> {
    this.busy.set(true);
    this.searchError.set('');
    this.selected.set(null);
    try {
      this.results.set(
        await firstValueFrom(
          this.api.get<ProfileSearchResult[]>('/profiles/search', {
            q: this.q().trim(),
            dojo_id: this.dojoId(),
          }),
        ),
      );
    } catch (e) {
      this.searchError.set(ApiError.from(e).fullMessage);
    } finally {
      this.busy.set(false);
    }
  }

  async submit(sel: ProfileSearchResult): Promise<void> {
    this.busy.set(true);
    const body: Record<string, unknown> = {
      public_id: sel.public_id,
      relationship: this.relation(),
      evidence: this.evidence().trim(),
      consent: this.relation() !== 'self' && this.consent(),
    };
    if (this.last4().trim()) body['document_last4'] = this.last4().trim();
    const c = await this.mut.post<Claim>('/profile-claims', body, {
      success: $localize`:@@cuenta.reclamo.solicitud-enviada:Solicitud enviada`,
    });
    this.busy.set(false);
    if (c) {
      this.selected.set(null);
      this.results.set(null);
      this.q.set('');
      this.sent.emit(c);
    }
  }
}
