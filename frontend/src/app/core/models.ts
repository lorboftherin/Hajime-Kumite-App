// Tipos de la API /api/v1 (ver backend/app/api/schemas.py). Solo datos: sin reglas de negocio.

export type Color = 'aka' | 'ao';
export type Sex = 'M' | 'F';

export interface Override {
  reason: string;
}

export interface Suggestion {
  winner: Color | null;
  method: string | null;
  needs: string | null;
  reason: string | null;
}

export interface RoleOut {
  id: number;
  role: 'organizer' | 'table_operator' | 'dojo_admin' | 'referee' | string;
  scope_type: 'global' | 'tournament' | 'dojo' | string;
  scope_id: number | null;
}

export interface RoleIn {
  role: 'organizer' | 'table_operator' | 'dojo_admin' | 'referee' | 'sensei';
  scope_type: 'global' | 'organization' | 'tournament' | 'dojo' | 'tatami';
  scope_id: number | null;
}

/** Organización de la que la cuenta es miembro (GET /auth/me). */
export interface UserOrganization {
  id: number;
  name: string;
  slug: string;
  role: OrgRole;
}

export interface User {
  id: number;
  username: string;
  display_name: string;
  is_admin: boolean;
  /** false = cuenta desactivada por el Admin (no puede ingresar). */
  is_active?: boolean;
  /** true = la contraseña la asignó el Admin: debe cambiarla antes de usar la app. */
  must_change_password?: boolean;
  person_id: number | null;
  roles?: RoleOut[];
  /** Solo Admin y organizadores ven documentos y fecha de nacimiento. */
  can_view_documents?: boolean;
  /** Correo de la cuenta (recuperar la contraseña, avisos). */
  email?: string | null;
  /** null = el correo aún no se confirmó con el enlace. */
  email_verified_at?: string | null;
  /** Organizaciones de la cuenta con su rol. */
  organizations?: UserOrganization[];
  /** Dojos que administra (rol dojo_admin): «Mis competidores». */
  dojo_admin_of?: number[];
}

export interface TokenOut {
  access_token: string;
  token_type: string;
  /** Token opaco para renovar el de acceso sin pedir la contraseña (se rota en cada uso). */
  refresh_token?: string | null;
  /** Segundos de vida del token de acceso. */
  expires_in?: number | null;
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
  format: 'single_elimination' | 'round_robin' | 'kata_rounds' | 'groups_knockout' | null;
  third_place_rule: 'two_bronzes' | 'third_place_match' | 'repechage' | null;
  duration_seconds: number | null;
  kumite_rules: Record<string, unknown> | null;
  kata_method: 'flags' | 'scores' | null;
  kata_structure: 'bracket' | 'rounds' | null;
  kata_judges: number | null;
  sort_order: number;
  /** Cupo: al superarlo se advierte y se sugiere dividir. */
  max_entrants?: number | null;
  weight_min_kg?: number | null;
  weight_max_kg?: number | null;
  /** Overrides de la categoría (docs/reglas-configurables.md). */
  kata_rules?: Record<string, unknown> | null;
  competition_rules?: Record<string, unknown> | null;
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
  /** Categoría de la que salió al dividir. */
  split_from_id?: number | null;
  /** Tiene divisiones activas (se pueden deshacer). */
  has_split?: boolean;
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
  competition_rules?: Record<string, unknown> | null;
  /** Edad: a la fecha de referencia (date) o por año de nacimiento (birth_year). */
  age_mode?: 'date' | 'birth_year';
  template_id: number | null;
  version: number;
  tatamis: Tatami[];
  /** Enlace secreto del seguimiento en vivo público (null = desactivado). */
  public_token?: string | null;
  public_names?: 'short' | 'full';
  organization_id?: number;
  organization_name?: string;
  /** Autoinscripción por dojo abierta (y hasta cuándo, en UTC). */
  self_registration_open?: boolean;
  self_registration_closes_at?: string | null;
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
  /** Autoinscripción: motivo del rechazo y cuenta que la pidió. */
  rejection_reason?: string | null;
  requested_by_id?: number | null;
  seed: number | null;
  version: number;
  /** Nombre de la persona o, en categorías por equipos, del equipo. */
  person_name: string;
  dojo_name: string;
  team_id?: number | null;
  team_version?: number | null;
  team_members?: TeamMember[];
}

export interface TeamMember {
  person_id: number;
  name: string;
  role: 'starter' | 'substitute';
}

/** Enfrentamiento de kumite por equipos (GET /matches/{id}/team). */
export interface TeamSide {
  registration_id: number;
  team_id: number | null;
  name: string;
  dojo_name: string;
  members: TeamMember[];
}

export interface TeamBout {
  match: Match;
  is_extra: boolean;
  aka_person_id: number | null;
  aka_name: string | null;
  ao_person_id: number | null;
  ao_name: string | null;
}

export interface TeamDecision {
  winner: Color | null;
  method: string | null;
  wins: Record<Color, number>;
  points: Record<Color, number>;
  draws: number;
  needs_extra_bout: boolean;
  /** Combate extra empatado con la regla «hantei»: se corrige con la decisión de jueces. */
  extra_bout_needs_hantei?: boolean;
  pending_bouts: number;
  reason: string | null;
}

export interface TeamMatch {
  match: Match;
  category_id: number;
  category_name: string;
  settings: {
    bouts: number;
    tie_rule: 'points' | 'extra_bout';
    extra_bout_tie?: 'hantei' | 'repeat';
    empty_slot_walkover?: boolean;
    lock_order?: boolean;
    min_starters?: number | null;
  };
  aka: TeamSide | null;
  ao: TeamSide | null;
  bouts: TeamBout[];
  decision: TeamDecision;
}

/** Combate individual dentro de un enfrentamiento por equipos. */
export interface BoutInfo {
  parent_match_id: number;
  parent_code: string;
  bout_number: number;
  is_extra: boolean;
  aka_team: string | null;
  ao_team: string | null;
  wins: Record<Color, number>;
  team_winner: Color | null;
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
  parent_match_id?: number | null;
  bout_number?: number | null;
  aka_person_id?: number | null;
  ao_person_id?: number | null;
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
  /** Grupos + eliminación: tabla de cada grupo. */
  groups?: Array<{ letter: string; standings: Array<Record<string, any>> }> | null;
  /** Rondas de kata: ronda en curso, cortes y detalle de cada ronda. */
  kata_rounds?: KataRounds | null;
}

export interface KataRounds {
  current: number;
  total: number;
  cuts: number[];
  needs_review: boolean;
  rounds: Array<{
    round: number;
    complete: boolean;
    qualified: number[];
    cut_tied: boolean;
    standings: Array<Record<string, any>>;
  }>;
}

/** Resultado de añadir o quitar a alguien de una llave ya generada. */
export interface BracketChange {
  result: { mode: string; position?: number; match?: string; matches_added?: number; matches_voided?: number };
  bracket: Bracket;
}

/** Valores por defecto de las reglas configurables (GET /rules/defaults). */
export interface RulesDefaults {
  kumite: Record<string, any>;
  kata: Record<string, any>;
  competition: Record<string, any>;
  round_robin_criteria: string[];
  infractions: Record<string, { label: string; ladder: string | null }>;
  age_modes: string[];
}

export interface KataCatalog {
  styles: Array<{ style: string; katas: string[] }>;
  katas: string[];
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
  infraction?: string | null;
  ladder?: string | null;
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
  /** Sanción: tipo de falta y escalera (preset de dos categorías). */
  infraction?: string | null;
  ladder?: 'c1' | 'c2' | null;
  /** Hantei: votos de los jueces (opcional). */
  votes?: Array<Color | null> | null;
  /** Requerido (motivo) para tocar un combate ya cerrado: 409 WARNINGS MATCH_FINISHED. */
  override?: Override | null;
}

export interface ScoreboardRules {
  time_mode?: 'effective' | 'running' | string;
  auto_pause_on_point?: boolean;
  tie_rule?: string;
  lead_victory?: number | null;
  point_values?: number[];
  sanction_preset?: 'single' | 'two_categories' | string;
  senshu_auto_loss?: boolean;
  golden_point_seconds?: number;
}

export interface Scoreboard {
  match: Match;
  /** Reglas efectivas del combate (tiempo efectivo/corrido, pausa automática por punto…). */
  rules?: ScoreboardRules;
  score: Record<Color, number>;
  sanction: Record<Color, number>;
  sanction_labels: string[];
  /** Segunda escalera (preset de dos categorías) y tipos de falta. */
  sanction_c2?: Record<Color, number> | null;
  sanction_labels_c2?: string[] | null;
  infractions?: Record<string, { label: string; ladder: string | null }> | null;
  senshu: Color | null;
  senshu_lost?: Color[];
  /** Punto de oro: periodo extra en curso y duración total del periodo. */
  golden_point?: boolean;
  period_seconds?: number | null;
  hantei_votes?: Array<{ judge_number: number; color: Color | null; judge_person_id: number | null }>;
  elapsed_seconds: number;
  duration_seconds: number;
  running: boolean;
  started: boolean;
  winner: Color | null;
  method: string | null;
  suggestion: Suggestion;
  /** Lo que sugeriría el marcador si el tiempo terminara ahora (para «Tiempo cumplido» en la hoja de cierre). */
  suggestion_at_time_end?: Suggestion;
  events: MatchEvent[];
  annulled_event_ids: string[];
  aka: Participant | null;
  ao: Participant | null;
  /** Enfrentamiento entre equipos: se opera combate por combate (panel de equipos). */
  is_team_match?: boolean;
  bout?: BoutInfo | null;
}

export interface FinishOut {
  scoreboard: Scoreboard;
  affected_matches: string[];
}

export interface QueueItem {
  number: string; // T1-001: el mismo número que la planilla de mesa en papel
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
  /** Vista de varios tatamis (MVP-3). */
  progress?: { done: number; total: number };
  operators?: Array<{ user: string; matches: string[] }>;
  assigned_operators?: string[];
  referees?: Array<{ name: string; position: string }>;
}

// --- Árbitros (registro y asignación opcionales) ---
export interface RefereeAssignment {
  id: number;
  person_id: number;
  name: string;
  target_type: 'tatami' | 'category' | 'match';
  target_id: number;
  target: string;
  position: string;
}

export interface RefereeOverview {
  referees: Array<{ person_id: number; name: string; assignments: number }>;
  assignments: RefereeAssignment[];
}

export interface SuggestedJudges {
  assigned: Array<{ person_id: number; name: string; position: string; via: string }>;
  others: Array<{ person_id: number; name: string }>;
}

export interface PresenceOut {
  others: Array<{ user: string; same_user: boolean; since: string }>;
  /** Esta tablet lleva la mesa (las demás quedan en solo lectura). */
  primary?: boolean;
  /** Quién lleva la mesa cuando no es esta tablet. */
  owner?: { user: string; same_user: boolean } | null;
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

// --- Historial deportivo (torneos de prueba excluidos por el servidor) ---
export interface HistoryFight {
  match_id: number;
  code: string;
  color: Color;
  won: boolean;
  method: string | null;
  /** [propio, rival] */
  score: [number | null, number | null];
  opponent: string | null;
  opponent_dojo: string | null;
}

export interface HistoryTournament {
  tournament_id: number;
  tournament_name: string;
  date: string;
  category_id: number;
  category_name: string;
  original_category_id?: number;
  merged: boolean;
  dojo_name: string | null;
  /** Participó como integrante de este equipo (resultado del equipo). */
  team_name?: string | null;
  grade: string | null;
  weight_class: string | null;
  status: string;
  place: number | null;
  matches: HistoryFight[];
}

export interface PersonHistory {
  person_id: number;
  name: string;
  grades: Array<{ grade: string; awarded_on: string | null }>;
  tournaments: HistoryTournament[];
  medals: { gold: number; silver: number; bronze: number };
}

export interface DojoHistoryTournament {
  tournament_id: number;
  tournament_name: string;
  date: string;
  gold: number;
  silver: number;
  bronze: number;
  results: Array<{ place: number; category_name: string; name: string; person_id: number | null }>;
}

export interface DojoHistory {
  dojo_id: number;
  name: string;
  senseis?: Array<{ person_id: number; name: string }>;
  tournaments: DojoHistoryTournament[];
}

// --- Estadísticas, líderes y premios ---
export interface Techniques {
  yuko: number;
  waza_ari: number;
  ippon: number;
}

export interface KumiteStats {
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  points_for: number;
  points_against: number;
  techniques: Techniques;
  techniques_against: Techniques;
  senshu: number;
  wins_by_method: Record<string, number>;
  fastest_win: number | null;
  longest_streak: number;
  win_pct: number | null;
  senshu_pct: number | null;
  avg_points: number | null;
}

export interface BadgeOut {
  code: string;
  name: string;
  kanji: string;
  description: string;
  earned: boolean;
}

export interface PersonStats {
  person_id: number;
  name: string;
  kumite: KumiteStats;
  medals: { gold: number; silver: number; bronze: number };
  tournaments: number;
  best_kata_score: number | null;
  mvp_index: number;
  badges: BadgeOut[];
  form: Array<'win' | 'loss' | 'draw'>;
}

export interface LeaderRow {
  person_id: number;
  name: string;
  dojo: string | null;
  matches: number;
  wins: number;
  points: number;
  ippon: number;
  waza_ari: number;
  yuko: number;
  senshu: number;
  fastest_win: number | null;
  medals: { gold: number; silver: number; bronze: number };
  mvp_index: number;
}

export interface Leaders {
  mvp: LeaderRow[];
  wins: LeaderRow[];
  ippon: LeaderRow[];
  points: LeaderRow[];
  senshu: LeaderRow[];
  fastest_win: LeaderRow[];
  mvp_weights: Record<string, number>;
}

export interface Award {
  code?: string;
  title: string;
  detail: string;
  person_id?: number | null;
  name: string;
  dojo: string | null;
  value: string;
}

export interface TournamentLeaders {
  tournament_id: number;
  is_test: boolean;
  awards: Award[];
  leaders: Leaders;
}

export interface TimelinePoint {
  elapsed: number;
  aka: number;
  ao: number;
  type: 'point' | 'sanction' | 'finish';
  color: Color | null;
  value: number | null;
  event_id: string;
}

export interface MatchSummarySide {
  registration_id: number | null;
  name: string | null;
  dojo: string | null;
  score: number;
  techniques: Techniques;
  sanction: number;
}

export interface MatchSummary {
  match: { id: number; code: string; status: string; method: string | null; winner: Color | null; parent_match_id: number | null; technical: boolean | null };
  category: { id: number; name: string; modality: string };
  tournament: { id: number; name: string; date: string } | null;
  aka: MatchSummarySide;
  ao: MatchSummarySide;
  senshu: Color | null;
  elapsed: number;
  duration: number | null;
  timeline: TimelinePoint[];
}

// --- Seguimiento en vivo público ---
export interface PublicSide {
  name: string;
  dojo: string;
}

export interface PublicMatch {
  number: string | null;
  code: string;
  category: string;
  status: string;
  aka: PublicSide | null;
  ao: PublicSide | null;
  score: [number, number];
  winner: Color | null;
  method: string | null;
  bout?: PublicMatch;
}

export interface PublicLive {
  tournament: { name: string; start_date: string; end_date: string | null; venue: string; city: string; status: string };
  tatamis: Array<{
    id: number;
    number: number;
    name: string;
    current: PublicMatch | null;
    upcoming: PublicMatch[];
    last: PublicMatch | null;
    done: number;
    total: number;
  }>;
  categories: Array<{ name: string; modality: string; status: string }>;
  results: Array<{ category: string; places: Array<{ place: number; name: string; dojo: string }> }>;
  medal_table: Array<{ rank: number; dojo_name: string; gold: number; silver: number; bronze: number; total: number }>;
  awards: Award[];
  server_time: string;
}

export interface OverlayData {
  tournament: string;
  tatami: { number: number; name: string };
  server_time: string;
  match: {
    number: string | null;
    code: string;
    category: string;
    status: string;
    aka: PublicSide | null;
    ao: PublicSide | null;
    score: [number, number];
    sanction: [string | null, string | null];
    senshu: Color | null;
    elapsed: number;
    running: boolean;
    duration: number;
    winner: Color | null;
    team: { aka: string; ao: string; wins: [number, number]; bout: number; extra: boolean } | null;
  } | null;
}

// --- Organizaciones, planes y suscripciones ---
export type OrgRole = 'owner' | 'admin' | 'member';
export type OrgKind = 'league' | 'dojo' | 'organizer';

export interface Subscription {
  id: number;
  organization_id: number | null;
  person_id: number | null;
  user_id: number | null;
  plan_code: string;
  plan_name: string;
  status: 'trial' | 'active' | 'past_due' | 'canceled';
  current_period_end: string | null;
  source: 'manual' | 'payment';
  reference: string | null;
  notes: string;
  created_at: string;
  /** Vigente: da acceso hoy. */
  is_current: boolean;
}

export interface Organization {
  id: number;
  name: string;
  slug: string;
  kind: OrgKind;
  country: string;
  timezone: string;
  currency: string;
  logo: string | null;
  version: number;
  created_at: string;
  my_role: OrgRole | null;
  can_manage: boolean;
  subscription: Subscription | null;
  /** Funciones disponibles hoy (en marcha blanca, todas). */
  features: string[];
  tournament_count: number;
}

export interface OrgMember {
  user_id: number;
  username: string;
  display_name: string;
  role: OrgRole;
}

export interface Plan {
  code: string;
  name: string;
  audience: 'organization' | 'person' | 'all';
  price_pen_month: number | null;
  price_pen_year: number | null;
  features: string[];
}

export interface PlansOut {
  mode: 'marcha_blanca' | 'enforced';
  plans: Plan[];
  features: Record<string, string>;
}

// --- Autoinscripción por dojo ---
export interface Invitation {
  id: number;
  tournament_id: number;
  dojo_id: number | null;
  dojo_name: string | null;
  token: string;
  created_at: string;
  revoked_at: string | null;
  uses: number;
}

export interface InvitationInfo {
  tournament_id: number;
  tournament_name: string;
  organization_name: string;
  start_date: string;
  dojo_id: number | null;
  dojo_name: string | null;
  self_registration_open: boolean;
  already_admin: boolean;
  my_dojo_ids: number[];
}

export interface DojoAdminRequest {
  id: number;
  tournament_id: number;
  dojo_id: number;
  dojo_name: string;
  user_id: number;
  username: string;
  display_name: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  current_admins: string[];
}

export interface DojoRegistration extends Registration {
  tournament_name: string;
  category_name: string;
}

export interface RegistrationRequests {
  registrations: DojoRegistration[];
  dojo_admin_requests: DojoAdminRequest[];
  count: number;
}

export interface RegistrationDecision {
  approved: number[];
  rejected: number[];
  skipped: Array<{ id: number; reason: string }>;
}

export interface OpenTournament {
  id: number;
  name: string;
  start_date: string;
  end_date: string | null;
  venue: string;
  city: string;
  organization_name: string;
  self_registration_closes_at: string | null;
}
