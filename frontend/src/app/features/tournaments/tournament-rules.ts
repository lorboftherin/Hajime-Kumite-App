import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { FORMAT_LABEL } from '../../core/format';
import { Tournament } from '../../core/models';
import { MutationService } from '../../core/mutation.service';
import { Modal } from '../../shared/modal';
import { LabelPipe } from '../../shared/pipes';
import { RulesForm, cleanRules, editableKata, kataPayload } from '../../shared/rules-form';
import { TournamentContext } from './tournament-context';
import { etiquetas } from '../../core/i18n/etiquetas';

const TIE_LABEL: Record<string, string> = etiquetas(() => ({
  hantei: 'Hantei',
  golden_point: $localize`:@@torneo.reglas.punto-oro:Punto de oro`,
  senshu_hantei: $localize`:@@torneo.reglas.senshu-hantei:Senshu y hantei`,
}));

/**
 * Reglas deportivas del torneo (docs/reglas-configurables.md): resumen y
 * formulario. Las categorías heredan estos valores salvo que los cambien.
 */
@Component({
  selector: 'app-tournament-rules',
  imports: [FormsModule, Modal, RulesForm, LabelPipe],
  template: `
    @if (ctx.tournament(); as t) {
      <section class="card rules">
        <div class="general-head">
          <div>
            <h3 i18n="@@torneo.reglas.reglas-deportivas">Reglas deportivas</h3>
            <p i18n="@@torneo.reglas.valen-para-todas-categorias-cada" class="small muted">
              Valen para todas las categorías; cada categoría puede cambiarlas.
            </p>
          </div>
          <button i18n="@@torneo.reglas.editar-reglas" class="btn sm" (click)="open(t)">Editar reglas</button>
        </div>
        <dl class="dl cols">
          <div>
            <dt i18n="@@torneo.reglas.edad">Edad</dt>
            <dd>
              <ng-container i18n="@@torneo.reglas.modo-edad">{t.age_mode, select, birth_year {Por año de nacimiento} other {A la fecha de referencia}}</ng-container>
            </dd>
          </div>
          <div>
            <dt i18n="@@torneo.reglas.formato-defecto">Formato por defecto</dt>
            <dd>{{ t.default_format | label: formatLabel }}</dd>
          </div>
          <div>
            <dt i18n="@@torneo.reglas.empate-kumite">Empate en kumite</dt>
            <dd>{{ tieText(t) }}</dd>
          </div>
          <div>
            <dt i18n="@@torneo.reglas.faltas">Faltas</dt>
            <dd>
              <ng-container i18n="@@torneo.reglas.escalera-faltas">{t.kumite_rules['sanction_preset'], select, two_categories {Dos categorías} other {Una escalera}}</ng-container>
            </dd>
          </div>
          <div>
            <dt i18n="@@torneo.reglas.kata">Kata</dt>
            <dd>{{ kataText(t) }}</dd>
          </div>
          <div>
            <dt i18n="@@torneo.reglas.desempate-round-robin">Desempate round robin</dt>
            <dd>{{ rrText(t) }}</dd>
          </div>
        </dl>
      </section>
    }

    @if (editing()) {
      <app-modal i18n-title="@@torneo.reglas.reglas-deportivas-torneo" title="Reglas deportivas del torneo" [wide]="true" (closed)="editing.set(false)">
        <form (ngSubmit)="save()" class="stack">
          <div class="grid-3">
            <label class="field">
              <span i18n="@@torneo.reglas.calculo-edad">Cálculo de la edad</span>
              <select name="am" [(ngModel)]="form.age_mode">
                <option i18n="@@torneo.reglas.edad-cumplida-fecha-referencia" value="date">Edad cumplida a la fecha de referencia</option>
                <option i18n="@@torneo.reglas.ano-nacimiento-ano-ano" value="birth_year">Por año de nacimiento (año − año de nacimiento)</option>
              </select>
            </label>
            <label class="field">
              <span i18n="@@torneo.reglas.formato-defecto">Formato por defecto</span>
              <select name="df" [(ngModel)]="form.default_format">
                <option i18n="@@torneo.reglas.eliminacion-directa" value="single_elimination">Eliminación directa</option>
                <option i18n="@@torneo.reglas.round-robin" value="round_robin">Round robin</option>
                <option i18n="@@torneo.reglas.grupos-eliminacion" value="groups_knockout">Grupos + eliminación</option>
              </select>
            </label>
          </div>
          <app-rules-form
            mode="tournament"
            [kumite]="kumite"
            [kata]="kata"
            [competition]="competition"
          />
          <p i18n="@@torneo.reglas.cambiar-edad-metodo-kata-no" class="small muted">
            Cambiar la edad o el método de kata no altera las llaves ya generadas; revisa las
            categorías en curso.
          </p>
          <div class="form-actions">
            <button i18n="@@torneo.reglas.cancelar" type="button" class="btn" (click)="editing.set(false)">Cancelar</button>
            <button i18n="@@torneo.reglas.guardar-reglas" class="btn primary" [disabled]="saving()">Guardar reglas</button>
          </div>
        </form>
      </app-modal>
    }
  `,
  styles: `
    .rules {
      margin-top: 1.25rem;
    }
    .general-head {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 1rem;
      margin-bottom: 0.75rem;
    }
  `,
})
export class TournamentRules {
  readonly ctx = inject(TournamentContext);
  private mut = inject(MutationService);
  readonly formatLabel = FORMAT_LABEL;
  readonly editing = signal(false);
  readonly saving = signal(false);

  form = { age_mode: 'date', default_format: 'single_elimination' };
  kumite: Record<string, any> = {};
  kata: Record<string, any> = {};
  competition: Record<string, any> = {};

  readonly tournament = computed(() => this.ctx.tournament());

  tieText(t: Tournament): string {
    const tie = (t.kumite_rules['tie_rule'] as string) ?? 'hantei';
    const gp = t.kumite_rules['golden_point_seconds'];
    return (TIE_LABEL[tie] ?? tie) + (tie === 'golden_point' ? ` (${gp ?? 60} s)` : '');
  }

  kataText(t: Tournament): string {
    const d = t.kata_defaults as Record<string, any>;
    if (d['preset'] === 'wkf') return 'Preset WKF';
    const method = d['method'] === 'scores' ? $localize`:@@torneo.reglas.puntuacion:Puntuación` : $localize`:@@torneo.reglas.banderas:Banderas`;
    const rounds =
      Array.isArray(d['rounds']) && d['rounds'].length ? $localize`:@@torneo.reglas.pasan: · pasan ${d['rounds'].join(' → ')}:join:` : '';
    return `${method}${rounds}`;
  }

  rrText(t: Tournament): string {
    const c = (t.competition_rules ?? {}) as Record<string, any>;
    const crit: string[] = c['round_robin_criteria'] ?? [
      'wins',
      'head_to_head',
      'diff',
      'points_for',
    ];
    const names: Record<string, string> = {
      wins: 'victorias',
      head_to_head: 'directo',
      diff: 'diferencia',
      points_for: 'puntos',
      fewer_sanctions: 'sanciones',
      draw: 'sorteo',
    };
    return crit.map((x) => names[x] ?? x).join(' → ');
  }

  open(t: Tournament): void {
    this.form = { age_mode: t.age_mode ?? 'date', default_format: t.default_format };
    this.kumite = { ...(t.kumite_rules ?? {}) };
    this.kata = editableKata(t.kata_defaults);
    this.competition = { ...(t.competition_rules ?? {}) };
    this.editing.set(true);
  }

  async save(): Promise<void> {
    const t = this.ctx.tournament();
    if (!t) return;
    this.saving.set(true);
    const res = await this.mut.patch<Tournament>(
      `/tournaments/${t.id}`,
      {
        version: t.version,
        age_mode: this.form.age_mode,
        default_format: this.form.default_format,
        kumite_rules: cleanRules(this.kumite) ?? {},
        kata_defaults: kataPayload(this.kata) ?? {},
        competition_rules: cleanRules(this.competition) ?? {},
      },
      { success: $localize`:@@torneo.reglas.reglas-guardadas:Reglas guardadas`, onConflict: () => this.ctx.reload() },
    );
    this.saving.set(false);
    if (res) {
      this.ctx.tournament.set(res);
      this.editing.set(false);
    }
  }
}
