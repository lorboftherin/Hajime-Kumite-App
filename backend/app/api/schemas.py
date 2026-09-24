from __future__ import annotations

from datetime import date, datetime
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


class UserOut(ORM):
    id: int
    username: str
    display_name: str
    is_admin: bool
    person_id: int | None


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


class UserCreate(BaseModel):
    username: str = Field(min_length=3, max_length=80)
    password: str = Field(min_length=8)
    display_name: str = ""
    is_admin: bool = False
    person_id: int | None = None


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


class PersonOut(ORM):
    id: int
    first_names: str
    last_names: str
    birth_date: date | None
    sex: str
    identity_incomplete: bool
    merged_into_id: int | None
    version: int
    documents: list[DocumentOut] = []
    current_dojo_id: int | None = None
    current_grade: str | None = None


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
    format: Literal["single_elimination", "round_robin", "kata_rounds"] | None = None
    third_place_rule: Literal["two_bronzes", "third_place_match", "repechage"] | None = None
    duration_seconds: int | None = None
    kumite_rules: dict[str, Any] | None = None
    kata_method: Literal["flags", "scores"] | None = None
    kata_structure: Literal["bracket", "rounds"] | None = None
    kata_judges: int | None = None
    sort_order: int = 0


class TemplateCreate(BaseModel):
    name: str
    description: str = ""
    items: list[CategoryFields] = []


class TemplateItemOut(CategoryFields, ORM):
    id: int


class TemplateOut(ORM):
    id: int
    name: str
    description: str
    version: int
    items: list[TemplateItemOut] = []


class CategoryCreate(CategoryFields):
    pass


class CategoryUpdate(BaseModel):
    version: int
    name: str | None = None
    format: Literal["single_elimination", "round_robin", "kata_rounds"] | None = None
    third_place_rule: Literal["two_bronzes", "third_place_match", "repechage"] | None = None
    duration_seconds: int | None = None
    kumite_rules: dict[str, Any] | None = None
    kata_method: Literal["flags", "scores"] | None = None
    kata_structure: Literal["bracket", "rounds"] | None = None
    kata_judges: int | None = None
    tatami_id: int | None = None
    queue_position: int | None = None


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


class CategoryMergeIn(BaseModel):
    source_ids: list[int] = Field(min_length=1)
    target_id: int | None = None  # None = crear nueva a partir de la primera
    new_name: str | None = None
    reason: str = ""


class CategoryCancelIn(BaseModel):
    reason: str = Field(min_length=3)


# --- Torneos ------------------------------------------------------------


class TournamentCreate(BaseModel):
    name: str = Field(min_length=3, max_length=200)
    start_date: date
    end_date: date | None = None
    venue: str = ""
    city: str = ""
    is_test: bool = False
    age_reference_date: date | None = None  # por defecto, el día del torneo
    default_format: Literal["single_elimination", "round_robin"] = "single_elimination"
    default_third_place_rule: Literal["two_bronzes", "third_place_match", "repechage"] = "two_bronzes"
    kumite_rules: dict[str, Any] = {}
    kata_defaults: dict[str, Any] = {}
    template_id: int | None = None
    tatami_count: int = Field(default=1, ge=1, le=12)


class TournamentUpdate(BaseModel):
    version: int
    name: str | None = None
    start_date: date | None = None
    end_date: date | None = None
    venue: str | None = None
    city: str | None = None
    is_test: bool | None = None
    age_reference_date: date | None = None
    default_third_place_rule: Literal["two_bronzes", "third_place_match", "repechage"] | None = None
    kumite_rules: dict[str, Any] | None = None
    kata_defaults: dict[str, Any] | None = None


class TatamiOut(ORM):
    id: int
    number: int
    name: str


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
    template_id: int | None
    version: int
    tatamis: list[TatamiOut] = []


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
    seed: int | None
    version: int
    person_name: str = ""
    dojo_name: str = ""


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
    format: Literal["single_elimination", "round_robin"] | None = None
    third_place_rule: Literal["two_bronzes", "third_place_match", "repechage"] | None = None
    seed: int | None = None
    reason: str = ""
    override: Override | None = None


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
    ]
    at: datetime  # hora del dispositivo
    color: Color | None = None
    value: float | None = None
    target_id: str | None = None
    reason: str | None = None


class EventOut(ORM):
    id: str
    type: str
    color: str | None
    value: float | None
    target_id: str | None
    method: str | None
    reason: str | None
    device_at: datetime
    received_at: datetime


class ScoreboardOut(BaseModel):
    match: MatchOut
    score: dict[str, int]
    sanction: dict[str, int]
    sanction_labels: list[str]
    senshu: str | None
    elapsed_seconds: float
    duration_seconds: int
    running: bool
    started: bool
    winner: str | None
    method: str | None
    suggestion: dict[str, Any]
    events: list[EventOut]
    annulled_event_ids: list[str]
    aka: ParticipantOut | None
    ao: ParticipantOut | None


class FinishIn(BaseModel):
    id: str = Field(min_length=8, max_length=36)
    at: datetime
    winner: Color
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


class KataScoreIn(BaseModel):
    registration_id: int
    scores: list[float]
    judge_person_ids: list[int | None] | None = None
    kata_name: str | None = None
    version: int | None = None


class KataOrderIn(BaseModel):
    registration_ids: list[int]


class TieBreakIn(BaseModel):
    registration_ids_in_order: list[int]
    reason: str = Field(min_length=3)


class OfficialResultIn(BaseModel):
    official_winner_registration_id: int | None = None
    official_aka_score: int | None = None
    official_ao_score: int | None = None
    finding: str | None = None
    error_source: Literal["app", "paper", "none"] | None = None
