// Cuentas de competidor: correo, reclamo de perfiles y perfil público (docs/cuentas-y-correo.md).

/** Resultado de la búsqueda para reclamar: solo lo público (nunca documento ni fecha de nacimiento). */
export interface ProfileSearchResult {
  public_id: string;
  name: string;
  dojo: string | null;
  tournaments: string[];
  tournament_count: number;
}

export type ClaimRelation = 'self' | 'parent' | 'guardian';
export type ClaimStatus = 'pending' | 'approved' | 'rejected';

export interface Claim {
  id: number;
  status: ClaimStatus;
  relationship: ClaimRelation;
  created_at: string;
  reviewed_at: string | null;
  reason: string | null;
  public_id: string | null;
  person_name: string;
  dojo: string | null;
}

/** Lo que ve quien revisa (dojo, organizador o Admin). */
export interface ClaimReview extends Claim {
  person_id: number;
  user_id: number;
  user_name: string;
  user_email: string | null;
  evidence: string;
  document_match: boolean | null;
  is_minor: boolean;
  birth_date: string | null;
}

/** Perfil ligado a la cuenta: el propio o el de un menor a cargo. */
export interface MyProfile {
  person_id: number;
  public_id: string | null;
  name: string;
  relationship: ClaimRelation;
  dojo: string | null;
  guardianship_id: number | null;
}

export interface PublicProfileEntry {
  tournament_name: string;
  date: string;
  category_name: string;
  team_name: string | null;
  dojo_name: string | null;
  place: number | null;
}

/** GET /public/persons/{public_id}: sin documento, fecha de nacimiento ni contacto. */
export interface PublicProfile {
  public_id: string;
  name: string;
  dojo: string | null;
  medals: { gold: number; silver: number; bronze: number };
  tournament_count: number;
  tournaments: PublicProfileEntry[];
}

export const RELATION_LABEL: Record<ClaimRelation, string> = {
  self: 'Mi perfil',
  parent: 'Padre o madre',
  guardian: 'Apoderado',
};

export const CLAIM_STATUS_LABEL: Record<ClaimStatus, string> = {
  pending: 'Pendiente',
  approved: 'Aprobada',
  rejected: 'No aprobada',
};

/** Lee el token de un enlace de correo (`…#<token>`); acepta también `?token=`. */
export function tokenFromUrl(fragment: string | null, query: string | null): string {
  const raw = (fragment ?? '').replace(/^token=/, '') || query || '';
  return /^[A-Za-z0-9_-]{20,200}$/.test(raw) ? raw : '';
}
