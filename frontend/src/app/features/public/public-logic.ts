// Lógica pura del portal público (buscador, favoritos, textos): probada en public-logic.spec.ts.
import { localeActual } from '../../core/i18n/idioma';
import { NextFight, PublicBracketMatch, PublicCompetitor, PublicEntry } from './public-models';
import { etiquetas } from '../../core/i18n/etiquetas';

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
  const where = n.tatami_name || $localize`:@@publico.tatami:Tatami ${n.tatami}:tatami:`;
  if (n.kata_round) {
    const turn = n.turn
      ? $localize`:@@publico.ronda-turno:ronda ${n.kata_round}:ronda:, turno ${n.turn}:turno:`
      : $localize`:@@publico.ronda-kata:ronda ${n.kata_round}:ronda:`;
    if (n.ahead === 0) return $localize`:@@publico.siguiente-salir:Es el siguiente en salir en ${where}:where: (${turn}:turn:)${eta}:eta:`;
    if (n.ahead === 1) return $localize`:@@publico.sale-falta-1-turno:Sale en ${where}:where: (${turn}:turn:), falta 1 turno${eta}:eta:`;
    return $localize`:@@publico.sale-faltan-turnos:Sale en ${where}:where: (${turn}:turn:), faltan ${n.ahead}:faltan: turnos${eta}:eta:`;
  }
  if (n.status === 'in_progress') return $localize`:@@publico.peleando-ahora-combate:Peleando ahora en ${where}:where:, combate ${n.number}:number:`;
  const rival = n.status === 'pending' ? $localize`:@@publico.rival-definir:, rival por definir` : '';
  if (n.ahead === 0) return $localize`:@@publico.siguiente-combate:Es el siguiente en ${where}:where:, combate ${n.number}:number:${rival}:rival:${eta}:eta:`;
  if (n.ahead === 1)
    return $localize`:@@publico.pelea-falta-1-combate:Pelea en ${where}:where:, combate ${n.number}:number:, falta 1 combate${rival}:rival:${eta}:eta:`;
  return $localize`:@@publico.pelea-faltan-combates:Pelea en ${where}:where:, combate ${n.number}:number:, faltan ${n.ahead}:faltan: combates${rival}:rival:${eta}:eta:`;
}

const PLACE: Record<number, string> = etiquetas(() => ({
  1: $localize`:@@medalla.oro:Oro`,
  2: $localize`:@@medalla.plata:Plata`,
  3: $localize`:@@medalla.bronce:Bronce`,
}));

export function entryText(e: PublicEntry, timeZone?: string): string {
  switch (e.state) {
    case 'fighting':
    case 'scheduled':
      return e.next ? fightText(e.next, timeZone) : '';
    case 'placed':
      return e.place && PLACE[e.place]
        ? $localize`:@@publico.medalla-puesto:${PLACE[e.place]}:medalla: (${e.place}:puesto:.º puesto)`
        : $localize`:@@formato.puesto-n:${e.place}:puesto:.º puesto`;
    case 'done':
      return $localize`:@@publico.categoria-terminada:Categoría terminada`;
    default:
      return $localize`:@@publico.sin-combate-programado-ahora:Sin combate programado por ahora`;
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
  if (d === 0) return $localize`:@@publico.final:Final`;
  if (d === 1) return $localize`:@@publico.semifinal:Semifinal`;
  if (d === 2) return $localize`:@@publico.cuartos-final:Cuartos de final`;
  if (d === 3) return $localize`:@@publico.octavos-final:Octavos de final`;
  return $localize`:@@publico.ronda:Ronda ${round}:round:`;
}

export const KIND_LABEL: Record<string, string> = etiquetas(() => ({
  third_place: $localize`:@@publico.combate-3-er-puesto:Combate por el 3.er puesto`,
  repechage: $localize`:@@publico.repechaje:Repechaje`,
  round_robin: $localize`:@@publico.todos-contra-todos:Todos contra todos`,
}));

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
