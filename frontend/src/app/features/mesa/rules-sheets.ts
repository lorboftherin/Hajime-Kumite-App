import { Component, OnInit, input, output, signal } from '@angular/core';
import { Color } from '../../core/models';

/**
 * Tipo de falta (preset «dos categorías»): la mesa elige qué falta se sanciona
 * y así la sanción va a su escalera (categoría 1: contacto; 2: el resto).
 */
@Component({
  selector: 'app-infraction-sheet',
  template: `
    <div class="sheet-backdrop" (click)="onBackdrop($event)">
      <div class="rsheet" role="dialog" aria-modal="true" aria-label="Tipo de falta">
        <h3>{{ label() }} a {{ color() === 'aka' ? 'AKA' : 'AO' }}: ¿qué falta?</h3>
        <div class="opts">
          @for (it of items(); track it.key) {
            <button class="opt" (click)="pick(it.key, it.ladder)">
              <b>{{ it.label }}</b>
              <small>{{
                it.ladder === 'c1'
                  ? 'Categoría 1'
                  : it.ladder === 'c2'
                    ? 'Categoría 2'
                    : 'Elige la categoría'
              }}</small>
            </button>
          }
        </div>
        @if (pendingOther()) {
          <div class="opts two">
            <button class="opt" (click)="done('other', 'c1')">
              <b>Categoría 1</b><small>Contacto</small>
            </button>
            <button class="opt" (click)="done('other', 'c2')">
              <b>Categoría 2</b><small>Resto de faltas</small>
            </button>
          </div>
        }
        <div class="acts">
          <button class="qbtn" (click)="closed.emit()">Cancelar</button>
        </div>
      </div>
    </div>
  `,
  styleUrl: './rules-sheets.scss',
})
export class InfractionSheet {
  readonly color = input.required<Color>();
  readonly label = input('Sanción');
  readonly infractions = input.required<Record<string, { label: string; ladder: string | null }>>();
  readonly picked = output<{ infraction: string; ladder: 'c1' | 'c2' }>();
  readonly closed = output<void>();
  readonly pendingOther = signal(false);

  items(): Array<{ key: string; label: string; ladder: string | null }> {
    return Object.entries(this.infractions()).map(([key, v]) => ({ key, ...v }));
  }

  pick(key: string, ladder: string | null): void {
    if (!ladder) {
      this.pendingOther.set(true);
      return;
    }
    this.done(key, ladder as 'c1' | 'c2');
  }

  done(infraction: string, ladder: 'c1' | 'c2'): void {
    this.picked.emit({ infraction, ladder });
  }

  onBackdrop(ev: MouseEvent): void {
    if (ev.target === ev.currentTarget) this.closed.emit();
  }
}

/**
 * Hantei (decisión de jueces): ganador y, opcionalmente, el voto de cada juez
 * (solo registro). Si se cargan votos, el ganador es el de la mayoría.
 */
@Component({
  selector: 'app-hantei-sheet',
  template: `
    <div class="sheet-backdrop" (click)="onBackdrop($event)">
      <div class="rsheet" role="dialog" aria-modal="true" aria-label="Hantei">
        <h3>Hantei: decisión de los jueces</h3>
        <div class="opts two">
          <button class="opt aka" [class.on]="winner() === 'aka'" (click)="winner.set('aka')">
            <b>Gana AKA</b>
          </button>
          <button class="opt ao" [class.on]="winner() === 'ao'" (click)="winner.set('ao')">
            <b>Gana AO</b>
          </button>
        </div>
        <label class="withvotes">
          <input type="checkbox" [checked]="withVotes()" (change)="withVotes.set(!withVotes())" />
          Registrar el voto de cada juez (opcional)
        </label>
        @if (withVotes()) {
          <div class="jcount">
            @for (n of [3, 5]; track n) {
              <button class="qbtn" [class.primary]="votes().length === n" (click)="setJudges(n)">
                {{ n }} jueces
              </button>
            }
          </div>
          <div class="votes">
            @for (v of votes(); track $index; let i = $index) {
              <div class="vrow">
                <span>Juez {{ i + 1 }}</span>
                <button class="flag aka" [class.on]="v === 'aka'" (click)="vote(i, 'aka')">
                  AKA
                </button>
                <button class="flag ao" [class.on]="v === 'ao'" (click)="vote(i, 'ao')">AO</button>
              </div>
            }
          </div>
          @if (mismatch()) {
            <p class="warn">La mayoría de los votos no coincide con el ganador elegido.</p>
          }
        }
        <div class="acts">
          <button class="qbtn" (click)="closed.emit()">Cancelar</button>
          <button class="qbtn primary" [disabled]="!winner() || mismatch()" (click)="submit()">
            Registrar hantei
          </button>
        </div>
      </div>
    </div>
  `,
  styleUrl: './rules-sheets.scss',
})
export class HanteiSheet implements OnInit {
  readonly initial = input<Color | null>(null);
  readonly done = output<{ color: Color; votes: Array<Color | null> | null }>();
  readonly closed = output<void>();
  readonly winner = signal<Color | null>(null);
  readonly withVotes = signal(false);
  readonly votes = signal<Array<Color | null>>([null, null, null]);

  ngOnInit(): void {
    this.winner.set(this.initial());
  }

  setJudges(n: number): void {
    this.votes.set(Array.from({ length: n }, (_, i) => this.votes()[i] ?? null));
  }

  vote(i: number, c: Color): void {
    this.votes.update((v) => v.map((x, j) => (j === i ? (x === c ? null : c) : x)));
    const aka = this.votes().filter((x) => x === 'aka').length;
    const ao = this.votes().filter((x) => x === 'ao').length;
    if (aka !== ao) this.winner.set(aka > ao ? 'aka' : 'ao');
  }

  mismatch(): boolean {
    if (!this.withVotes()) return false;
    const aka = this.votes().filter((x) => x === 'aka').length;
    const ao = this.votes().filter((x) => x === 'ao').length;
    return aka !== ao && this.winner() !== (aka > ao ? 'aka' : 'ao');
  }

  submit(): void {
    const w = this.winner();
    if (!w) return;
    const votes = this.withVotes() && this.votes().some((x) => x) ? this.votes() : null;
    this.done.emit({ color: w, votes });
  }

  onBackdrop(ev: MouseEvent): void {
    if (ev.target === ev.currentTarget) this.closed.emit();
  }
}
