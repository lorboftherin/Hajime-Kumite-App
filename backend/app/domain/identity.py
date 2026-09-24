"""Identidad y detección de duplicados (sección 8)."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from datetime import date
from difflib import SequenceMatcher

DOCUMENT_TYPES = ("DNI", "CE", "PASSPORT", "OTHER")


def normalize_name(s: str) -> str:
    """Sin tildes, minúsculas, espacios colapsados."""
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = re.sub(r"[^a-zA-Z0-9ñÑ ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip().lower()


def normalize_document(number: str) -> str:
    return re.sub(r"[\s.\-]", "", number or "").upper()


@dataclass(frozen=True)
class PersonKey:
    id: str
    first_names: str
    last_names: str
    birth_date: date | None = None
    doc_type: str | None = None
    doc_number: str | None = None

    @property
    def full_name(self) -> str:
        return normalize_name(f"{self.first_names} {self.last_names}")


@dataclass(frozen=True)
class DuplicateMatch:
    person_id: str
    reason: str  # document | name_birth | similar_name_birth | name_only
    score: float


def find_duplicates(candidate: PersonKey, existing: list[PersonKey], threshold: float = 0.82) -> list[DuplicateMatch]:
    out: list[DuplicateMatch] = []
    cand_doc = normalize_document(candidate.doc_number) if candidate.doc_number else None
    cand_name = candidate.full_name
    cand_tokens = sorted(cand_name.split())
    for p in existing:
        if p.id == candidate.id:
            continue
        if (
            cand_doc
            and p.doc_number
            and candidate.doc_type == p.doc_type
            and normalize_document(p.doc_number) == cand_doc
        ):
            out.append(DuplicateMatch(p.id, "document", 1.0))
            continue
        name = p.full_name
        same_birth = candidate.birth_date is not None and candidate.birth_date == p.birth_date
        if name == cand_name:
            if same_birth:
                out.append(DuplicateMatch(p.id, "name_birth", 1.0))
            elif candidate.birth_date is None or p.birth_date is None:
                out.append(DuplicateMatch(p.id, "name_only", 0.7))
            continue
        if same_birth:
            # Comparación insensible al orden de palabras ("Pérez Juan" vs "Juan Perez").
            ratio = max(
                SequenceMatcher(None, cand_name, name).ratio(),
                SequenceMatcher(None, " ".join(cand_tokens), " ".join(sorted(name.split()))).ratio(),
            )
            if ratio >= threshold:
                out.append(DuplicateMatch(p.id, "similar_name_birth", round(ratio, 3)))
    out.sort(key=lambda d: -d.score)
    return out
