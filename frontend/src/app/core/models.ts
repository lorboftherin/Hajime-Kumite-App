// Tipos de la API /api/v1 (ver backend/app/api/schemas.py). Solo datos: sin reglas de negocio.

export type Color = 'aka' | 'ao';
export type Sex = 'M' | 'F';

export interface Override {
  reason: string;
}

export interface RoleOut {
  id: number;
  role: 'organizer' | 'table_operator' | 'dojo_admin' | 'referee' | string;
  scope_type: 'global' | 'tournament' | 'dojo' | string;
  scope_id: number | null;
}

export interface RoleIn {
  role: 'organizer' | 'table_operator' | 'dojo_admin' | 'referee';
  scope_type: 'global' | 'tournament' | 'dojo';
  scope_id: number | null;
}

export interface User {
  id: number;
  username: string;
  display_name: string;
  is_admin: boolean;
  person_id: number | null;
  roles?: RoleOut[];
  /** Solo Admin y organizadores ven documentos y fecha de nacimiento. */
  can_view_documents?: boolean;
}

export interface TokenOut {
  access_token: string;
  token_type: string;
  user: User;
}

// --- Personas y dojos ---
export interface DocumentOut {
  id: number;
  doc_type: string;
  number: string;
}

export interface ConsentOut {
  id: number;
  given_by: string;
  relationship_to_person: string;
  given_on: string;
  medium: string;
  scope: string;
}

export interface ConsentIn {
  given_by: string;
  relationship_to_person: string;
  given_on: string;
  medium: string;
  scope: string;
}

export interface Person {
  id: number;
  first_names: string;
  last_names: string;
  /** null si el usuario no puede ver documentos (can_view_documents=false). */
  birth_date: string | null;
  sex: string;
  identity_incomplete: boolean;
  merged_into_id: number | null;
  anonymized_at?: string | null;
  version: number;
  /** Vacío si el usuario no puede ver documentos. */
  documents: DocumentOut[];
  consents?: ConsentOut[];
  current_dojo_id: number | null;
  current_grade: string | null;
}

export interface Branch {
  id: number;
  name: string;
}

export interface Dojo {
  id: number;
  name: string;
  short_name: string;
  city: string;
  is_claimed: boolean;
  is_independent: boolean;
  version: number;
  branches: Branch[];
}

export interface Duplicate {
  person_id: number;
  reason: string;
  score: number;
  full_name: string;
  birth_date: string | null;
}

// --- Plantillas y categorías ---
export interface CategoryFields {
  code: string;
  name: string;
  modality: 'kumite' | 'kata';
  is_team: boolean;
  sex: 'M' | 'F' | 'X';
  age_min: number | null;
  age_max: number | null;
  grade_min: number | null;
  grade_max: number | null;
  weight_class: string | null;
  format: 'single_elimination' | 'round_robin' | 'kata_rounds' | null;
  third_place_rule: 'two_bronzes' | 'third_place_match' | 'repechage' | null;
  duration_seconds: number | null;
  kumite_rules: Record<string, unknown> | null;
  kata_method: 'flags' | 'scores' | null;
  kata_structure: 'bracket' | 'rounds' | null;
  kata_judges: number | null;
  sort_order: number;
}

export interface TemplateItem extends CategoryFields {
  id: number;
}

export interface Template {
  id: number;
  name: string;
  description: string;
  version: number;
  items: TemplateItem[];
}

export interface Category extends CategoryFields {
  id: number;
  tournament_id: number;
  status: string;
  tatami_id: number | null;
  queue_position: number | null;
  merged_into_id: number | null;
  cancel_reason: string | null;
  is_manual: boolean;
  version: number;
  entrant_count: number;
  advice: string[];
}

// --- Torneos ---
export interface Tatami {
  id: number;
  number: number;
  name: string;
}

export interface Tournament {
  id: number;
  name: string;
  start_date: string;
  end_date: string | null;
  venue: string;
  city: string;
  status: string;
  is_test: boolean;
  age_reference_date: string;
  default_format: string;
  default_third_place_rule: string;
  kumite_rules: Record<string, unknown>;
  kata_defaults: Record<string, unknown>;
  template_id: number | null;
  version: number;
  tatamis: Tatami[];
}

// --- Inscripciones ---
export interface Registration {
  id: number;
  tournament_id: number;
  category_id: number;
  original_category_id: number;
  person_id: number | null;
  dojo_id: number;
  branch_id: number | null;
  grade: string | null;
  weight_class: string | null;
  age_at_reference: number | null;
  status: string;
  withdrawn_reason: string | null;
  seed: number | null;
  version: number;
  person_name: string;
  dojo_name: string;
}

export interface Suggestion {
  category_id: number;
  name: string;
  modality: string;
}

export interface WithdrawResult {
  registration_id: number;
  options: string[];
  pending_match_ids: number[];
}

// --- Importación ---
export interface ImportRow {
  id: number;
  row_number: number;
  data: Record<string, any>;
  status: 'new' | 'duplicate' | 'error' | string;
  errors: string[];
  duplicates: Array<Record<string, any>>;
  suggested_category_ids: number[];
  resolution: Record<string, any> | null;
}

export interface ImportBatch {
  id: number;
  tournament_id: number;
  filename: string;
  status: string;
  rows: ImportRow[];
}

// --- Llaves y combates ---
export interface Participant {
  registration_id: number;
  name: string;
  dojo_id: number;
  dojo_name: string;
}

export interface Match {
  id: number;
  category_id: number;
  code: string;
  kind: string;
  round: number;
  position: number;
  aka_source: string;
  ao_source: string;
  aka_registration_id: number | null;
  ao_registration_id: number | null;
  status: string;
  winner_registration_id: number | null;
  method: string | null;
  aka_score: number | null;
  ao_score: number | null;
  started_at: string | null;
  finished_at: string | null;
  version: number;
}

export interface Bracket {
  id: number;
  category_id: number;
  version: number;
  version_number: number;
  format: string;
  third_place_rule: string;
  seed: number;
  size: number;
  slots: Array<number | null>;
  same_dojo_first_round: number;
  participants: Record<string, Participant>;
  matches: Match[];
  podium: { places?: Array<{ place: number; registration_id: number }>; complete?: boolean };
  standings: Array<Record<string, any>> | null;
}

export interface BracketVersion {
  id: number;
  number: number;
  format: string;
  seed: number;
  slots: Array<number | null>;
  reason: string | null;
  created_at: string;
  current: boolean;
}

export interface MatchEvent {
  id: string;
  type: string;
  color: string | null;
  value: number | null;
  target_id: string | null;
  method: string | null;
  reason: string | null;
  device_at: string;
  received_at: string;
}

export interface EventIn {
  id: string;
  type: string;
  at: string;
  color?: Color | null;
  value?: number | null;
  target_id?: string | null;
  reason?: string | null;
  /** Requerido (motivo) para tocar un combate ya cerrado: 409 WARNINGS MATCH_FINISHED. */
  override?: Override | null;
}

export interface ScoreboardRules {
  time_mode?: 'effective' | 'running' | string;
  auto_pause_on_point?: boolean;
  tie_rule?: string;
  lead_victory?: number | null;
  point_values?: number[];
}

export interface Scoreboard {
  match: Match;
  /** Reglas efectivas del combate (tiempo efectivo/corrido, pausa automática por punto…). */
  rules?: ScoreboardRules;
  score: Record<Color, number>;
  sanction: Record<Color, number>;
  sanction_labels: string[];
  senshu: Color | null;
  elapsed_seconds: number;
  duration_seconds: number;
  running: boolean;
  started: boolean;
  winner: Color | null;
  method: string | null;
  suggestion: { winner: Color | null; method: string | null; needs: string | null; reason: string | null };
  events: MatchEvent[];
  annulled_event_ids: string[];
  aka: Participant | null;
  ao: Participant | null;
}

export interface FinishOut {
  scoreboard: Scoreboard;
  affected_matches: string[];
}

export interface QueueItem {
  category_id: number;
  category_name: string;
  match: Match;
}

export interface TatamiQueue {
  tatami: { id: number; name: string; number: number };
  current: QueueItem | null;
  queue: QueueItem[];
  participants: Record<string, Participant>;
  conflicts: Array<{ registration_id: number; name: string }>;
}

// --- Resultados ---
export interface CategoryResult {
  category_id: number;
  category_name: string;
  status: string;
  merged_into_id: number | null;
  places: Array<{ place: number; registration_id: number; name: string; dojo_id: number; dojo_name: string }>;
}

export interface MedalRow {
  dojo_id: number;
  dojo_name: string;
  gold: number;
  silver: number;
  bronze: number;
  total: number;
  rank: number;
}

export interface MedalTable {
  tournament_id: number;
  is_test: boolean;
  rows: MedalRow[];
}

export interface ComparisonItem {
  match_id: number;
  category_id: number;
  category_name: string;
  code: string;
  app_winner_registration_id: number | null;
  app_score: [number | null, number | null];
  official_winner_registration_id: number | null;
  official_score: [number | null, number | null];
  winner_matches: boolean | null;
  score_matches: boolean | null;
  finding: string | null;
  error_source: string | null;
}

export interface ComparisonReport {
  tournament_id: number;
  matches: number;
  compared: number;
  winner_agreement_pct: number | null;
  differences: ComparisonItem[];
  items: ComparisonItem[];
}

export interface AuditEntry {
  id: number;
  at: string;
  user: string | null;
  entity: string;
  entity_id: string;
  action: string;
  before: unknown;
  after: unknown;
  reason: string | null;
}
