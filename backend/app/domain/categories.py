"""Grados, edad, sugerencia de categorías y advertencias de inscripción
(secciones 13 y 14). Las reglas producen advertencias, nunca bloqueos.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

# ---------------------------------------------------------------------------
# Grados: escala ordinal. 10.º kyu = 1 … 1.er kyu = 10, 1.er dan = 11, …
# ---------------------------------------------------------------------------

_GRADE_RE = re.compile(r"^\s*(\d{1,2})\s*(kyu|dan)\s*$", re.IGNORECASE)


def grade_to_ordinal(grade: str) -> int:
    m = _GRADE_RE.match(grade or "")
    if not m:
        raise ValueError(f"Grado inválido: {grade!r} (use p. ej. '8 kyu' o '1 dan')")
    n, kind = int(m.group(1)), m.group(2).lower()
    if kind == "kyu":
        if not 1 <= n <= 10:
            raise ValueError("kyu debe estar entre 1 y 10")
        return 11 - n
    if not 1 <= n <= 10:
        raise ValueError("dan debe estar entre 1 y 10")
    return 10 + n


def ordinal_to_grade(o: int) -> str:
    return f"{11 - o} kyu" if o <= 10 else f"{o - 10} dan"


def age_at(birth: date, ref: date) -> int:
    return ref.year - birth.year - ((ref.month, ref.day) < (birth.month, birth.day))


AGE_MODES = ("date", "birth_year")


def competition_age(birth: date, ref: date, mode: str = "date") -> int:
    """Edad para las categorías según el modo del torneo:

    * ``date`` (por defecto): edad cumplida a la fecha de referencia.
    * ``birth_year``: año de la fecha de referencia menos año de nacimiento
      (todos los nacidos el mismo año compiten juntos todo el año).
    """
    if mode == "birth_year":
        return ref.year - birth.year
    return age_at(birth, ref)


# ---------------------------------------------------------------------------
# Pesos: rango numérico a partir de la etiqueta ("-45", "+84", "45-50")
# ---------------------------------------------------------------------------

_NUM = r"(\d+(?:[.,]\d+)?)"
_W_UNDER = re.compile(rf"^-\s*{_NUM}$")
_W_OVER = re.compile(rf"^\+\s*{_NUM}$")
_W_RANGE = re.compile(rf"^{_NUM}\s*-\s*{_NUM}$")


def parse_weight_range(label: str | None) -> tuple[Decimal | None, Decimal | None]:
    """(mínimo, máximo) en kg de una etiqueta de peso. "-45" = hasta 45;
    "+84" = más de 84 (se guarda 84 como mínimo); "45-50" = de 45 a 50. Una
    etiqueta que no se entiende (p. ej. "Libre") devuelve (None, None)."""
    if not label:
        return None, None
    txt = re.sub(r"\s*kg\s*$", "", label.strip().lower())

    def num(x: str) -> Decimal:
        return Decimal(x.replace(",", "."))

    if m := _W_UNDER.match(txt):
        return None, num(m.group(1))
    if m := _W_OVER.match(txt):
        return num(m.group(1)), None
    if m := _W_RANGE.match(txt):
        lo, hi = num(m.group(1)), num(m.group(2))
        return (lo, hi) if lo <= hi else (hi, lo)
    return None, None


# ---------------------------------------------------------------------------
# Encaje competidor ↔ categoría
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CategoryRule:
    id: str
    modality: str  # kumite | kata
    sex: str  # M | F | X (mixto)
    age_min: int | None = None
    age_max: int | None = None
    grade_min: int | None = None  # ordinal
    grade_max: int | None = None
    weight_class: str | None = None  # etiqueta declarada, p. ej. "-84"
    is_team: bool = False


@dataclass(frozen=True)
class Competitor:
    sex: str  # M | F
    birth_date: date | None
    grade: int | None  # ordinal
    weight_class: str | None = None


@dataclass(frozen=True)
class Warning:
    code: str
    message: str


def registration_warnings(c: Competitor, cat: CategoryRule, ref_date: date, age_mode: str = "date") -> list[Warning]:
    w: list[Warning] = []
    if cat.sex != "X" and c.sex != cat.sex:
        w.append(Warning("SEX_MISMATCH", "El sexo del competidor no coincide con la categoría"))
    if c.birth_date is None:
        if cat.age_min is not None or cat.age_max is not None:
            w.append(Warning("AGE_UNKNOWN", "Sin fecha de nacimiento: no se puede validar la edad"))
    else:
        age = competition_age(c.birth_date, ref_date, age_mode)
        if cat.age_min is not None and age < cat.age_min:
            w.append(Warning("AGE_BELOW_MIN", f"Edad {age} menor al mínimo {cat.age_min}"))
        if cat.age_max is not None and age > cat.age_max:
            w.append(Warning("AGE_ABOVE_MAX", f"Edad {age} mayor al máximo {cat.age_max}"))
    if c.grade is None:
        if cat.grade_min is not None or cat.grade_max is not None:
            w.append(Warning("GRADE_UNKNOWN", "Sin grado registrado: no se puede validar el nivel"))
    else:
        if cat.grade_min is not None and c.grade < cat.grade_min:
            w.append(
                Warning(
                    "GRADE_BELOW_MIN",
                    f"Sube de nivel: {ordinal_to_grade(c.grade)} en categoría desde "
                    f"{ordinal_to_grade(cat.grade_min)} (requiere autorización)",
                )
            )
        if cat.grade_max is not None and c.grade > cat.grade_max:
            w.append(
                Warning(
                    "GRADE_ABOVE_MAX",
                    f"Baja de nivel: {ordinal_to_grade(c.grade)} en categoría hasta {ordinal_to_grade(cat.grade_max)}",
                )
            )
    if cat.weight_class and cat.modality == "kumite":
        if not c.weight_class:
            w.append(Warning("WEIGHT_UNKNOWN", "Sin categoría de peso declarada"))
        elif normalize_weight(c.weight_class) != normalize_weight(cat.weight_class):
            w.append(
                Warning(
                    "WEIGHT_MISMATCH",
                    f"Peso declarado {c.weight_class} distinto a la categoría {cat.weight_class}",
                )
            )
    return w


def normalize_weight(label: str) -> str:
    return re.sub(r"\s|kg", "", label.lower())


def suggest_categories(
    c: Competitor, cats: list[CategoryRule], ref_date: date, modality: str | None = None, age_mode: str = "date"
) -> list[CategoryRule]:
    """Categorías sin advertencias para el competidor (el operador decide).

    Si el competidor no declaró peso, el peso no se usa para sugerir: se
    proponen las categorías compatibles en todo lo demás (quien llama avisa
    que falta confirmar la categoría de peso).
    """
    ignore_weight = not c.weight_class
    return [
        cat
        for cat in cats
        if not cat.is_team
        and (modality is None or cat.modality == modality)
        and not [
            w
            for w in registration_warnings(c, cat, ref_date, age_mode)
            if not (ignore_weight and w.code == "WEIGHT_UNKNOWN")
        ]
    ]


# ---------------------------------------------------------------------------
# Estados de torneo y categoría (sección 12)
# ---------------------------------------------------------------------------

TOURNAMENT_TRANSITIONS: dict[str, set[str]] = {
    "draft": {"registration_open", "cancelled"},
    "registration_open": {"registration_closed", "cancelled"},
    "registration_closed": {"registration_open", "in_progress"},
    "in_progress": {"finished"},
    "finished": {"in_progress"},  # reabrir: solo Admin, auditado
    "cancelled": set(),
}

CATEGORY_STATES = ("open", "empty", "merged", "ready", "in_progress", "finished", "cancelled")


def can_transition(current: str, target: str) -> bool:
    return target in TOURNAMENT_TRANSITIONS.get(current, set())


def is_reopen(current: str, target: str) -> bool:
    return current == "finished" and target == "in_progress"


def few_entrants_advice(n: int) -> list[str]:
    """Opciones para categorías con pocos inscritos (el organizador decide)."""
    if n == 0:
        return ["empty"]
    if n == 1:
        return ["merge", "cancel", "keep"]
    if n == 2:
        return ["direct_final", "merge", "keep"]
    if n <= 5:
        return ["keep", "round_robin", "merge"]
    return []
