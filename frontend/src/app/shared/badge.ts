import { Component, computed, input } from '@angular/core';
import {
  CATEGORY_STATUS,
  IMPORT_ROW_STATUS,
  MATCH_STATUS,
  REGISTRATION_STATUS,
  TOURNAMENT_STATUS,
  statusTone,
} from '../core/format';

const MAPS: Record<string, Record<string, string>> = {
  tournament: TOURNAMENT_STATUS,
  category: CATEGORY_STATUS,
  match: MATCH_STATUS,
  registration: REGISTRATION_STATUS,
  import: IMPORT_ROW_STATUS,
};

@Component({
  selector: 'app-status',
  template: `<span class="badge {{ tone() }}">{{ label() }}</span>`,
})
export class StatusBadge {
  readonly status = input.required<string>();
  readonly type = input<'tournament' | 'category' | 'match' | 'registration' | 'import'>('category');
  readonly label = computed(() => MAPS[this.type()]?.[this.status()] ?? this.status());
  readonly tone = computed(() => statusTone(this.status()));
}
