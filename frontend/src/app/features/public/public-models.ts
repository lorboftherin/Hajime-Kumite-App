// Tipos del portal público que no usa el resto de la app (ver docs/portal-publico.md).
import { Color } from '../../core/models';

/** Próximo combate de un competidor (GET /public/…/people). */
export interface NextFight {
  tatami: number;
  tatami_name: string;
  number: string; // T2-014
  code: string;
  status: 'pending' | 'ready' | 'in_progress';
  /** Combates del tatami que faltan antes de este. */
  ahead: number;
  /** Hora estimada de inicio, ISO con la zona del torneo (o null si no hay de dónde estimar). */
  eta: string | null;
}

export type EntryState = 'fighting' | 'scheduled' | 'placed' | 'done' | 'waiting';

export interface PublicEntry {
  category_id: number;
  category: string;
  state: EntryState;
  place: number | null;
  next: NextFight | null;
}

export interface PublicCompetitor {
  /** Clave opaca y estable dentro del torneo (favoritos del dispositivo). */
  key: string;
  name: string;
  dojo: string;
  team: boolean;
  entries: PublicEntry[];
}

export interface PublicPeople {
  tournament: { name: string; slug: string | null; timezone: string };
  competitors: PublicCompetitor[];
  server_time: string;
}

export interface PublicSideLite {
  name: string;
  dojo: string;
}

export interface PublicBracketMatch {
  code: string;
  kind: string;
  round: number;
  position: number;
  status: string;
  aka: PublicSideLite | null;
  ao: PublicSideLite | null;
  score: [number, number];
  winner: Color | null;
  method: string | null;
}

export interface PublicCategory {
  tournament: { name: string; slug: string | null };
  category: { id: number; name: string; modality: string; status: string; is_team: boolean };
  format: string | null;
  matches: PublicBracketMatch[];
  podium: Array<{ place: number; name?: string; dojo?: string }>;
  standings: Array<{
    name?: string;
    dojo?: string;
    rank: number | null;
    wins: number | null;
    played: number | null;
    points_for: number | null;
    total: number | null;
    kata_name: string | null;
  }> | null;
  entrants: PublicSideLite[];
  server_time: string;
}

export interface DirectoryTournament {
  name: string;
  slug: string;
  start_date: string;
  end_date: string | null;
  venue: string;
  city: string;
  status: string;
}

export interface PublicDirectory {
  tournaments: {
    live: DirectoryTournament[];
    upcoming: DirectoryTournament[];
    recent: DirectoryTournament[];
  };
  today: string;
}
