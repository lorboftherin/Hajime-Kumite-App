"""Kumite por equipos (sección 15).

Un enfrentamiento entre equipos contiene varios combates individuales. Gana
el equipo con más victorias; si empatan, se aplica el criterio configurado:

* ``points``: gana quien sumó más puntos en los combates regulares y, si
  también empatan, se disputa un combate extra.
* ``extra_bout``: se disputa directamente un combate extra.

En cuanto un equipo tiene mayoría absoluta de victorias el enfrentamiento
queda decidido (los combates restantes ya no cambian el resultado).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum

from .brackets import AKA, AO


class TeamTieRule(StrEnum):
    POINTS = "points"
    EXTRA_BOUT = "extra_bout"


class ExtraBoutTie(StrEnum):
    """Qué pasa si el combate extra termina empatado.

    * ``hantei`` (por defecto, WKF): el combate extra no admite empate; se
      decide por los jueces en ese mismo combate.
    * ``repeat``: se disputa otro combate extra (comportamiento anterior).
    """

    HANTEI = "hantei"
    REPEAT = "repeat"


DEFAULT_TEAM_BOUTS = 3


@dataclass(frozen=True)
class BoutResult:
    finished: bool
    winner: str | None = None  # aka | ao | None (empate o sin terminar)
    aka_score: int = 0
    ao_score: int = 0
    is_extra: bool = False


@dataclass(frozen=True)
class TeamDecision:
    winner: str | None
    method: str | None  # victories | points | extra_bout
    wins: dict[str, int] = field(default_factory=lambda: {AKA: 0, AO: 0})
    points: dict[str, int] = field(default_factory=lambda: {AKA: 0, AO: 0})
    draws: int = 0
    needs_extra_bout: bool = False
    pending_bouts: int = 0
    reason: str | None = None
    extra_bout_needs_hantei: bool = False  # combate extra empatado con la regla «hantei»


def decide_team(
    bouts: list[BoutResult],
    planned_bouts: int,
    tie_rule: TeamTieRule,
    extra_tie: ExtraBoutTie = ExtraBoutTie.REPEAT,
) -> TeamDecision:
    """Resultado del enfrentamiento según los combates disputados hasta ahora."""
    regular = [b for b in bouts if not b.is_extra]
    extra = [b for b in bouts if b.is_extra]
    wins = {AKA: 0, AO: 0}
    points = {AKA: 0, AO: 0}
    draws = 0
    for b in regular:
        if not b.finished:
            continue
        points[AKA] += b.aka_score
        points[AO] += b.ao_score
        if b.winner in wins:
            wins[b.winner] += 1
        else:
            draws += 1
    total = max(planned_bouts, len(regular))
    pending = sum(1 for b in regular if not b.finished) + max(0, planned_bouts - len(regular))

    def result(winner: str | None, method: str | None, **kw) -> TeamDecision:
        return TeamDecision(winner, method, wins, points, draws, pending_bouts=pending, **kw)

    for color in (AKA, AO):
        if wins[color] * 2 > total:
            return result(color, "victories")
    if pending:
        return result(None, None)
    if wins[AKA] != wins[AO]:
        return result(AKA if wins[AKA] > wins[AO] else AO, "victories")
    if tie_rule == TeamTieRule.POINTS and points[AKA] != points[AO]:
        return result(AKA if points[AKA] > points[AO] else AO, "points")
    decided = [b for b in extra if b.finished and b.winner in (AKA, AO)]
    if decided:
        return result(decided[-1].winner, "extra_bout")
    drawn_extra = any(b.finished and b.winner is None for b in extra)
    if drawn_extra and extra_tie == ExtraBoutTie.HANTEI:
        return result(
            None,
            None,
            extra_bout_needs_hantei=True,
            reason="Combate extra empatado: corrígelo con la decisión de los jueces (hantei)",
        )
    reason = (
        "Empate en victorias y puntos: combate extra"
        if tie_rule == TeamTieRule.POINTS
        else "Empate en victorias: combate extra"
    )
    return result(None, None, needs_extra_bout=not any(not b.finished for b in extra), reason=reason)
