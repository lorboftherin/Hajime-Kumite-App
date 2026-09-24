import { Component, computed, input } from '@angular/core';
import { CATEGORY_STATUS, IMPORT_ROW_STATUS, MATCH_STATUS, REGISTRATION_STATUS, TOURNAMENT_STATUS } from '../core/format';

const MAPS: Record<string, Record<string, string>> = {
  tournament: TOURNAMENT_STATUS,
  category: CATEGORY_STATUS,
  match: MATCH_STATUS,
  registration: REGISTRATION_STATUS,
  import: IMPORT_ROW_STATUS,
};

/**
 * Color del punto por estado (docs/diseno.md): en curso = matcha, lista = ai,
 * finalizada = sumi, cancelada/fusionada = nezumi, advertencia = yamabuki, error = shu.
 * «hollow» (aro) marca estados que aún esperan algo (borrador, abierta, pendiente).
 */
const TONE: Record<string, string> = {
  in_progress: 'matcha live',
  active: 'matcha',
  new: 'matcha',
  ready: 'ai',
  registration_open: 'ai',
  registration_closed: 'ai hollow',
  open: 'ai hollow',
  finished: 'sumi',
  draft: 'nezumi hollow',
  pending: 'nezumi hollow',
  empty: 'nezumi hollow',
  merged: 'nezumi',
  cancelled: 'nezumi',
  withdrawn: 'nezumi',
  bye: 'nezumi',
  void: 'nezumi',
  needs_review: 'yamabuki',
  duplicate: 'yamabuki',
  error: 'shu',
};

@Component({
  selector: 'app-status',
  template: `<span class="badge {{ tone() }}">{{ label() }}</span>`,
})
export class StatusBadge {
  readonly status = input.required<string>();
  readonly type = input<'tournament' | 'category' | 'match' | 'registration' | 'import'>('category');
  readonly label = computed(() => MAPS[this.type()]?.[this.status()] ?? this.status());
  readonly tone = computed(() => TONE[this.status()] ?? 'nezumi');
}
