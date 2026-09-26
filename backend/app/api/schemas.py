from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

Sex = Literal["M", "F"]
CategorySex = Literal["M", "F", "X"]
Color = Literal["aka", "ao"]


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class Override(BaseModel):
    """Aceptación explícita de advertencias de negocio."""

    reason: str = Field(min_length=3, max_length=500)


# --- Auth ---------------------------------------------------------------


class LoginIn(BaseModel):
    username: str
    password: str


class RoleOut(ORM):
    id: int
    role: str
    scope_type: str
    scope_id: int | None


class RoleIn(BaseModel):
    role: Literal["organizer", "table_operator", "dojo_admin", "referee", "sensei"]
    scope_type: Literal["global", "organization", "tournament", "dojo", "tatami"] = "global"
    scope_id: int | None = None


class UserOrganizationOut(BaseModel):
    id: int
    name: str
    slug: str
    role: str


class UserOut(ORM):
    id: int
    username: str
    display_name: str
    is_admin: bool
    is_active: bool = True
    must_change_password: bool = False
    person_id: int | None
    roles: list[RoleOut] = []
    can_view_documents: bool = False
    email: str | None = None
    email_verified_at: datetime | None = None
    # Organizaciones de las que es miembro (con su rol) y dojos que administra.
    organizations: list[UserOrganizationOut] = []
    dojo_admin_of: list[int] = []


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    # Token opaco para renovar el de acceso sin volver a pedir la contraseña.
    refresh_token: str | None = None
    expires_in: int | None = None  # segundos de vida del token de acceso
    user: UserOut


class RefreshIn(BaseModel):
    refresh_token: str = Field(min_length=10, max_length=200)


class LogoutIn(BaseModel):
    refresh_token: str | None = None


class SessionOut(ORM):
    id: int
    created_at: datetime
    last_used_at: datetime
    expires_at: datetime
    user_agent: str
    ip: str
    current: bool = False


class PasswordChange(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=200)


class AccountDelete(BaseModel):
    """Borrar la propia cuenta (lo exigen las tiendas de apps): confirma con la contraseña."""

    password: str


class UserAdminUpdate(BaseModel):
    """Acciones del Admin sobre una cuenta."""

    is_active: bool | None = None
    is_admin: bool | None = None
    display_name: str | None = None
    person_id: int | None = None
    reset_password: str | None = Field(default=None, min_length=8, max_length=200)
    # Correo de la cuenta ("" lo quita). Queda sin verificar y se envía el enlace.
    email: str | None = Field(default=None, max_length=254)


class UserCreate(BaseModel):
    username: str = Field(min_length=3, max_length=80)
    password: str = Field(min_length=8)
    display_name: str = ""
    is_admin: bool = False
    person_id: int | None = None
    email: str | None = Field(default=None, max_length=254)


# --- Personas -----------------------------------------------------------


class DocumentIn(BaseModel):
    doc_type: Literal["DNI", "CE", "PASSPORT", "OTHER"]
    number: str = Field(min_length=3, max_length=30)


class DocumentOut(ORM):
    id: int
    doc_type: str
    number: str


class ConsentIn(BaseModel):
    given_by: str
    relationship_to_person: str = "titular"
    given_on: date
    medium: str = "declaración del dojo"
    scope: str = "competencia"


class PersonCreate(BaseModel):
    first_names: str = Field(min_length=1, max_length=120)
    last_names: str = Field(min_length=1, max_length=120)
    birth_date: date | None = None
    sex: Sex
    document: DocumentIn | None = None
    dojo_id: int | None = None
    branch_id: int | None = None
    grade: str | None = None  # "8 kyu"
    consent: ConsentIn | None = None
    override: Override | None = None  # aceptar posibles duplicados


class PersonUpdate(BaseModel):
    version: int
    first_names: str | None = None
    last_names: str | None = None
    birth_date: date | None = None
    sex: Sex | None = None
    document: DocumentIn | None = None


class DuplicateOut(BaseModel):
    person_id: int
    reason: str
    score: float
    full_name: str
    birth_date: date | None


class ConsentOut(ORM):
    id: int
    given_by: str
    relationship_to_person: str
    given_on: date
    medium: str
    scope: str


class PersonOut(ORM):
    """Documentos y fecha de nacimiento solo se devuelven a Admin y organizadores."""

    id: int
    first_names: str
    last_names: str
    birth_date: date | None
    sex: str
    identity_incomplete: bool
    merged_into_id: int | None
    anonymized_at: datetime | None = None
    version: int
    documents: list[DocumentOut] = []
    consents: list[ConsentOut] = []
    current_dojo_id: int | None = None
    current_grade: str | None = None


class AnonymizeIn(BaseModel):
    reason: str = Field(min_length=3, max_length=500)


class PersonMergeIn(BaseModel):
    keep_id: int
    merge_id: int
    reason: str = Field(min_length=3)


class GradeIn(BaseModel):
    grade: str
    awarded_on: date


class MembershipIn(BaseModel):
    dojo_id: int
    branch_id: int | None = None
    start_date: date


# --- Dojos --------------------------------------------------------------


class BranchIn(BaseModel):
    name: str


class BranchOut(ORM):
    id: int
    name: str


class DojoCreate(BaseModel):
    name: str = Field(min_length=2, max_length=200)
    short_name: str = ""
    city: str = ""
    is_independent: bool = False
    branches: list[BranchIn] = []


class DojoUpdate(BaseModel):
    version: int
    name: str | None = None
    short_name: str | None = None
    city: str | None = None


class DojoOut(ORM):
    id: int
    name: str
    short_name: str
    city: str
    is_claimed: bool
    is_independent: bool
    version: int
    branches: list[BranchOut] = []


# --- Plantillas y categorías ------------------------------------------------


class CategoryFields(BaseModel):
    code: str = Field(max_length=40)
    name: str
    modality: Literal["kumite", "kata"]
    is_team: bool = False
    sex: CategorySex
    age_min: int | None = None
    age_max: int | None = None
    grade_min: int | None = None
    grade_max: int | None = None
    weight_class: str | None = None
    format: Literal["single_elimination", "round_robin", "kata_rounds", "groups_knockout"] | None = None
    third_place_rule: Literal["two_bronzes", "third_place_match", "repechage"] | None = None
    duration_seconds: int | None = None
    kumite_rules: dict[str, Any] | None = None
    kata_method: Literal["flags", "scores"] | None = None
    kata_structure: Literal["bracket", "rounds"] | None = None
    kata_judges: int | None = None
    sort_order: int = 0
    max_entrants: int | None = None  # cupo: al superarlo se advierte y se sugiere dividir
    weight_min_kg: float | None = None  # rango en kg (sin él, se deduce de la etiqueta)
    weight_max_kg: float | None = None
    kata_rules: dict[str, Any] | None = None  # override de kata_defaults del torneo
    competition_rules: dict[str, Any] | None = None  # override de competition_rules del torneo


class TemplateCreate(BaseModel):
    name: str
    description: str = ""
    # Organización dueña (owner/admin de ella la editan); None = global (solo el Admin).
    organization_id: int | None = None
    items: list[CategoryFields] = []


class TemplateItemOut(CategoryFields, ORM):
    id: int


class TemplateOut(ORM):
    id: int
    name: str
    description: str
    version: int
    organization_id: int | None = None  # None = plantilla global
    is_archived: bool = False
    items: list[TemplateItemOut] = []
    in_use: bool = False  # algún torneo la usó para generar categorías
    can_edit: bool = False


class TemplateUpdate(BaseModel):
    version: int
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=1000)
    is_archived: bool | None = None


class TemplateDuplicateIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    # Organización de la copia (por defecto, la de la original o la del usuario).
    organization_id: int | None = None


class TemplateItemUpdate(BaseModel):
    """Cambios parciales de una categoría de plantilla (mismos campos que CategoryFields)."""

    code: str | None = Field(default=None, max_length=40)
    name: str | None = None
    modality: Literal["kumite", "kata"] | None = None
    is_team: bool | None = None
    sex: CategorySex | None = None
    age_min: int | None = None
    age_max: int | None = None
    grade_min: int | None = None
    grade_max: int | None = None
    weight_class: str | None = None
    format: Literal["single_elimination", "round_robin", "kata_rounds"] | None = None
    third_place_rule: Literal["two_bronzes", "third_place_match", "repechage"] | None = None
    duration_seconds: int | None = None
    kumite_rules: dict[str, Any] | None = None
    kata_method: Literal["flags", "scores"] | None = None
    kata_structure: Literal["bracket", "rounds"] | None = None
    kata_judges: int | None = None
    sort_order: int | None = None


class TemplateItemRow(CategoryFields):
    """Fila de la edición en tabla: con ``id`` se actualiza, sin ``id`` se crea."""

    id: int | None = None


class TemplateItemsReplace(BaseModel):
    """Reemplaza todas las categorías de la plantilla: las filas que no vienen se borran."""

    version: int
    items: list[TemplateItemRow] = Field(max_length=500)


class CategoryCreate(CategoryFields):
    pass


class CategoryUpdate(BaseModel):
    version: int
    name: str | None = None
    # Datos básicos editables desde la pestaña Categorías (quién entra en la categoría).
    sex: CategorySex | None = None
    age_min: int | None = None
    age_max: int | None = None
    grade_min: int | None = None
    grade_max: int | None = None
    weight_class: str | None = None
    format: Literal["single_elimination", "round_robin", "kata_rounds", "groups_knockout"] | None = None
    third_place_rule: Literal["two_bronzes", "third_place_match", "repechage"] | None = None
    duration_seconds: int | None = None
    kumite_rules: dict[str, Any] | None = None
    kata_method: Literal["flags", "scores"] | None = None
    kata_structure: Literal["bracket", "rounds"] | None = None
    kata_judges: int | None = None
    tatami_id: int | None = None
    queue_position: int | None = None
    max_entrants: int | None = None
    weight_min_kg: float | None = None
    weight_max_kg: float | None = None
    kata_rules: dict[str, Any] | None = None
    competition_rules: dict[str, Any] | None = None


class CategoryOut(CategoryFields, ORM):
    id: int
    tournament_id: int
    status: str
    tatami_id: int | None
    queue_position: int | None
    merged_into_id: int | None
    cancel_reason: str | None
    is_manual: bool
    version: int
    entrant_count: int = 0
    advice: list[str] = []
    split_from_id: int | None = None  # categoría de la que salió al dividir
    has_split: bool = False  # tiene divisiones activas (se pueden deshacer)


class CategoryMergeIn(BaseModel):
    source_ids: list[int] = Field(min_length=1)
    target_id: int | None = None  # None = crear nueva a partir de la primera
    new_name: str | None = None
    reason: str = ""
    override: Override | None = None


class CategorySplitIn(BaseModel):
    """Dividir una categoría en dos (reversible como la fusión)."""

    criterion: Literal["weight", "grade", "draw"] = "draw"
    names: list[str] | None = Field(default=None, min_length=2, max_length=2)  # nombres de las dos mitades
    seed: int | None = None  # sorteo reproducible
    reason: str = ""
    override: Override | None = None


class CategoryCancelIn(BaseModel):
    reason: str = Field(min_length=3)
    version: int | None = None


# --- Torneos ------------------------------------------------------------


class TournamentCreate(BaseModel):
    name: str = Field(min_length=3, max_length=200)
    start_date: date
    end_date: date | None = None
    venue: str = ""
    city: str = ""
    is_test: bool = False
    age_reference_date: date | None = None  # por defecto, el día del torneo
    default_format: Literal["single_elimination", "round_robin", "groups_knockout"] = "single_elimination"
    default_third_place_rule: Literal["two_bronzes", "third_place_match", "repechage"] = "two_bronzes"
    kumite_rules: dict[str, Any] = {}
    kata_defaults: dict[str, Any] = {}
    competition_rules: dict[str, Any] = {}
    age_mode: Literal["date", "birth_year"] = "date"
    template_id: int | None = None
    tatami_count: int = Field(default=1, ge=1, le=12)
    # Organización dueña. Si se omite: la única de la que el usuario es
    # owner/admin, o la organización principal para el Admin Global.
    organization_id: int | None = None


class TournamentUpdate(BaseModel):
    version: int
    name: str | None = None
    start_date: date | None = None
    end_date: date | None = None
    venue: str | None = None
    city: str | None = None
    is_test: bool | None = None
    age_reference_date: date | None = None
    default_format: Literal["single_elimination", "round_robin", "groups_knockout"] | None = None
    default_third_place_rule: Literal["two_bronzes", "third_place_match", "repechage"] | None = None
    kumite_rules: dict[str, Any] | None = None
    kata_defaults: dict[str, Any] | None = None
    competition_rules: dict[str, Any] | None = None
    age_mode: Literal["date", "birth_year"] | None = None
    # Acreditación y pesaje
    checkin_required: bool | None = None
    weigh_in_tolerance_kg: Decimal | None = Field(default=None, ge=0, le=10, decimal_places=2)
    # Diplomas: organizador y quien firma
    certificate_organizer: str | None = Field(default=None, max_length=200)
    certificate_signer_name: str | None = Field(default=None, max_length=200)
    certificate_signer_title: str | None = Field(default=None, max_length=200)


class TatamiOut(ORM):
    id: int
    number: int
    name: str
    planned_start: datetime | None = None  # hora local del torneo, sin zona


class TournamentOut(ORM):
    id: int
    name: str
    start_date: date
    end_date: date | None
    venue: str
    city: str
    status: str
    is_test: bool
    age_reference_date: date
    default_format: str
    default_third_place_rule: str
    kumite_rules: dict[str, Any]
    kata_defaults: dict[str, Any]
    competition_rules: dict[str, Any] | None = None
    age_mode: str = "date"
    template_id: int | None
    version: int
    tatamis: list[TatamiOut] = []
    public_token: str | None = None
    public_names: str = "short"
    organization_id: int
    organization_name: str = ""
    self_registration_open: bool = False
    self_registration_closes_at: datetime | None = None
    checkin_required: bool = False
    weigh_in_tolerance_kg: float = 0
    certificate_organizer: str = ""
    certificate_signer_name: str = ""
    certificate_signer_title: str = ""
    public_slug: str | None = None
    timezone: str = "America/Lima"
    match_overhead_seconds: int = 60


class PublicLiveIn(BaseModel):
    """Activa o desactiva el seguimiento en vivo público del torneo."""

    enabled: bool
    names: Literal["short", "full"] = "short"
    regenerate: bool = False  # nuevo enlace: el anterior deja de funcionar
    # Dirección fija /t/<slug>. None = la actual (o una nueva a partir del nombre y el año).
    slug: str | None = Field(default=None, max_length=80)


class ScheduleSettingsIn(BaseModel):
    """Parámetros de los horarios estimados del torneo."""

    timezone: str | None = Field(default=None, max_length=40)
    match_overhead_seconds: int | None = Field(default=None, ge=0, le=1800)


class TatamiUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=60)
    # Hora local del torneo («2026-10-17T09:00»); null la quita.
    planned_start: datetime | None = None


class StatusChange(BaseModel):
    status: Literal["draft", "registration_open", "registration_closed", "in_progress", "finished", "cancelled"]
    version: int
    reason: str | None = None


class GenerateCategoriesIn(BaseModel):
    template_id: int | None = None


class TatamiIn(BaseModel):
    name: str


# --- Inscripciones ------------------------------------------------------


class RegistrationCreate(BaseModel):
    person_id: int
    category_id: int
    dojo_id: int | None = None  # por defecto, el dojo vigente
    branch_id: int | None = None
    grade: str | None = None  # por defecto, el vigente a la fecha del torneo
    weight_class: str | None = None
    seed: int | None = None
    override: Override | None = None


class RegistrationUpdate(BaseModel):
    version: int
    category_id: int | None = None
    grade: str | None = None
    weight_class: str | None = None
    dojo_id: int | None = None
    seed: int | None = None
    override: Override | None = None


class WithdrawIn(BaseModel):
    reason: str = Field(min_length=3)
    version: int | None = None  # control optimista si el cliente la conoce


class RegistrationOut(ORM):
    id: int
    tournament_id: int
    category_id: int
    original_category_id: int
    person_id: int | None
    dojo_id: int
    branch_id: int | None
    grade: str | None
    weight_class: str | None
    age_at_reference: int | None
    status: str
    withdrawn_reason: str | None
    rejection_reason: str | None = None
    requested_by_id: int | None = None
    seed: int | None
    version: int
    checkin_status: str = "pending"
    checked_in_at: datetime | None = None
    weight_kg: float | None = None
    weighed_at: datetime | None = None
    weigh_in_result: str | None = None
    person_name: str = ""  # en categorías por equipos, el nombre del equipo
    dojo_name: str = ""
    team_id: int | None = None
    team_version: int | None = None
    team_members: list[dict[str, Any]] = []


class TeamMemberIn(BaseModel):
    person_id: int
    role: Literal["starter", "substitute"] = "starter"


class TeamCreate(BaseModel):
    category_id: int
    dojo_id: int
    name: str = Field(min_length=1, max_length=120)
    members: list[TeamMemberIn] = Field(min_length=1)
    seed: int | None = None
    override: Override | None = None


class TeamUpdate(BaseModel):
    version: int
    name: str | None = Field(default=None, min_length=1, max_length=120)
    dojo_id: int | None = None
    members: list[TeamMemberIn] | None = Field(default=None, min_length=1)
    override: Override | None = None


class RefereeIn(BaseModel):
    person_id: int


class RefereeAssignIn(BaseModel):
    """Asignación opcional de un árbitro (sección 20)."""

    person_id: int
    target_type: Literal["tatami", "category", "match"]
    target_id: int
    position: str = Field(default="", max_length=40)  # «Árbitro central», «Juez 1»…


class PresenceIn(BaseModel):
    device_id: str = Field(min_length=8, max_length=40)


class LineupBoutIn(BaseModel):
    aka_person_id: int | None = None
    ao_person_id: int | None = None


class LineupIn(BaseModel):
    """Alineación de un enfrentamiento por equipos, combate por combate."""

    bouts: list[LineupBoutIn] = Field(min_length=1, max_length=10)
    extra: bool = False  # agrega un combate extra de desempate
    version: int | None = None
    override: Override | None = None


class SuggestionOut(BaseModel):
    category_id: int
    name: str
    modality: str


# --- Importación ----------------------------------------------------------


class ImportRowOut(ORM):
    id: int
    row_number: int
    data: dict[str, Any]
    status: str
    errors: list[str]
    duplicates: list[dict[str, Any]]
    suggested_category_ids: list[int]
    resolution: dict[str, Any] | None


class ImportBatchOut(ORM):
    id: int
    tournament_id: int
    filename: str
    status: str
    rows: list[ImportRowOut]


class ImportRowDecision(BaseModel):
    row_id: int
    action: Literal["create", "use_existing", "skip"] = "create"
    person_id: int | None = None  # para use_existing
    category_ids: list[int] = []


class ImportConfirm(BaseModel):
    decisions: list[ImportRowDecision] = []  # filas no listadas: acción sugerida
    override: Override | None = None


# --- Llaves y combates ------------------------------------------------------


class BracketGenerateIn(BaseModel):
    format: Literal["single_elimination", "round_robin", "groups_knockout"] | None = None
    third_place_rule: Literal["two_bronzes", "third_place_match", "repechage"] | None = None
    seed: int | None = None
    reason: str = ""
    # Acreditación: retira antes de sortear a los marcados ausentes («No se presentó»).
    exclude_absent: bool = False
    override: Override | None = None


class BracketEntrantIn(BaseModel):
    """Inscripción tardía o retiro con la llave ya generada."""

    registration_id: int
    reason: str = ""
    version: int | None = None  # versión de la llave (Bracket) si el cliente la conoce
    override: Override | None = None


class DisqualifyIn(BaseModel):
    """Shikkaku con alcance de torneo: retira todas las inscripciones de la persona."""

    reason: str = Field(min_length=3)
    override: Override | None = None  # confirmación: lista lo que se retira


class SlotSwapIn(BaseModel):
    version: int  # versión del Bracket
    a: int  # posición
    b: int
    reason: str = ""
    override: Override | None = None


class ParticipantOut(BaseModel):
    registration_id: int
    name: str
    dojo_id: int
    dojo_name: str


class MatchOut(ORM):
    id: int
    category_id: int
    code: str
    kind: str
    round: int
    position: int
    aka_source: str
    ao_source: str
    aka_registration_id: int | None
    ao_registration_id: int | None
    status: str
    winner_registration_id: int | None
    method: str | None
    aka_score: int | None
    ao_score: int | None
    started_at: datetime | None
    finished_at: datetime | None
    version: int
    parent_match_id: int | None = None
    bout_number: int | None = None
    aka_person_id: int | None = None
    ao_person_id: int | None = None


class BracketOut(BaseModel):
    id: int
    category_id: int
    version: int
    version_number: int
    format: str
    third_place_rule: str
    seed: int
    size: int
    slots: list[int | None]
    same_dojo_first_round: int
    participants: dict[int, ParticipantOut]
    matches: list[MatchOut]
    podium: dict[str, Any]
    standings: list[dict[str, Any]] | None = None
    groups: list[dict[str, Any]] | None = None  # formato groups_knockout: tabla de cada grupo
    kata_rounds: dict[str, Any] | None = None  # rondas de kata: ronda en curso, cortes, orden


class EventIn(BaseModel):
    id: str = Field(min_length=8, max_length=36)  # UUID generado por el cliente
    type: Literal[
        "point",
        "sanction",
        "start",
        "pause",
        "resume",
        "time_adjust",
        "annul",
        "senshu_cancel",
        "hantei",
        "kiken",
        "shikkaku",
        "walkover",
        "golden_point",
    ]
    at: datetime  # hora del dispositivo
    color: Color | None = None
    value: float | None = None
    target_id: str | None = None
    reason: str | None = None
    # Sanción: tipo de falta opcional y escalera (preset de dos categorías).
    infraction: str | None = Field(default=None, max_length=30)
    ladder: Literal["c1", "c2"] | None = None
    # Hantei: votos de los jueces (opcional, solo registro) y quién votó.
    votes: list[Color | None] | None = None
    judge_person_ids: list[int | None] | None = None
    override: Override | None = None  # requerido para tocar un combate ya cerrado


class EventOut(ORM):
    id: str
    type: str
    color: str | None
    value: float | None
    target_id: str | None
    method: str | None
    reason: str | None
    infraction: str | None = None
    ladder: str | None = None
    device_at: datetime
    received_at: datetime


class ScoreboardOut(BaseModel):
    match: MatchOut
    rules: dict[str, Any] = {}  # reglas efectivas: time_mode, auto_pause_on_point, tie_rule, lead_victory…
    score: dict[str, int]
    sanction: dict[str, int]
    sanction_labels: list[str]
    sanction_c2: dict[str, int] | None = None  # segunda escalera (preset de dos categorías)
    sanction_labels_c2: list[str] | None = None
    infractions: dict[str, dict[str, Any]] | None = None  # tipos de falta, si el preset los usa
    senshu: str | None
    senshu_lost: list[str] = []
    golden_point: bool = False  # en periodo de punto de oro
    period_seconds: float | None = None  # duración del periodo en curso (None = sin límite)
    hantei_votes: list[dict[str, Any]] = []
    elapsed_seconds: float
    duration_seconds: int
    running: bool
    started: bool
    winner: str | None
    method: str | None
    suggestion: dict[str, Any]
    suggestion_at_time_end: dict[str, Any] = {}
    events: list[EventOut]
    annulled_event_ids: list[str]
    aka: ParticipantOut | None
    ao: ParticipantOut | None
    is_team_match: bool = False  # enfrentamiento entre equipos: se opera por combates
    bout: dict[str, Any] | None = None  # combate individual de un enfrentamiento por equipos


class FinishIn(BaseModel):
    id: str = Field(min_length=8, max_length=36)
    at: datetime
    winner: Literal["aka", "ao", "draw"]  # "draw" solo en combates individuales por equipos
    method: str = "points"
    reason: str | None = None
    time_over: bool = True
    override: Override | None = None


class FlagsIn(BaseModel):
    votes: list[Color | None]
    judge_person_ids: list[int | None] | None = None
    head_judge_vote: Color | None = None
    event_id: str = Field(min_length=8, max_length=36)
    at: datetime
    override: Override | None = None  # corregir una decisión ya tomada


class KataScoreIn(BaseModel):
    registration_id: int
    scores: list[float]
    athletic_scores: list[float] | None = None  # con notas técnico / atléticas
    judge_person_ids: list[int | None] | None = None
    kata_name: str | None = None
    round_number: int | None = None  # por defecto, la ronda en curso
    version: int | None = None
    override: Override | None = None  # p. ej. repetir un kata cuando el reglamento lo prohíbe


class KataOrderIn(BaseModel):
    registration_ids: list[int]
    round_number: int | None = None  # por defecto, la ronda en curso
    reason: str = ""


class KataMatchScoreIn(BaseModel):
    """Kata por puntuación en llave: nota del panel para aka y para ao."""

    aka_scores: list[float]
    ao_scores: list[float]
    aka_athletic: list[float] | None = None
    ao_athletic: list[float] | None = None
    aka_kata_name: str | None = None
    ao_kata_name: str | None = None
    judge_person_ids: list[int | None] | None = None
    head_judge_vote: Color | None = None  # desempate final si las notas empatan en todo
    event_id: str = Field(min_length=8, max_length=36)
    at: datetime
    override: Override | None = None


class TieBreakIn(BaseModel):
    registration_ids_in_order: list[int]
    reason: str = Field(min_length=3)
    round_number: int | None = None  # rondas de kata: por defecto, la ronda en curso


class OfficialResultIn(BaseModel):
    official_winner_registration_id: int | None = None
    official_aka_score: int | None = None
    official_ao_score: int | None = None
    finding: str | None = None
    error_source: Literal["app", "paper", "none"] | None = None


# --- Organizaciones, planes y suscripciones --------------------------------------

OrgKind = Literal["league", "dojo", "organizer"]
OrgRole = Literal["owner", "admin", "member"]
SubscriptionStatus = Literal["trial", "active", "past_due", "canceled"]
# Correo simple (sin dependencias extra): algo@dominio.tld; vacío permitido.
EMAIL_PATTERN = r"^([^@\s]+@[^@\s]+\.[^@\s]+)?$"


class OrganizationCreate(BaseModel):
    name: str = Field(min_length=2, max_length=200)
    slug: str | None = Field(default=None, max_length=80, pattern=r"^[a-z0-9][a-z0-9-]*$")
    kind: OrgKind = "organizer"
    country: str = Field(default="PE", min_length=2, max_length=2)
    timezone: str = Field(default="America/Lima", max_length=60)
    currency: str = Field(default="PEN", min_length=3, max_length=3)
    logo: str | None = Field(default=None, max_length=500)
    # Datos fiscales (factura electrónica). Sin RUC se emite boleta.
    tax_id: str | None = Field(default=None, pattern=r"^(\d{11})?$")
    legal_name: str | None = Field(default=None, max_length=200)
    tax_address: str | None = Field(default=None, max_length=300)
    billing_email: str | None = Field(default=None, max_length=200, pattern=EMAIL_PATTERN)
    # Cuenta que queda como dueña (owner) de la organización.
    owner_user_id: int | None = None


class OrganizationUpdate(BaseModel):
    version: int
    name: str | None = Field(default=None, min_length=2, max_length=200)
    slug: str | None = Field(default=None, max_length=80, pattern=r"^[a-z0-9][a-z0-9-]*$")
    kind: OrgKind | None = None
    country: str | None = Field(default=None, min_length=2, max_length=2)
    timezone: str | None = Field(default=None, max_length=60)
    currency: str | None = Field(default=None, min_length=3, max_length=3)
    logo: str | None = Field(default=None, max_length=500)
    # Datos fiscales (factura electrónica). Sin RUC se emite boleta.
    tax_id: str | None = Field(default=None, pattern=r"^(\d{11})?$")
    legal_name: str | None = Field(default=None, max_length=200)
    tax_address: str | None = Field(default=None, max_length=300)
    billing_email: str | None = Field(default=None, max_length=200, pattern=EMAIL_PATTERN)


class SubscriptionOut(ORM):
    id: int
    organization_id: int | None
    person_id: int | None
    user_id: int | None
    plan_code: str
    plan_name: str = ""
    status: str
    current_period_end: datetime | None
    source: str
    reference: str | None
    notes: str
    created_at: datetime
    is_current: bool = False
    period: str | None = None
    provider: str | None = None
    # Se renueva sola en la pasarela (preapproval / suscripción de Culqi).
    recurring: bool = False
    cancel_at_period_end: bool = False
    grace_until: datetime | None = None
    # Con acceso por la gracia tras un pago rechazado o vencido.
    in_grace: bool = False
    # Hasta cuándo da acceso (con la gracia); None = sin vencimiento o sin acceso.
    access_until: datetime | None = None
    coupon_code: str | None = None
    amount_cents: int | None = None


class OrganizationOut(ORM):
    id: int
    name: str
    slug: str
    kind: str
    country: str
    timezone: str
    currency: str
    logo: str | None
    tax_id: str | None = None
    legal_name: str | None = None
    tax_address: str | None = None
    billing_email: str | None = None
    version: int
    created_at: datetime
    my_role: str | None = None  # owner | admin | member; None para el Admin Global sin membresía
    can_manage: bool = False
    subscription: SubscriptionOut | None = None
    # Funciones disponibles hoy (en marcha blanca, todas).
    features: list[str] = []
    tournament_count: int = 0


class MemberIn(BaseModel):
    """Invitar a un usuario existente, por nombre de usuario o id."""

    username: str | None = None
    user_id: int | None = None
    role: OrgRole = "member"


class MemberUpdate(BaseModel):
    role: OrgRole


class MemberOut(BaseModel):
    user_id: int
    username: str
    display_name: str
    role: str


class PlanOut(ORM):
    code: str
    name: str
    audience: str
    price_pen_month: float | None
    price_pen_year: float | None
    features: list[str]
    trial_days: int = 0


class PlansOut(BaseModel):
    mode: str  # marcha_blanca | enforced
    plans: list[PlanOut]
    features: dict[str, str]  # código → nombre legible


class PlanPriceUpdate(BaseModel):
    price_pen_month: float | None = Field(default=None, ge=0)
    price_pen_year: float | None = Field(default=None, ge=0)
    trial_days: int | None = Field(default=None, ge=0, le=365)


class SubscriptionCreate(BaseModel):
    """Suscripción manual (Admin Global): a una organización, persona o cuenta."""

    organization_id: int | None = None
    person_id: int | None = None
    user_id: int | None = None
    plan_code: str
    status: SubscriptionStatus = "active"
    current_period_end: datetime | None = None
    notes: str = Field(default="", max_length=500)


class SubscriptionUpdate(BaseModel):
    plan_code: str | None = None
    status: SubscriptionStatus | None = None
    current_period_end: datetime | None = None
    notes: str | None = Field(default=None, max_length=500)


class MarkPaidIn(BaseModel):
    period: Literal["month", "year"] = "month"
    reference: str | None = Field(default=None, max_length=120)


class CheckoutIn(BaseModel):
    plan_code: str
    period: Literal["month", "year"] = "month"
    coupon_code: str | None = Field(default=None, max_length=40)
    # Correo del pagador: Mercado Pago lo exige para el pago mensual automático.
    payer_email: str | None = Field(default=None, max_length=200, pattern=EMAIL_PATTERN)
    # Titular de la boleta (Competidor Plus): DNI opcional y nombre.
    billing_doc: str | None = Field(default=None, pattern=r"^(\d{8})?$")
    billing_name: str | None = Field(default=None, max_length=200)


class CheckoutOut(BaseModel):
    provider: str  # manual | mercadopago | culqi | coupon
    subscription_id: int
    # URL de la pasarela (Mercado Pago): el navegador se redirige allí.
    url: str | None
    instructions: str
    amount_cents: int = 0
    currency: str = "PEN"
    description: str = ""
    # Cobro mensual automático (preapproval de Mercado Pago o plan de Culqi).
    recurring: bool = False
    # Llave pública de Culqi Checkout (no es secreta).
    public_key: str | None = None
    # Estado de la suscripción tras el checkout (active si un cupón cubrió todo).
    status: str = "past_due"


class QuoteOut(BaseModel):
    plan_code: str
    plan_name: str
    period: Literal["month", "year"]
    list_cents: int
    discount_cents: int
    # Lo que se cobra ahora y en las renovaciones (en céntimos).
    first_cents: int
    recurring_cents: int
    coupon_code: str | None = None
    trial_days: int = 0


class TrialIn(BaseModel):
    plan_code: str


class CulqiChargeIn(BaseModel):
    """Token de Culqi Checkout (generado en el navegador: el servidor nunca ve la tarjeta)."""

    subscription_id: int
    token: str = Field(min_length=5, max_length=100)
    email: str = Field(max_length=200, pattern=EMAIL_PATTERN)
    # Para el cobro mensual automático Culqi pide un cliente con estos datos.
    first_name: str | None = Field(default=None, max_length=50)
    last_name: str | None = Field(default=None, max_length=50)
    phone: str | None = Field(default=None, max_length=15, pattern=r"^\+?\d{6,14}$")


class InvoiceOut(ORM):
    id: int
    doc_type: str
    serie: str
    numero: int
    status: str
    customer_name: str
    total_pen: int
    pdf_url: str | None
    xml_url: str | None
    cdr_url: str | None
    message: str
    created_at: datetime


class PaymentOut(ORM):
    id: int
    provider: str
    provider_ref: str
    subscription_id: int | None
    amount_pen: int  # céntimos
    currency: str
    status: str
    period: str | None
    coupon_code: str | None
    created_at: datetime
    updated_at: datetime
    plan_code: str | None = None
    plan_name: str | None = None
    organization_id: int | None = None
    organization_name: str | None = None
    user_id: int | None = None
    username: str | None = None
    invoice: InvoiceOut | None = None


class RefundIn(BaseModel):
    reason: str = Field(min_length=3, max_length=300)
    # Además de devolver el dinero, cortar el acceso de la suscripción.
    cancel_subscription: bool = True


class CouponIn(BaseModel):
    code: str = Field(min_length=3, max_length=40, pattern=r"^[A-Za-z0-9_-]+$")
    description: str = Field(default="", max_length=300)
    percent_off: int | None = Field(default=None, ge=1, le=100)
    amount_off_pen: int | None = Field(default=None, ge=1)  # céntimos
    plan_codes: list[str] = []
    max_redemptions: int | None = Field(default=None, ge=1)
    expires_at: datetime | None = None
    first_period_only: bool = True
    active: bool = True


class CouponUpdate(BaseModel):
    description: str | None = Field(default=None, max_length=300)
    percent_off: int | None = Field(default=None, ge=1, le=100)
    amount_off_pen: int | None = Field(default=None, ge=1)
    plan_codes: list[str] | None = None
    max_redemptions: int | None = Field(default=None, ge=1)
    expires_at: datetime | None = None
    first_period_only: bool | None = None
    active: bool | None = None


class CouponOut(ORM):
    id: int
    code: str
    description: str
    percent_off: int | None
    amount_off_pen: int | None
    plan_codes: list[str]
    max_redemptions: int | None
    times_redeemed: int
    expires_at: datetime | None
    first_period_only: bool
    active: bool
    created_at: datetime


class BillingConfigOut(BaseModel):
    mode: str  # marcha_blanca | enforced
    provider: str  # manual | mercadopago | culqi
    # Llave pública de Culqi (solo si la pasarela es Culqi).
    culqi_public_key: str | None = None
    invoicing: str  # none | nubefact
    grace_days: int


class BillingAlert(BaseModel):
    """Aviso para el encabezado: el plan vence pronto o está en gracia."""

    subscription_id: int
    organization_id: int | None
    organization_name: str | None
    plan_name: str
    status: str
    days_left: int
    in_grace: bool
    recurring: bool
    access_until: datetime | None


# --- Autoinscripción por dojo -----------------------------------------------------


class SelfRegistrationIn(BaseModel):
    open: bool
    closes_at: datetime | None = None


class InvitationCreate(BaseModel):
    dojo_id: int | None = None  # None = enlace general


class InvitationOut(ORM):
    id: int
    tournament_id: int
    dojo_id: int | None
    dojo_name: str | None = None
    token: str
    created_at: datetime
    revoked_at: datetime | None
    uses: int


class InvitationInfo(BaseModel):
    """Lo que ve quien abre un enlace de invitación."""

    tournament_id: int
    tournament_name: str
    organization_name: str
    start_date: date
    dojo_id: int | None
    dojo_name: str | None
    self_registration_open: bool
    # Si la cuenta ya administra el dojo del enlace.
    already_admin: bool
    # Dojos que la cuenta ya administra.
    my_dojo_ids: list[int] = []


class InvitationAccept(BaseModel):
    # Solo en un enlace general: dojo que la cuenta pide administrar.
    dojo_id: int | None = None


class InvitationAcceptOut(BaseModel):
    status: Literal["granted", "already_admin", "pending_approval"]
    dojo_id: int
    tournament_id: int


class DojoAdminRequestOut(BaseModel):
    id: int
    tournament_id: int
    dojo_id: int
    dojo_name: str
    user_id: int
    username: str
    display_name: str
    status: str
    created_at: datetime
    current_admins: list[str] = []


class DecisionIn(BaseModel):
    approve: bool


class DojoRegistrationItem(BaseModel):
    person_id: int
    category_id: int
    weight_class: str | None = None


class DojoRegistrationBatch(BaseModel):
    items: list[DojoRegistrationItem] = Field(min_length=1, max_length=300)
    override: Override | None = None


class OpenTournamentOut(BaseModel):
    id: int
    name: str
    start_date: date
    end_date: date | None
    venue: str
    city: str
    organization_name: str
    self_registration_closes_at: datetime | None


class DojoRegistrationOut(RegistrationOut):
    tournament_name: str = ""
    category_name: str = ""


class RegistrationDecisionIn(BaseModel):
    ids: list[int] = Field(min_length=1, max_length=500)
    action: Literal["approve", "reject"]
    reason: str | None = Field(default=None, max_length=500)


class RegistrationDecisionOut(BaseModel):
    approved: list[int] = []
    rejected: list[int] = []
    # Las que no se pudieron aprobar, con el motivo.
    skipped: list[dict[str, Any]] = []


class RegistrationRequestsOut(BaseModel):
    registrations: list[DojoRegistrationOut]
    dojo_admin_requests: list[DojoAdminRequestOut]
    count: int
