// Lógica pura del portal público (buscador, favoritos, textos): probada en public-logic.spec.ts.
import { plural } from '../../shared/plural';
import { localeActual } from '../../core/i18n/idioma';
import { NextFight, PublicBracketMatch, PublicCompetitor, PublicEntry } from './public-models';

/** Minúsculas y sin tildes: «Huamán» se encuentra escribiendo «huaman». */
export function fold(s: string): string {
  return (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/** Todas las palabras de la búsqueda deben aparecer en el nombre o el dojo. */
export function matchesQuery(text: string, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  const hay = fold(text);
  return words.every((w) => hay.includes(w));
}

export function searchCompetitors(
  list: PublicCompetitor[],
  query: string,
  limit = 30,
): PublicCompetitor[] {
  if (fold(query).length < 2) return [];
  return list.filter((c) => matchesQuery(`${c.name} ${c.dojo}`, query)).slice(0, limit);
}

/** Hora local del torneo («11:40»). */
export function hourText(iso: string | null | undefined, timeZone = 'America/Lima'): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(localeActual(), {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone,
    }).format(d);
  } catch {
    return new Intl.DateTimeFormat(localeActual(), {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(d);
  }
}

/**
 * Zona para mostrar una hora ISO en la hora del torneo aunque el dispositivo
 * esté en otra: «…-05:00» → «Etc/GMT+5». Sin desfase (o con minutos), Lima.
 */
export function zoneOfIso(iso: string | null | undefined): string {
  const m = iso?.match(/([+-])(\d\d):(\d\d)$/);
  if (!m || m[3] !== '00') return 'America/Lima';
  const h = Number(m[2]);
  return h === 0 ? 'UTC' : `Etc/GMT${m[1] === '-' ? '+' : '-'}${h}`;
}

/** «Pelea en Tatami 2, combate T2-014, faltan 3 combates (≈ 11:40)». */
export function fightText(n: NextFight, timeZone?: string): string {
  const eta = n.eta ? ` (≈ ${hourText(n.eta, timeZone)})` : '';
  const where = n.tatami_name || `Tatami ${n.tatami}`;
  if (n.kata_round) {
    const turn = `ronda ${n.kata_round}${n.turn ? `, turno ${n.turn}` : ''}`;
    if (n.ahead === 0) return `Es el siguiente en salir en ${where} (${turn})${eta}`;
    return `Sale en ${where} (${turn}), ${n.ahead === 1 ? 'falta 1 turno' : `faltan ${plural(n.ahead, 'turno', 'turnos')}`}${eta}`;
  }
  if (n.status === 'in_progress') return `Peleando ahora en ${where}, combate ${n.number}`;
  const rival = n.status === 'pending' ? ', rival por definir' : '';
  if (n.ahead === 0) return `Es el siguiente en ${where}, combate ${n.number}${rival}${eta}`;
  return `Pelea en ${where}, combate ${n.number}, ${n.ahead === 1 ? 'falta 1 combate' : `faltan ${plural(n.ahead, 'combate', 'combates')}`}${rival}${eta}`;
}

const PLACE: Record<number, string> = { 1: 'Oro', 2: 'Plata', 3: 'Bronce' };

export function entryText(e: PublicEntry, timeZone?: string): string {
  switch (e.state) {
    case 'fighting':
    case 'scheduled':
      return e.next ? fightText(e.next, timeZone) : '';
    case 'placed':
      return e.place && PLACE[e.place]
        ? `${PLACE[e.place]} (${e.place}.º puesto)`
        : `${e.place}.º puesto`;
    case 'done':
      return 'Categoría terminada';
    default:
      return 'Sin combate programado por ahora';
  }
}

// --- Favoritos en el dispositivo (localStorage; sin almacenamiento, en memoria) ---

const FAV_PREFIX = 'hajime.favoritos.';

export function loadFavorites(ref: string): Set<string> {
  try {
    const raw = localStorage.getItem(FAV_PREFIX + ref);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(arr) ? arr.filter((x) => typeof x === 'string').slice(0, 200) : [],
    );
  } catch {
    return new Set();
  }
}

export function saveFavorites(ref: string, keys: Set<string>): void {
  try {
    localStorage.setItem(FAV_PREFIX + ref, JSON.stringify([...keys]));
  } catch {
    /* modo privado o almacenamiento lleno: quedan solo en esta pestaña */
  }
}

export function toggleFavorite(keys: Set<string>, key: string): Set<string> {
  const next = new Set(keys);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

// --- Llave ---

/** «Final», «Semifinal», «Cuartos de final» o «Ronda N» según la distancia a la final. */
export function roundLabel(round: number, finalRound: number): string {
  const d = finalRound - round;
  if (d === 0) return 'Final';
  if (d === 1) return 'Semifinal';
  if (d === 2) return 'Cuartos de final';
  if (d === 3) return 'Octavos de final';
  return `Ronda ${round}`;
}

export const KIND_LABEL: Record<string, string> = {
  third_place: 'Combate por el 3.er puesto',
  repechage: 'Repechaje',
  round_robin: 'Todos contra todos',
};

/** Rondas de la llave principal, en orden, con sus combates por posición. */
export function bracketRounds(
  matches: PublicBracketMatch[],
): Array<{ round: number; label: string; matches: PublicBracketMatch[] }> {
  const main = matches.filter((m) => m.kind === 'main');
  if (!main.length) return [];
  const finalRound = Math.max(...main.map((m) => m.round));
  const rounds = [...new Set(main.map((m) => m.round))].sort((a, b) => a - b);
  return rounds.map((round) => ({
    round,
    label: roundLabel(round, finalRound),
    matches: main.filter((m) => m.round === round).sort((a, b) => a.position - b.position),
  }));
}
