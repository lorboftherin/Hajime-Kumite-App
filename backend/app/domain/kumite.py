"""Marcador de kumite derivado de eventos inmutables (sección 18).

El marcador nunca se guarda: se calcula plegando la lista de eventos. Corregir
es agregar un evento (``annul`` apunta al evento anulado; un nuevo ``finish``
reemplaza al anterior).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum

from .brackets import AKA, AO

COLORS = (AKA, AO)


class EventType(StrEnum):
    POINT = "point"  # color, value (1, 2, 3)
    SANCTION = "sanction"  # color, value = índice del nivel en la escala (1..n)
    START = "start"
    PAUSE = "pause"
    RESUME = "resume"
    TIME_ADJUST = "time_adjust"  # value = segundos (+/-) sobre el tiempo transcurrido
    ANNUL = "annul"  # target_id
    SENSHU_CANCEL = "senshu_cancel"  # color que pierde el senshu
    HANTEI = "hantei"  # color ganador de la decisión
    KIKEN = "kiken"  # color que abandona
    SHIKKAKU = "shikkaku"  # color descalificado
    WALKOVER = "walkover"  # color que NO se presenta
    FINISH = "finish"  # color ganador + method


class TieRule(StrEnum):
    HANTEI = "hantei"
    GOLDEN_POINT = "golden_point"
    SENSHU_HANTEI = "senshu_hantei"


class TimeMode(StrEnum):
    EFFECTIVE = "effective"
    RUNNING = "running"


DEFAULT_SANCTIONS = ["Chui 1", "Chui 2", "Chui 3", "Hansoku-chui", "Hansoku"]


@dataclass(frozen=True)
class KumiteRules:
    duration_seconds: int = 120
    time_mode: TimeMode = TimeMode.EFFECTIVE
    auto_pause_on_point: bool = True
    point_values: tuple[int, ...] = (1, 2, 3)
    lead_victory: int | None = 8
    tie_rule: TieRule = TieRule.HANTEI
    sanction_levels: tuple[str, ...] = tuple(DEFAULT_SANCTIONS)

    @property
    def hansoku_level(self) -> int:
        return len(self.sanction_levels)


@dataclass(frozen=True)
class MatchEvent:
    id: str  # UUID generado por el cliente
    type: EventType
    at: datetime  # hora del dispositivo
    color: str | None = None
    value: float | None = None
    target_id: str | None = None
    method: str | None = None
    reason: str | None = None


@dataclass
class Scoreboard:
    score: dict[str, int] = field(default_factory=lambda: {AKA: 0, AO: 0})
    sanction: dict[str, int] = field(default_factory=lambda: {AKA: 0, AO: 0})  # nivel más alto
    senshu: str | None = None
    elapsed_seconds: float = 0.0
    running: bool = False
    started: bool = False
    hantei: str | None = None
    kiken: str | None = None
    shikkaku: str | None = None
    walkover: str | None = None
    winner: str | None = None
    method: str | None = None
    active_event_ids: list[str] = field(default_factory=list)
    annulled_event_ids: list[str] = field(default_factory=list)

    @property
    def finished(self) -> bool:
        return self.winner is not None


def other(color: str) -> str:
    return AO if color == AKA else AKA


def _active_events(events: list[MatchEvent]) -> tuple[list[MatchEvent], set[str]]:
    """Filtra eventos anulados. Anular una anulación restaura el original."""
    by_id = {e.id: e for e in events}
    memo: dict[str, bool] = {}

    def is_active(eid: str, depth: int = 0) -> bool:
        if eid in memo:
            return memo[eid]
        if depth > len(events):  # ciclo defensivo
            return True
        annullers = [e for e in events if e.type == EventType.ANNUL and e.target_id == eid]
        active = not any(is_active(a.id, depth + 1) for a in annullers)
        memo[eid] = active
        return active

    active = [e for e in events if e.type != EventType.ANNUL and is_active(e.id)]
    annulled = {eid for eid in by_id if by_id[eid].type != EventType.ANNUL and not is_active(eid)}
    return active, annulled


def compute_scoreboard(events: list[MatchEvent], rules: KumiteRules, now: datetime | None = None) -> Scoreboard:
    """Pliega los eventos (ordenados por hora del dispositivo) en un marcador."""
    ordered = sorted(events, key=lambda e: e.at)
    active, annulled = _active_events(ordered)
    sb = Scoreboard()
    sb.active_event_ids = [e.id for e in active]
    sb.annulled_event_ids = sorted(annulled)

    run_since: datetime | None = None
    senshu_cancelled: set[str] = set()
    auto_pause = rules.time_mode == TimeMode.EFFECTIVE and rules.auto_pause_on_point

    # Un punto anulado no cuenta para el marcador, pero la pausa automática que
    # provocó sí ocurrió en el tatami: el reloj estuvo detenido hasta el
    # siguiente "resume". Por eso el efecto sobre el tiempo se conserva.
    for e in ordered:
        if e.type == EventType.POINT and e.id in annulled and auto_pause and run_since is not None:
            sb.elapsed_seconds += (e.at - run_since).total_seconds()
            run_since = None
        if e.id in annulled or e.type == EventType.ANNUL:
            continue
        if e.type == EventType.START:
            sb.started = True
            if run_since is None:
                run_since = e.at
        elif e.type == EventType.RESUME:
            if run_since is None:
                run_since = e.at
        elif e.type == EventType.PAUSE:
            if run_since is not None:
                sb.elapsed_seconds += (e.at - run_since).total_seconds()
                run_since = None
        elif e.type == EventType.TIME_ADJUST:
            sb.elapsed_seconds += float(e.value or 0)
        elif e.type == EventType.POINT and e.color in COLORS:
            if sb.senshu is None and sb.score[AKA] == 0 and sb.score[AO] == 0:
                sb.senshu = e.color
            sb.score[e.color] += int(e.value or 0)
            if auto_pause and run_since is not None:
                sb.elapsed_seconds += (e.at - run_since).total_seconds()
                run_since = None
        elif e.type == EventType.SANCTION and e.color in COLORS:
            sb.sanction[e.color] = max(sb.sanction[e.color], int(e.value or 0))
        elif e.type == EventType.SENSHU_CANCEL and e.color in COLORS:
            senshu_cancelled.add(e.color)
        elif e.type == EventType.HANTEI:
            sb.hantei = e.color
        elif e.type == EventType.KIKEN:
            sb.kiken = e.color
        elif e.type == EventType.SHIKKAKU:
            sb.shikkaku = e.color
        elif e.type == EventType.WALKOVER:
            sb.walkover = e.color
        elif e.type == EventType.FINISH:
            # El último finish activo manda (una corrección agrega otro finish).
            sb.winner = e.color
            sb.method = e.method
            if run_since is not None:
                sb.elapsed_seconds += (e.at - run_since).total_seconds()
                run_since = None

    if sb.senshu in senshu_cancelled:
        sb.senshu = None
    if run_since is not None:
        sb.running = True
        if now is not None:
            sb.elapsed_seconds += max(0.0, (now - run_since).total_seconds())
    sb.elapsed_seconds = max(0.0, sb.elapsed_seconds)
    return sb


@dataclass(frozen=True)
class Decision:
    winner: str | None
    method: str | None
    needs: str | None = None  # "hantei" | "golden_point" | None
    reason: str | None = None


def suggest_decision(sb: Scoreboard, rules: KumiteRules, time_over: bool) -> Decision:
    """Ganador que el sistema sugiere según el estado del marcador.

    La mesa confirma (o corrige) con un evento ``finish``.
    """
    if sb.walkover:
        return Decision(other(sb.walkover), "walkover")
    if sb.shikkaku:
        return Decision(other(sb.shikkaku), "shikkaku")
    if sb.kiken:
        return Decision(other(sb.kiken), "kiken")
    for c in COLORS:
        if sb.sanction[c] >= rules.hansoku_level:
            return Decision(other(c), "hansoku")
    diff = sb.score[AKA] - sb.score[AO]
    if rules.lead_victory and abs(diff) >= rules.lead_victory:
        return Decision(AKA if diff > 0 else AO, "point_gap")
    if sb.hantei:
        return Decision(sb.hantei, "hantei")
    if not time_over:
        return Decision(None, None)
    if diff:
        return Decision(AKA if diff > 0 else AO, "points")
    if rules.tie_rule == TieRule.SENSHU_HANTEI and sb.senshu:
        return Decision(sb.senshu, "senshu")
    if rules.tie_rule == TieRule.GOLDEN_POINT:
        return Decision(None, None, needs="golden_point", reason="Empate: punto de oro")
    return Decision(None, None, needs="hantei", reason="Empate: decisión de jueces")


def finish_warnings(sb: Scoreboard, rules: KumiteRules, winner: str, time_over: bool) -> list[str]:
    """Advertencias si el ganador declarado no coincide con lo que dice el marcador."""
    suggestion = suggest_decision(sb, rules, time_over)
    if suggestion.winner and suggestion.winner != winner:
        return [f"El marcador sugiere como ganador a {suggestion.winner} ({suggestion.method})"]
    return []
