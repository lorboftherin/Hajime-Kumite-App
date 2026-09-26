"""Esquemas de cuentas de competidor: correo, registro, reclamos y perfil público."""

from __future__ import annotations

import re
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

# Validación sencilla (sin dependencias): algo@algo.tld, sin espacios.
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def normalize_email(value: str) -> str:
    return (value or "").strip().lower()


def check_email(value: str) -> str:
    v = normalize_email(value)
    if len(v) > 254 or not _EMAIL.match(v):
        raise ValueError("Correo no válido")
    return v


class EmailIn(BaseModel):
    email: str = Field(max_length=254)

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        return check_email(v)


class MessageOut(BaseModel):
    message: str


class ResetPasswordIn(BaseModel):
    token: str = Field(min_length=20, max_length=200)
    new_password: str = Field(min_length=8, max_length=200)


class TokenIn(BaseModel):
    token: str = Field(min_length=20, max_length=200)


class SignupIn(BaseModel):
    email: str = Field(max_length=254)
    password: str = Field(min_length=8, max_length=200)
    display_name: str = Field(min_length=2, max_length=200)

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        return check_email(v)


class ProfileUpdate(BaseModel):
    """Datos de la propia cuenta. Cambiar el correo pide la contraseña actual."""

    display_name: str | None = Field(default=None, min_length=1, max_length=200)
    email: str | None = Field(default=None, max_length=254)
    current_password: str | None = None


# --- Reclamo de perfil --------------------------------------------------------

Relation = Literal["self", "parent", "guardian"]


class ProfileSearchOut(BaseModel):
    """Resultado público: nunca documento ni fecha de nacimiento."""

    public_id: str
    name: str
    dojo: str | None
    tournaments: list[str]
    tournament_count: int


class ClaimIn(BaseModel):
    public_id: str = Field(min_length=4, max_length=24)
    relationship: Relation
    evidence: str = Field(default="", max_length=500)
    # Últimos 4 dígitos del documento: se comparan en el servidor y no se guardan.
    document_last4: str | None = Field(default=None, pattern=r"^[0-9A-Za-z]{4}$")
    # Padre, madre o apoderado: acepta la publicación de resultados y estadísticas del menor.
    consent: bool = False


class ClaimReviewIn(BaseModel):
    approve: bool
    reason: str | None = Field(default=None, max_length=500)


class ClaimOut(BaseModel):
    id: int
    status: str
    relationship: str
    created_at: datetime
    reviewed_at: datetime | None = None
    reason: str | None = None
    public_id: str | None
    person_name: str
    dojo: str | None = None


class ClaimReviewOut(ClaimOut):
    """Lo que ve quien revisa (dojo, organizador o Admin)."""

    person_id: int
    user_id: int
    user_name: str
    user_email: str | None
    evidence: str
    document_match: bool | None
    is_minor: bool
    birth_date: date | None = None


class MyProfileOut(BaseModel):
    """Perfil ligado a la cuenta: el propio (self) o el de un menor a cargo."""

    person_id: int
    public_id: str | None
    name: str
    relationship: str
    dojo: str | None
    guardianship_id: int | None = None
