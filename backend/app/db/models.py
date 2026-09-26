"""Modelo de datos (sección 24). Nombres en inglés en el código; el
equivalente en el documento maestro se indica en cada clase.

Compatible con SQL Server / Azure SQL (producción) y SQLite (desarrollo y
tests). Se evita ON DELETE CASCADE para no chocar con la restricción de
"múltiples rutas de cascada" de SQL Server: nada histórico se borra.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Unicode,
    UnicodeText,
    UniqueConstraint,
    false,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, Timestamped, UtcDateTime, Versioned, utcnow

# ---------------------------------------------------------------------------
# Personas, identidad y acceso
# ---------------------------------------------------------------------------


class User(Base, Timestamped):
    """Usuario: cuenta de acceso ligada opcionalmente a una Persona."""

    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(80), unique=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    person_id: Mapped[int | None] = mapped_column(ForeignKey("persons.id", use_alter=True), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)  # Admin Global
    # Se incrementa al cambiar la contraseña o desactivar: invalida los tokens emitidos.
    token_version: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=False)
    display_name: Mapped[str] = mapped_column(Unicode(200), default="")


class UserSession(Base):
    """Sesión abierta (un inicio de sesión en un dispositivo).

    El token de renovación es opaco y aleatorio; aquí solo se guarda su hash
    (SHA-256). Cada renovación lo rota: el nuevo reemplaza a ``token_hash`` y
    el anterior queda en ``previous_token_hash`` para detectar su reutilización.
    """

    __tablename__ = "user_sessions"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    previous_token_hash: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    rotated_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    last_used_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UtcDateTime)
    revoked_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    user_agent: Mapped[str] = mapped_column(Unicode(255), default="")
    ip: Mapped[str] = mapped_column(String(45), default="")


class Person(Base, Timestamped, Versioned):
    """Persona."""

    __tablename__ = "persons"
    id: Mapped[int] = mapped_column(primary_key=True)
    first_names: Mapped[str] = mapped_column(Unicode(120))
    last_names: Mapped[str] = mapped_column(Unicode(120))
    normalized_name: Mapped[str] = mapped_column(Unicode(250), index=True)
    birth_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    sex: Mapped[str] = mapped_column(String(1))  # M | F
    identity_incomplete: Mapped[bool] = mapped_column(Boolean, default=True)
    merged_into_id: Mapped[int | None] = mapped_column(ForeignKey("persons.id"), nullable=True)
    anonymized_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    is_test_data: Mapped[bool] = mapped_column(Boolean, default=False)

    documents: Mapped[list[IdentityDocument]] = relationship(back_populates="person", lazy="selectin")
    roles: Mapped[list[PersonRole]] = relationship(back_populates="person", lazy="selectin")


class IdentityDocument(Base, Timestamped):
    """DocumentoIdentidad."""

    __tablename__ = "identity_documents"
    __table_args__ = (UniqueConstraint("doc_type", "normalized_number", name="uq_document"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    person_id: Mapped[int] = mapped_column(ForeignKey("persons.id"), index=True)
    doc_type: Mapped[str] = mapped_column(String(20))  # DNI | CE | PASSPORT | OTHER
    number: Mapped[str] = mapped_column(String(30))
    normalized_number: Mapped[str] = mapped_column(String(30))
    person: Mapped[Person] = relationship(back_populates="documents")


class DataConsent(Base, Timestamped):
    """ConsentimientoDatos (Ley 29733)."""

    __tablename__ = "data_consents"
    id: Mapped[int] = mapped_column(primary_key=True)
    person_id: Mapped[int] = mapped_column(ForeignKey("persons.id"), index=True)
    given_by: Mapped[str] = mapped_column(Unicode(200))  # nombre de quien consiente
    relationship_to_person: Mapped[str] = mapped_column(Unicode(60))  # titular, padre, madre, apoderado, dojo
    given_on: Mapped[date] = mapped_column(Date)
    medium: Mapped[str] = mapped_column(Unicode(60))  # formulario, declaración del dojo, …
    scope: Mapped[str] = mapped_column(Unicode(250), default="competencia")


class PersonRole(Base, Timestamped):
    """PersonaRol con ámbito: global, torneo o dojo."""

    __tablename__ = "person_roles"
    id: Mapped[int] = mapped_column(primary_key=True)
    person_id: Mapped[int] = mapped_column(ForeignKey("persons.id"), index=True)
    role: Mapped[str] = mapped_column(
        String(30)
    )  # admin | organizer | table_operator | dojo_admin | referee | competitor
    scope_type: Mapped[str] = mapped_column(String(20), default="global")  # global | tournament | dojo
    scope_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    person: Mapped[Person] = relationship(back_populates="roles")

    # Permisos por ámbito y operadores asignados a un tatami se buscan por rol y ámbito.
    __table_args__ = (Index("ix_person_roles_scope", "role", "scope_type", "scope_id"),)


class PersonMerge(Base):
    """FusionPersona: reversible; guarda qué filas se movieron."""

    __tablename__ = "person_merges"
    id: Mapped[int] = mapped_column(primary_key=True)
    kept_person_id: Mapped[int] = mapped_column(ForeignKey("persons.id"))
    merged_person_id: Mapped[int] = mapped_column(ForeignKey("persons.id"))
    moved: Mapped[dict[str, Any]] = mapped_column(JSON)
    reason: Mapped[str] = mapped_column(Unicode(500), default="")
    merged_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    merged_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    reverted_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)


# ---------------------------------------------------------------------------
# Dojos
# ---------------------------------------------------------------------------


class Dojo(Base, Timestamped, Versioned):
    __tablename__ = "dojos"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(Unicode(200))
    short_name: Mapped[str] = mapped_column(Unicode(40), default="")
    city: Mapped[str] = mapped_column(Unicode(100), default="")
    is_claimed: Mapped[bool] = mapped_column(Boolean, default=False)
    is_independent: Mapped[bool] = mapped_column(Boolean, default=False)
    branches: Mapped[list[Branch]] = relationship(back_populates="dojo", lazy="selectin")


class Branch(Base, Timestamped):
    """Sede."""

    __tablename__ = "branches"
    id: Mapped[int] = mapped_column(primary_key=True)
    dojo_id: Mapped[int] = mapped_column(ForeignKey("dojos.id"), index=True)
    name: Mapped[str] = mapped_column(Unicode(120))
    dojo: Mapped[Dojo] = relationship(back_populates="branches")


class DojoMembership(Base, Timestamped):
    """HistorialDojoCompetidor."""

    __tablename__ = "dojo_memberships"
    id: Mapped[int] = mapped_column(primary_key=True)
    person_id: Mapped[int] = mapped_column(ForeignKey("persons.id"), index=True)
    dojo_id: Mapped[int] = mapped_column(ForeignKey("dojos.id"), index=True)
    branch_id: Mapped[int | None] = mapped_column(ForeignKey("branches.id"), nullable=True)
    start_date: Mapped[date] = mapped_column(Date)
    end_date: Mapped[date | None] = mapped_column(Date, nullable=True)


class GradeRecord(Base, Timestamped):
    """HistorialGraduacion."""

    __tablename__ = "grade_history"
    id: Mapped[int] = mapped_column(primary_key=True)
    person_id: Mapped[int] = mapped_column(ForeignKey("persons.id"), index=True)
    grade: Mapped[str] = mapped_column(String(20))  # "8 kyu", "1 dan"
    grade_ordinal: Mapped[int] = mapped_column(Integer)
    awarded_on: Mapped[date] = mapped_column(Date)


# ---------------------------------------------------------------------------
# Plantillas, torneos y categorías
# ---------------------------------------------------------------------------


class CategoryTemplate(Base, Timestamped, Versioned):
    """Conjunto de PlantillaCategoria reutilizable."""

    __tablename__ = "category_templates"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(Unicode(200))
    description: Mapped[str] = mapped_column(Unicode(1000), default="")
    # Archivada: ya no se ofrece para torneos nuevos, pero se conserva porque
    # algún torneo la usó para generar sus categorías (no se borra).
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
    items: Mapped[list[TemplateCategory]] = relationship(
        back_populates="template", lazy="selectin", order_by="TemplateCategory.sort_order"
    )


class CategoryFieldsMixin:
    code: Mapped[str] = mapped_column(String(40))
    name: Mapped[str] = mapped_column(Unicode(200))
    modality: Mapped[str] = mapped_column(String(10))  # kumite | kata
    is_team: Mapped[bool] = mapped_column(Boolean, default=False)
    sex: Mapped[str] = mapped_column(String(1))  # M | F | X
    age_min: Mapped[int | None] = mapped_column(Integer, nullable=True)
    age_max: Mapped[int | None] = mapped_column(Integer, nullable=True)
    grade_min: Mapped[int | None] = mapped_column(Integer, nullable=True)  # ordinal
    grade_max: Mapped[int | None] = mapped_column(Integer, nullable=True)
    weight_class: Mapped[str | None] = mapped_column(String(20), nullable=True)
    # None = hereda del torneo
    format: Mapped[str | None] = mapped_column(String(30), nullable=True)
    third_place_rule: Mapped[str | None] = mapped_column(String(30), nullable=True)
    duration_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    kumite_rules: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    kata_method: Mapped[str | None] = mapped_column(String(20), nullable=True)  # flags | scores
    kata_structure: Mapped[str | None] = mapped_column(String(20), nullable=True)  # bracket | rounds
    kata_judges: Mapped[int | None] = mapped_column(Integer, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)


class TemplateCategory(Base, Timestamped, CategoryFieldsMixin):
    """PlantillaCategoria."""

    __tablename__ = "template_categories"
    id: Mapped[int] = mapped_column(primary_key=True)
    template_id: Mapped[int] = mapped_column(ForeignKey("category_templates.id"), index=True)
    template: Mapped[CategoryTemplate] = relationship(back_populates="items")


class Tournament(Base, Timestamped, Versioned):
    """Torneo."""

    __tablename__ = "tournaments"
    # El enlace público se busca por token en cada visita al vivo. Único solo
    # entre los que tienen enlace: en SQL Server un UNIQUE común admite un solo NULL.
    __table_args__ = (
        Index(
            "uq_tournaments_public_token",
            "public_token",
            unique=True,
            mssql_where=text("public_token IS NOT NULL"),
            sqlite_where=text("public_token IS NOT NULL"),
        ),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(Unicode(200))
    start_date: Mapped[date] = mapped_column(Date)
    end_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    venue: Mapped[str] = mapped_column(Unicode(200), default="")
    city: Mapped[str] = mapped_column(Unicode(100), default="")
    status: Mapped[str] = mapped_column(String(30), default="draft")
    is_test: Mapped[bool] = mapped_column(Boolean, default=False)  # es_prueba
    age_reference_date: Mapped[date] = mapped_column(Date)
    default_format: Mapped[str] = mapped_column(String(30), default="single_elimination")
    default_third_place_rule: Mapped[str] = mapped_column(String(30), default="two_bronzes")
    kumite_rules: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    kata_defaults: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    template_id: Mapped[int | None] = mapped_column(ForeignKey("category_templates.id"), nullable=True)
    # Seguimiento en vivo público (opcional): enlace secreto sin inicio de sesión.
    # Sin token no hay vista pública. ``public_names``: "short" (Diego R.) o "full".
    public_token: Mapped[str | None] = mapped_column(String(40), nullable=True)
    public_names: Mapped[str] = mapped_column(String(10), default="short", server_default="short")
    # Acreditación y pesaje (docs/acreditacion-y-pesaje.md). Sin ``checkin_required``
    # el check-in es opcional y nada cambia en llaves ni en la verificación previa.
    checkin_required: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
    weigh_in_tolerance_kg: Mapped[Decimal] = mapped_column(Numeric(4, 2), default=Decimal("0"), server_default="0")
    # Diplomas y certificados: textos editables por torneo.
    certificate_organizer: Mapped[str] = mapped_column(Unicode(200), default="", server_default="")
    certificate_signer_name: Mapped[str] = mapped_column(Unicode(200), default="", server_default="")
    certificate_signer_title: Mapped[str] = mapped_column(Unicode(200), default="", server_default="")

    tatamis: Mapped[list[Tatami]] = relationship(back_populates="tournament", lazy="selectin", order_by="Tatami.number")


class Tatami(Base, Timestamped):
    __tablename__ = "tatamis"
    id: Mapped[int] = mapped_column(primary_key=True)
    tournament_id: Mapped[int] = mapped_column(ForeignKey("tournaments.id"), index=True)
    number: Mapped[int] = mapped_column(Integer)
    name: Mapped[str] = mapped_column(Unicode(60))
    tournament: Mapped[Tournament] = relationship(back_populates="tatamis")


class Category(Base, Timestamped, Versioned, CategoryFieldsMixin):
    """CategoriaTorneo."""

    __tablename__ = "categories"
    __table_args__ = (
        Index("ix_categories_tournament", "tournament_id", "status"),
        # Orden de combates de un tatami (cola de la mesa, vivo público, planilla).
        Index("ix_categories_tatami", "tatami_id", "status", "queue_position"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    tournament_id: Mapped[int] = mapped_column(ForeignKey("tournaments.id"))
    status: Mapped[str] = mapped_column(String(20), default="open")
    tatami_id: Mapped[int | None] = mapped_column(ForeignKey("tatamis.id"), nullable=True)
    queue_position: Mapped[int | None] = mapped_column(Integer, nullable=True)
    merged_into_id: Mapped[int | None] = mapped_column(ForeignKey("categories.id"), nullable=True)
    cancel_reason: Mapped[str | None] = mapped_column(Unicode(500), nullable=True)
    is_manual: Mapped[bool] = mapped_column(Boolean, default=False)


class CategoryMerge(Base):
    """FusionCategoria."""

    __tablename__ = "category_merges"
    id: Mapped[int] = mapped_column(primary_key=True)
    target_category_id: Mapped[int] = mapped_column(ForeignKey("categories.id"))
    source_category_id: Mapped[int] = mapped_column(ForeignKey("categories.id"))
    moved_registration_ids: Mapped[list[int]] = mapped_column(JSON)
    reason: Mapped[str] = mapped_column(Unicode(500), default="")
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    undone_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)


# ---------------------------------------------------------------------------
# Inscripciones e importación
# ---------------------------------------------------------------------------


class Registration(Base, Timestamped, Versioned):
    """Inscripcion: guarda la foto del competidor al momento del torneo."""

    __tablename__ = "registrations"
    __table_args__ = (
        Index("ix_registrations_category", "category_id", "status"),
        # Código corto de la credencial (QR): único solo entre los que ya lo tienen.
        Index(
            "uq_registrations_credential_code",
            "credential_code",
            unique=True,
            mssql_where=text("credential_code IS NOT NULL"),
            sqlite_where=text("credential_code IS NOT NULL"),
        ),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    tournament_id: Mapped[int] = mapped_column(ForeignKey("tournaments.id"), index=True)
    category_id: Mapped[int] = mapped_column(ForeignKey("categories.id"))
    original_category_id: Mapped[int] = mapped_column(ForeignKey("categories.id"))
    person_id: Mapped[int | None] = mapped_column(ForeignKey("persons.id"), nullable=True, index=True)
    team_id: Mapped[int | None] = mapped_column(ForeignKey("teams.id"), nullable=True, index=True)
    # Foto al momento del torneo
    dojo_id: Mapped[int] = mapped_column(ForeignKey("dojos.id"), index=True)
    branch_id: Mapped[int | None] = mapped_column(ForeignKey("branches.id"), nullable=True)
    grade: Mapped[str | None] = mapped_column(String(20), nullable=True)
    grade_ordinal: Mapped[int | None] = mapped_column(Integer, nullable=True)
    weight_class: Mapped[str | None] = mapped_column(String(20), nullable=True)
    age_at_reference: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="active")  # active | withdrawn
    withdrawn_reason: Mapped[str | None] = mapped_column(Unicode(500), nullable=True)
    seed: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Acreditación el día del torneo: pending | present | absent
    checkin_status: Mapped[str] = mapped_column(String(10), default="pending", server_default="pending")
    checked_in_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    checked_in_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    # Pesaje: peso medido y resultado frente al rango de la categoría (ok | over | under).
    weight_kg: Mapped[Decimal | None] = mapped_column(Numeric(5, 2), nullable=True)
    weighed_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    weigh_in_result: Mapped[str | None] = mapped_column(String(10), nullable=True)
    credential_code: Mapped[str | None] = mapped_column(String(12), nullable=True)

    person: Mapped[Person | None] = relationship(lazy="joined")
    dojo: Mapped[Dojo] = relationship(lazy="joined")
    team: Mapped[Team | None] = relationship(lazy="joined")

    @property
    def display_name(self) -> str:
        """Nombre del participante: la persona o, en categorías por equipos, el equipo."""
        if self.person is not None:
            return f"{self.person.first_names} {self.person.last_names}"
        if self.team is not None:
            return self.team.name
        return ""


class Team(Base, Timestamped, Versioned):
    """EquipoTorneo: existe solo dentro de un torneo (sección 15). Se inscribe
    en su categoría con una Inscripcion que apunta al equipo."""

    __tablename__ = "teams"
    id: Mapped[int] = mapped_column(primary_key=True)
    tournament_id: Mapped[int] = mapped_column(ForeignKey("tournaments.id"), index=True)
    dojo_id: Mapped[int] = mapped_column(ForeignKey("dojos.id"))
    name: Mapped[str] = mapped_column(Unicode(120))
    members: Mapped[list[TeamMember]] = relationship(
        back_populates="team", lazy="selectin", order_by="TeamMember.order"
    )


class TeamMember(Base):
    """EquipoIntegrante: titular o suplente."""

    __tablename__ = "team_members"
    __table_args__ = (UniqueConstraint("team_id", "person_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id"), index=True)
    person_id: Mapped[int] = mapped_column(ForeignKey("persons.id"), index=True)
    role: Mapped[str] = mapped_column(String(20), default="starter")  # starter | substitute
    order: Mapped[int] = mapped_column(Integer, default=0)
    team: Mapped[Team] = relationship(back_populates="members")
    person: Mapped[Person] = relationship(lazy="joined")


class RuleOverride(Base):
    """OverrideRegla: advertencia aceptada con usuario y motivo."""

    __tablename__ = "rule_overrides"
    __table_args__ = (Index("ix_rule_overrides_entity", "entity", "entity_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    entity: Mapped[str] = mapped_column(String(40))
    entity_id: Mapped[int] = mapped_column(Integer)
    code: Mapped[str] = mapped_column(String(40))
    message: Mapped[str] = mapped_column(Unicode(500))
    reason: Mapped[str] = mapped_column(Unicode(500))
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


class ImportBatch(Base, Timestamped):
    """ImportacionLote."""

    __tablename__ = "import_batches"
    id: Mapped[int] = mapped_column(primary_key=True)
    tournament_id: Mapped[int] = mapped_column(ForeignKey("tournaments.id"), index=True)
    filename: Mapped[str] = mapped_column(Unicode(255))
    status: Mapped[str] = mapped_column(String(20), default="preview")  # preview | confirmed | cancelled
    rows: Mapped[list[ImportRow]] = relationship(
        back_populates="batch", lazy="selectin", order_by="ImportRow.row_number"
    )


class ImportRow(Base):
    """ImportacionFila."""

    __tablename__ = "import_rows"
    id: Mapped[int] = mapped_column(primary_key=True)
    batch_id: Mapped[int] = mapped_column(ForeignKey("import_batches.id"), index=True)
    row_number: Mapped[int] = mapped_column(Integer)
    data: Mapped[dict[str, Any]] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(20))  # new | duplicate | error
    errors: Mapped[list[str]] = mapped_column(JSON, default=list)
    duplicates: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    suggested_category_ids: Mapped[list[int]] = mapped_column(JSON, default=list)
    # Decisión del operador al confirmar
    resolution: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    batch: Mapped[ImportBatch] = relationship(back_populates="rows")


# ---------------------------------------------------------------------------
# Llaves y combates
# ---------------------------------------------------------------------------


class Bracket(Base, Timestamped, Versioned):
    __tablename__ = "brackets"
    id: Mapped[int] = mapped_column(primary_key=True)
    category_id: Mapped[int] = mapped_column(ForeignKey("categories.id"), unique=True)
    current_version_id: Mapped[int | None] = mapped_column(
        ForeignKey("bracket_versions.id", use_alter=True), nullable=True
    )


class BracketVersion(Base):
    """BracketVersion + BracketSlot (slots como lista JSON de ids o null = bye)."""

    __tablename__ = "bracket_versions"
    __table_args__ = (UniqueConstraint("bracket_id", "number"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    bracket_id: Mapped[int] = mapped_column(ForeignKey("brackets.id"))
    number: Mapped[int] = mapped_column(Integer)
    format: Mapped[str] = mapped_column(String(30))
    third_place_rule: Mapped[str] = mapped_column(String(30))
    seed: Mapped[int] = mapped_column(Integer)
    size: Mapped[int] = mapped_column(Integer)
    slots: Mapped[list[int | None]] = mapped_column(JSON)
    same_dojo_first_round: Mapped[int] = mapped_column(Integer, default=0)
    reason: Mapped[str] = mapped_column(Unicode(500), default="")
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))


class Match(Base, Timestamped, Versioned):
    """Combate (kumite o kata en llave)."""

    __tablename__ = "matches"
    __table_args__ = (
        UniqueConstraint("bracket_version_id", "code"),
        Index("ix_matches_category", "category_id", "status"),
        # Combates vigentes de una categoría (llave, cola, vivo) y combates de
        # una inscripción (conflictos entre tatamis, estadísticas, retiros).
        Index("ix_matches_category_current", "category_id", "is_current"),
        Index("ix_matches_aka_registration", "aka_registration_id"),
        Index("ix_matches_ao_registration", "ao_registration_id"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    category_id: Mapped[int] = mapped_column(ForeignKey("categories.id"))
    bracket_version_id: Mapped[int] = mapped_column(ForeignKey("bracket_versions.id"))
    code: Mapped[str] = mapped_column(String(20))
    kind: Mapped[str] = mapped_column(String(20), default="main")
    round: Mapped[int] = mapped_column(Integer)
    position: Mapped[int] = mapped_column(Integer)
    aka_source: Mapped[str] = mapped_column(String(40))  # "slot:3" | "winner:R1-2" | "loser:R2-1"
    ao_source: Mapped[str] = mapped_column(String(40))
    aka_registration_id: Mapped[int | None] = mapped_column(ForeignKey("registrations.id"), nullable=True)
    ao_registration_id: Mapped[int | None] = mapped_column(ForeignKey("registrations.id"), nullable=True)
    # pending | ready | in_progress | finished | bye | needs_review
    status: Mapped[str] = mapped_column(String(20), default="pending")
    winner_registration_id: Mapped[int | None] = mapped_column(ForeignKey("registrations.id"), nullable=True)
    method: Mapped[str | None] = mapped_column(String(30), nullable=True)
    aka_score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    ao_score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    is_current: Mapped[bool] = mapped_column(Boolean, default=True)  # False si su versión de llave fue reemplazada
    # Kumite por equipos: cada combate individual ("bout" o "bout_extra") cuelga
    # del enfrentamiento entre equipos y guarda qué integrante peleó por cada lado.
    parent_match_id: Mapped[int | None] = mapped_column(ForeignKey("matches.id"), nullable=True, index=True)
    bout_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    aka_person_id: Mapped[int | None] = mapped_column(ForeignKey("persons.id"), nullable=True)
    ao_person_id: Mapped[int | None] = mapped_column(ForeignKey("persons.id"), nullable=True)


class MatchEventRow(Base):
    """EventoCombate: inmutable. El id lo genera el cliente (idempotencia)."""

    __tablename__ = "match_events"
    __table_args__ = (Index("ix_match_events_match", "match_id", "device_at"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    match_id: Mapped[int] = mapped_column(ForeignKey("matches.id"))
    type: Mapped[str] = mapped_column(String(20))
    color: Mapped[str | None] = mapped_column(String(3), nullable=True)
    value: Mapped[float | None] = mapped_column(Numeric(8, 2), nullable=True)
    target_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    method: Mapped[str | None] = mapped_column(String(30), nullable=True)
    reason: Mapped[str | None] = mapped_column(Unicode(500), nullable=True)
    device_at: Mapped[datetime] = mapped_column(UtcDateTime)
    received_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))


class KataPerformance(Base, Timestamped, Versioned):
    """EjecucionKata: en un combate (banderas) o en una ronda por puntuación."""

    __tablename__ = "kata_performances"
    id: Mapped[int] = mapped_column(primary_key=True)
    category_id: Mapped[int] = mapped_column(ForeignKey("categories.id"), index=True)
    match_id: Mapped[int | None] = mapped_column(ForeignKey("matches.id"), nullable=True)
    round_number: Mapped[int] = mapped_column(Integer, default=1)
    registration_id: Mapped[int] = mapped_column(ForeignKey("registrations.id"), index=True)
    order: Mapped[int] = mapped_column(Integer, default=0)
    kata_name: Mapped[str | None] = mapped_column(Unicode(80), nullable=True)
    total: Mapped[float | None] = mapped_column(Numeric(6, 1), nullable=True)
    scores: Mapped[list[float] | None] = mapped_column(JSON, nullable=True)  # NotaJuez por posición
    judge_person_ids: Mapped[list[int | None] | None] = mapped_column(JSON, nullable=True)
    tie_break_place: Mapped[int | None] = mapped_column(Integer, nullable=True)  # decisión manual


class JudgeVote(Base):
    """VotoJuez en kata por banderas."""

    __tablename__ = "judge_votes"
    id: Mapped[int] = mapped_column(primary_key=True)
    match_id: Mapped[int] = mapped_column(ForeignKey("matches.id"), index=True)
    judge_number: Mapped[int] = mapped_column(Integer)
    judge_person_id: Mapped[int | None] = mapped_column(ForeignKey("persons.id"), nullable=True)
    color: Mapped[str | None] = mapped_column(String(3), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


class CategoryResult(Base):
    """ResultadoCategoria: puestos finales."""

    __tablename__ = "category_results"
    __table_args__ = (UniqueConstraint("category_id", "registration_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    category_id: Mapped[int] = mapped_column(ForeignKey("categories.id"), index=True)
    registration_id: Mapped[int] = mapped_column(ForeignKey("registrations.id"), index=True)
    place: Mapped[int] = mapped_column(Integer)
    computed_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


class MatchPresence(Base):
    """Tablet con la mesa de un combate abierta (latido cada pocos segundos).

    Una sola tablet «lleva la mesa» (``is_primary``): la primera que la abre o
    la que pulsa «Tomar la mesa». Las demás quedan en solo lectura y el
    servidor rechaza sus eventos con 409 CONFLICT_DEVICE. Si la dueña deja de
    latir, la siguiente tablet activa la toma sola.
    """

    __tablename__ = "match_presence"
    __table_args__ = (UniqueConstraint("match_id", "device_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    match_id: Mapped[int] = mapped_column(ForeignKey("matches.id"), index=True)
    device_id: Mapped[str] = mapped_column(String(40))
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    first_seen: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    last_seen: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow, index=True)
    is_primary: Mapped[bool] = mapped_column(Boolean, default=False)


class RefereeAssignment(Base):
    """AsignacionArbitro (sección 20): opcional, a un tatami, categoría o combate."""

    __tablename__ = "referee_assignments"
    __table_args__ = (Index("ix_referee_assignments_target", "tournament_id", "target_type", "target_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    tournament_id: Mapped[int] = mapped_column(ForeignKey("tournaments.id"))
    person_id: Mapped[int] = mapped_column(ForeignKey("persons.id"), index=True)
    target_type: Mapped[str] = mapped_column(String(20))  # tatami | category | match
    target_id: Mapped[int] = mapped_column(Integer)
    position: Mapped[str] = mapped_column(Unicode(40), default="")  # «Árbitro central», «Juez 1»…
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    person: Mapped[Person] = relationship(lazy="joined")


class ShadowComparison(Base, Timestamped):
    """Resultado oficial (papel) de un combate para el reporte de Shadow Mode."""

    __tablename__ = "shadow_comparisons"
    id: Mapped[int] = mapped_column(primary_key=True)
    match_id: Mapped[int] = mapped_column(ForeignKey("matches.id"), unique=True)
    official_winner_registration_id: Mapped[int | None] = mapped_column(ForeignKey("registrations.id"))
    official_aka_score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    official_ao_score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    finding: Mapped[str | None] = mapped_column(Unicode(1000), nullable=True)
    error_source: Mapped[str | None] = mapped_column(String(20), nullable=True)  # app | paper | none


class PublicSnapshot(Base):
    """Instantánea compartida del vivo público (ver ``app.services.public_snapshots``).

    Una fila por torneo y vista (``live`` u ``overlay:<tatami_id>``): la
    respuesta ya serializada que comparten todos los procesos y copias. Las
    escrituras que cambian algo visible la marcan ``dirty`` en su misma
    transacción; ``lease_until`` asegura que solo un proceso la recalcule.
    """

    __tablename__ = "public_snapshots"
    tournament_id: Mapped[int] = mapped_column(ForeignKey("tournaments.id"), primary_key=True)
    kind: Mapped[str] = mapped_column(String(40), primary_key=True)
    payload: Mapped[str | None] = mapped_column(UnicodeText, nullable=True)
    etag: Mapped[str | None] = mapped_column(String(40), nullable=True)
    computed_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    dirty: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
    lease_until: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)


# ---------------------------------------------------------------------------
# Ranking por temporada (docs/ranking.md)
# ---------------------------------------------------------------------------


class RankingSeason(Base, Timestamped, Versioned):
    """Temporada o liga: qué torneos cuentan y cuántos puntos da cada lugar.

    ``tournament_ids`` vacío = todos los torneos no-prueba entre ``date_from`` y
    ``date_to``. ``points``: {"gold", "silver", "bronze", "participation"}.
    ``multipliers``: {"<tournament_id>": 2.0} (p. ej. un nacional vale doble).
    Los resultados calculados viven en ``ranking_entries``; ``source_fingerprint``
    resume los resultados con que se calcularon: si cambia, se recalcula.
    """

    __tablename__ = "ranking_seasons"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(Unicode(200))
    slug: Mapped[str] = mapped_column(String(80), unique=True)
    year: Mapped[int] = mapped_column(Integer)
    date_from: Mapped[date | None] = mapped_column(Date, nullable=True)
    date_to: Mapped[date | None] = mapped_column(Date, nullable=True)
    tournament_ids: Mapped[list[int]] = mapped_column(JSON, default=list)
    points: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    multipliers: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    min_entrants_walkover_gold: Mapped[int] = mapped_column(Integer, default=2)
    is_public: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
    computed_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    source_fingerprint: Mapped[str | None] = mapped_column(String(120), nullable=True)


class RankingEntry(Base):
    """Fila materializada del ranking: una persona en su categoría equivalente
    (``kind="person"``) o un dojo en la tabla «mejor academia» (``kind="dojo"``)."""

    __tablename__ = "ranking_entries"
    __table_args__ = (
        Index("ix_ranking_entries_season", "season_id", "kind", "group_key"),
        Index("ix_ranking_entries_person", "person_id"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    season_id: Mapped[int] = mapped_column(ForeignKey("ranking_seasons.id"))
    kind: Mapped[str] = mapped_column(String(10))  # person | dojo
    group_key: Mapped[str] = mapped_column(String(200), default="")
    group_label: Mapped[str] = mapped_column(Unicode(200), default="")
    modality: Mapped[str] = mapped_column(String(10), default="")
    person_id: Mapped[int | None] = mapped_column(ForeignKey("persons.id"), nullable=True)
    dojo_id: Mapped[int | None] = mapped_column(ForeignKey("dojos.id"), nullable=True)
    points: Mapped[Decimal] = mapped_column(Numeric(9, 2), default=Decimal("0"))
    rank: Mapped[int] = mapped_column(Integer)
    golds: Mapped[int] = mapped_column(Integer, default=0)
    silvers: Mapped[int] = mapped_column(Integer, default=0)
    bronzes: Mapped[int] = mapped_column(Integer, default=0)
    participations: Mapped[int] = mapped_column(Integer, default=0)
    tournaments: Mapped[int] = mapped_column(Integer, default=0)


# ---------------------------------------------------------------------------
# Auditoría
# ---------------------------------------------------------------------------


class AuditEntry(Base):
    """AuditoriaCambio."""

    __tablename__ = "audit_log"
    __table_args__ = (Index("ix_audit_entity", "entity", "entity_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    tournament_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    entity: Mapped[str] = mapped_column(String(40))
    entity_id: Mapped[str] = mapped_column(String(40))
    action: Mapped[str] = mapped_column(String(40))
    before: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    after: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    reason: Mapped[str | None] = mapped_column(Unicode(1000), nullable=True)


# ---------------------------------------------------------------------------
# Seguridad
# ---------------------------------------------------------------------------


class LoginAttempt(Base):
    """Intentos fallidos de inicio de sesión (ver app/services/login_guard.py).

    Vive en la base y no en memoria para que el bloqueo valga igual en todos
    los procesos y copias del servidor.
    """

    __tablename__ = "login_attempts"
    # "u|<usuario>|<ip>" o "ip|<ip>"
    key: Mapped[str] = mapped_column(String(160), primary_key=True)
    failures: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    window_start: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    locked_until: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
