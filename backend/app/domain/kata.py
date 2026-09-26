"""Kata: decisión por banderas y por puntuación (sección 19)."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal

from .brackets import AKA, AO
from .errors import DomainError


class KataError(DomainError):
    pass


# ---------------------------------------------------------------------------
# Banderas
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FlagsResult:
    winner: str | None
    aka_votes: int
    ao_votes: int
    needs_head_judge: bool


def decide_flags(votes: list[str | None], judges: int, head_judge_vote: str | None = None) -> FlagsResult:
    """Gana quien reúne la mayoría de los jueces (más de la mitad del panel).

    Si faltan votos y ningún color alcanza la mayoría, decide el juez principal.
    """
    if judges not in (3, 5):
        raise KataError("El número de jueces para banderas debe ser 3 o 5")
    if len(votes) > judges:
        raise KataError("Más votos que jueces")
    for v in votes:
        if v not in (AKA, AO, None):
            raise KataError(f"Voto inválido: {v}")
    c = Counter(v for v in votes if v)
    a, b = c[AKA], c[AO]
    majority = judges // 2 + 1
    if a >= majority:
        return FlagsResult(AKA, a, b, False)
    if b >= majority:
        return FlagsResult(AO, a, b, False)
    if head_judge_vote in (AKA, AO):
        return FlagsResult(head_judge_vote, a, b, False)
    return FlagsResult(None, a, b, True)


# ---------------------------------------------------------------------------
# Puntuación
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ScoringRules:
    judges: int = 5
    min_score: Decimal = Decimal("5.0")
    max_score: Decimal = Decimal("10.0")
    # Notas descartadas por extremo. None = por defecto del documento
    # (1 con 5 o 7 jueces, 0 con 3). WKF con 7 jueces usa 2.
    discard_each_side: int | None = None
    # Técnico / atlético (WKF): cada juez da dos notas. Cada serie se descarta
    # y suma por separado y el total pondera técnico ``technical_weight`` y
    # atlético el resto (70 / 30).
    split: bool = False
    technical_weight: Decimal = Decimal("0.7")

    @property
    def discards(self) -> int:
        if self.discard_each_side is not None:
            return self.discard_each_side
        return 0 if self.judges == 3 else 1

    @property
    def counted(self) -> int:
        """Notas que cuentan para el total (por serie)."""
        return max(1, self.judges - 2 * self.discards)


@dataclass(frozen=True)
class ScoreResult:
    total: Decimal
    kept: tuple[Decimal, ...]
    discarded_low: tuple[Decimal, ...]
    discarded_high: tuple[Decimal, ...]
    # Solo con notas técnico / atlético: subtotal de cada serie.
    technical: Decimal | None = None
    athletic: Decimal | None = None

    @property
    def min_discarded(self) -> Decimal | None:
        return min(self.discarded_low) if self.discarded_low else None

    @property
    def max_discarded(self) -> Decimal | None:
        return max(self.discarded_high) if self.discarded_high else None


def _q(x: Decimal | float | str) -> Decimal:
    return Decimal(str(x)).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)


def validate_scores(scores: list[Decimal | float | str], rules: ScoringRules) -> list[Decimal]:
    if rules.judges not in (3, 5, 7):
        raise KataError("El número de jueces para puntuación debe ser 3, 5 o 7")
    if len(scores) != rules.judges:
        raise KataError(f"Se esperaban {rules.judges} notas y llegaron {len(scores)}")
    out = []
    for s in scores:
        d = Decimal(str(s))
        if d != _q(d):
            raise KataError(f"La nota {s} debe tener un solo decimal")
        if not rules.min_score <= d <= rules.max_score:
            raise KataError(f"La nota {s} está fuera del rango {rules.min_score}–{rules.max_score}")
        out.append(d)
    if rules.judges - 2 * rules.discards < 1:
        raise KataError("Se descartan más notas de las disponibles")
    return out


def _one_series(scores: list[Decimal | float | str], rules: ScoringRules) -> ScoreResult:
    vals = sorted(validate_scores(scores, rules))
    k = rules.discards
    if k == 0:
        return ScoreResult(sum(vals, Decimal("0")), tuple(vals), (), ())
    low, high, kept = tuple(vals[:k]), tuple(vals[-k:]), tuple(vals[k:-k])
    return ScoreResult(sum(kept, Decimal("0")), kept, low, high)


def score_performance(
    scores: list[Decimal | float | str],
    rules: ScoringRules,
    athletic: list[Decimal | float | str] | None = None,
) -> ScoreResult:
    """Total de una ejecución. Con ``rules.split`` ``scores`` son las notas
    técnicas y ``athletic`` las atléticas (ambas obligatorias)."""
    if not rules.split:
        if athletic:
            raise KataError("La categoría no usa notas técnico / atléticas")
        return _one_series(scores, rules)
    if not athletic:
        raise KataError("Faltan las notas atléticas")
    tech = _one_series(scores, rules)
    ath = _one_series(athletic, rules)
    w = rules.technical_weight
    total = (tech.total * w + ath.total * (Decimal("1") - w)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return ScoreResult(total, tech.kept, tech.discarded_low, tech.discarded_high, tech.total, ath.total)


@dataclass
class RankedPerformance:
    entrant: str
    result: ScoreResult
    rank: int = 0
    unresolved_tie: bool = False
    tie_break_used: list[str] = field(default_factory=list)


def rank_performances(results: dict[str, ScoreResult]) -> list[RankedPerformance]:
    """Ordena por total. Desempate por defecto: 1) mayor nota mínima descartada,
    2) mayor nota máxima descartada, 3) sin resolver (nueva ejecución o juez
    principal).

    Con 3 jueces no hay notas descartadas: el desempate usa la nota mínima y
    luego la máxima de las conservadas, que es el equivalente razonable.

    Con notas técnico / atléticas el desempate es: mayor subtotal técnico,
    luego mayor subtotal atlético (por confirmar con el reglamento vigente).
    """

    def key(r: ScoreResult) -> tuple[Decimal, Decimal, Decimal]:
        if r.technical is not None:
            return (r.total, r.technical, r.athletic or Decimal("0"))
        lo = r.min_discarded if r.min_discarded is not None else min(r.kept)
        hi = r.max_discarded if r.max_discarded is not None else max(r.kept)
        return (r.total, lo, hi)

    items = [RankedPerformance(e, r) for e, r in results.items()]
    items.sort(key=lambda p: (key(p.result), p.entrant), reverse=True)
    rank = 0
    prev: tuple | None = None
    for i, p in enumerate(items):
        k = key(p.result)
        if k != prev:
            rank = i + 1
        else:
            p.unresolved_tie = True
            items[i - 1].unresolved_tie = True
        p.rank = rank
        prev = k
        # Registrar qué criterio definió la posición respecto al anterior.
        if i > 0 and items[i - 1].result.total == p.result.total:
            pk = key(items[i - 1].result)
            technical = p.result.technical is not None
            if pk[1] != k[1]:
                p.tie_break_used.append("technical" if technical else "min_discarded")
            elif pk[2] != k[2]:
                p.tie_break_used.append("athletic" if technical else "max_discarded")
    return items


def decide_kata_match(aka: ScoreResult, ao: ScoreResult, head_judge_vote: str | None = None) -> str | None:
    """Kata por puntuación en llave: gana la nota mayor con los desempates de
    :func:`rank_performances`. Si siguen empatados decide el juez principal
    (``head_judge_vote``); sin él devuelve ``None``."""
    ranked = rank_performances({AKA: aka, AO: ao})
    if ranked[0].unresolved_tie:
        return head_judge_vote if head_judge_vote in (AKA, AO) else None
    return ranked[0].entrant


def qualifiers(ranked: list[RankedPerformance], n: int) -> tuple[list[str], bool]:
    """Los ``n`` mejores de una ronda. Devuelve ``(clasificados, ok)``; ``ok``
    es falso si un empate sin resolver cruza el corte (el organizador decide:
    nueva ejecución o juez principal)."""
    if n >= len(ranked):
        return [r.entrant for r in ranked], True
    cut = ranked[n - 1]
    after = ranked[n]
    if cut.unresolved_tie and after.unresolved_tie and cut.rank == after.rank:
        return [r.entrant for r in ranked[:n]], False
    return [r.entrant for r in ranked[:n]], True


def kata_round_medals(ranked: list[RankedPerformance], bronzes: int = 2) -> dict[int, list[str]]:
    """Medallas de una ronda única: oro, plata y 1 o 2 bronces (según la regla
    de terceros lugares).

    Un empate sin resolver solo bloquea las medallas cuando los empatados
    recibirían medallas distintas (p. ej. 1.º/2.º, o 3.º/4.º con un solo
    bronce). Si todos los empatados reciben la misma medalla, se entrega.
    """
    out: dict[int, list[str]] = {1: [], 2: [], 3: []}
    places = [1, 2] + [3] * bronzes
    i = 0
    while i < len(ranked) and i < len(places):
        group = [p for p in ranked if p.rank == ranked[i].rank]
        medals = {places[j] if j < len(places) else None for j in range(i, i + len(group))}
        if ranked[i].unresolved_tie and len(medals) > 1:
            break
        for p in group:
            if places[i] is not None:
                out[places[i]].append(p.entrant)
        i += len(group)
    return out
