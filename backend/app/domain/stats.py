"""Estadísticas deportivas derivadas de los eventos de la mesa.

Inspiradas en las apps de scoring de otros deportes (p. ej. CricHeroes):
línea de tiempo del marcador («worm»), perfil con números de carrera,
premios automáticos del torneo e insignias. Todo se calcula a partir de los
eventos inmutables: no hay datos que se carguen dos veces.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .brackets import AKA, AO
from .kumite import EventType, KumiteRules, MatchEvent, _active_events, compute_scoreboard

POINT_NAMES = {1: "yuko", 2: "waza_ari", 3: "ippon"}
# Cierres que no son técnica (se muestran así en la hoja del combate).
NON_TECHNICAL = {"walkover", "kiken", "shikkaku", "bye", "draw", "decision", "flags", "hansoku"}
# «Victoria más rápida»: solo cierres antes del tiempo por mérito propio
# (ippon, diferencia de puntos o hansoku del rival). Una victoria por puntos al
# terminar el tiempo dura siempre lo mismo y no dice nada de rapidez.
FAST_WIN_METHODS = {"ippon", "point_gap", "hansoku"}
# Combates que no se disputaron: no cuentan como «subió al tatami».
NOT_DISPUTED = {"walkover", "bye"}


@dataclass(frozen=True)
class TimelinePoint:
    """Un momento del combate: tiempo transcurrido y marcador acumulado."""

    elapsed: float
    aka: int
    ao: int
    type: str  # point | sanction | finish
    color: str | None
    value: int | None
    event_id: str


@dataclass
class MatchFacts:
    score: dict[str, int] = field(default_factory=lambda: {AKA: 0, AO: 0})
    points: dict[str, dict[str, int]] = field(
        default_factory=lambda: {c: {n: 0 for n in POINT_NAMES.values()} for c in (AKA, AO)}
    )
    senshu: str | None = None
    sanction: dict[str, int] = field(default_factory=lambda: {AKA: 0, AO: 0})
    elapsed: float = 0.0  # al cierre (o al último evento)
    timeline: list[TimelinePoint] = field(default_factory=list)


def match_facts(events: list[MatchEvent], rules: KumiteRules) -> MatchFacts:
    """Hechos del combate: marcador, técnicas por tipo, senshu y la línea de
    tiempo con el tiempo de reloj de cada punto (respetando pausas, ajustes y
    anulaciones igual que el marcador)."""
    ordered = sorted(events, key=lambda e: e.at)
    active, _ = _active_events(ordered)
    active_ids = {e.id for e in active}
    facts = MatchFacts()
    for i, e in enumerate(ordered):
        if e.id not in active_ids or e.type not in (EventType.POINT, EventType.SANCTION, EventType.FINISH):
            continue
        sb = compute_scoreboard(ordered[: i + 1], rules)
        value = int(e.value) if e.value is not None else None
        facts.timeline.append(
            TimelinePoint(sb.elapsed_seconds, sb.score[AKA], sb.score[AO], e.type.value, e.color, value, e.id)
        )
        if e.type == EventType.POINT and e.color in (AKA, AO) and value in POINT_NAMES:
            facts.points[e.color][POINT_NAMES[value]] += 1
    final = compute_scoreboard(ordered, rules)
    facts.score = dict(final.score)
    facts.senshu = final.senshu
    facts.sanction = dict(final.sanction)
    facts.elapsed = final.elapsed_seconds
    return facts


# ---------------------------------------------------------------------------
# Perfil de carrera
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FightLine:
    """Un combate de kumite desde el punto de vista de un competidor."""

    color: str
    result: str  # win | loss | draw
    method: str | None
    facts: MatchFacts
    duration: float | None = None  # tiempo reglamentario de la categoría (s)


@dataclass
class CareerStats:
    matches: int = 0
    wins: int = 0
    losses: int = 0
    draws: int = 0
    points_for: int = 0
    points_against: int = 0
    techniques: dict[str, int] = field(default_factory=lambda: {n: 0 for n in POINT_NAMES.values()})
    techniques_against: dict[str, int] = field(default_factory=lambda: {n: 0 for n in POINT_NAMES.values()})
    senshu: int = 0
    wins_by_method: dict[str, int] = field(default_factory=dict)
    fastest_win: float | None = None  # segundos de reloj de la victoria más rápida
    # Fracción del tiempo de la categoría que duró esa victoria (0–1): compara
    # categorías de distinta duración (un combate de 90 s contra uno de 180 s).
    fastest_win_fraction: float | None = None
    longest_streak: int = 0
    walkover_wins: int = 0  # victorias sin combate (el rival no se presentó)
    disputed: int = 0  # combates realmente disputados (sin walkover)

    @property
    def win_pct(self) -> float | None:
        return round(100 * self.wins / self.matches, 1) if self.matches else None

    @property
    def senshu_pct(self) -> float | None:
        scored = self.matches - self.draws
        return round(100 * self.senshu / scored, 1) if scored > 0 else None

    @property
    def avg_points(self) -> float | None:
        return round(self.points_for / self.matches, 2) if self.matches else None


def career(lines: list[FightLine]) -> CareerStats:
    """Números de carrera a partir de sus combates en orden cronológico."""
    st = CareerStats()
    streak = 0
    best_key: tuple[float, float] | None = None
    for ln in lines:
        other = AO if ln.color == AKA else AKA
        st.matches += 1
        st.points_for += ln.facts.score[ln.color]
        st.points_against += ln.facts.score[other]
        for k, v in ln.facts.points[ln.color].items():
            st.techniques[k] += v
        for k, v in ln.facts.points[other].items():
            st.techniques_against[k] += v
        if ln.facts.senshu == ln.color:
            st.senshu += 1
        if ln.method not in NOT_DISPUTED:
            st.disputed += 1
        if ln.result == "win":
            st.wins += 1
            streak += 1
            st.longest_streak = max(st.longest_streak, streak)
            method = ln.method or "points"
            st.wins_by_method[method] = st.wins_by_method.get(method, 0) + 1
            if method == "walkover":
                st.walkover_wins += 1
            if method in FAST_WIN_METHODS and ln.facts.elapsed > 0:
                frac = ln.facts.elapsed / ln.duration if ln.duration else None
                key = (frac if frac is not None else ln.facts.elapsed, ln.facts.elapsed)
                if best_key is None or key < best_key:
                    best_key = key
                    st.fastest_win, st.fastest_win_fraction = ln.facts.elapsed, frac
        elif ln.result == "loss":
            st.losses += 1
            streak = 0
        else:
            st.draws += 1
    return st


# ---------------------------------------------------------------------------
# Índice Hajime (MVP) e insignias
# ---------------------------------------------------------------------------

# Pesos del índice: la victoria y el podio pesan más que la técnica, y la
# técnica limpia (ippon) más que la acumulación de yukos. Recibir puntos y
# sanciones resta un poco. Es un índice para reconocer, no un ranking oficial.
#
# Lo que se gana sin competir vale el mínimo configurado aquí (por defecto 0):
# ``walkover_win`` reemplaza a ``win`` en una victoria por walkover y
# ``uncontested_medal`` al valor de la medalla cuando el competidor no disputó
# ningún combate ni ejecutó kata en esa categoría (p. ej. oro con 1 inscrito).
MVP_WEIGHTS = {
    "win": 10.0,
    "walkover_win": 0.0,
    "gold": 30.0,
    "silver": 18.0,
    "bronze": 10.0,
    "uncontested_medal": 0.0,
    "ippon": 3.0,
    "waza_ari": 2.0,
    "yuko": 1.0,
    "senshu": 1.5,
    "point_against": -0.5,
}


def mvp_index(st: CareerStats, medals: dict[str, int], uncontested: dict[str, int] | None = None) -> float:
    """``medals`` cuenta todas las medallas; ``uncontested`` cuántas de ellas
    (por tipo) se obtuvieron sin competir, que valen ``uncontested_medal``."""
    w = MVP_WEIGHTS
    unc = uncontested or {}
    score = (
        (st.wins - st.walkover_wins) * w["win"]
        + st.walkover_wins * w["walkover_win"]
        + sum((medals.get(k, 0) - unc.get(k, 0)) * w[k] for k in ("gold", "silver", "bronze"))
        + sum(unc.get(k, 0) for k in ("gold", "silver", "bronze")) * w["uncontested_medal"]
        + sum(st.techniques[k] * w[k] for k in POINT_NAMES.values())
        + st.senshu * w["senshu"]
        + st.points_against * w["point_against"]
    )
    return round(max(score, 0.0), 1)


@dataclass(frozen=True)
class Badge:
    code: str
    name: str
    kanji: str
    description: str


BADGES = (
    Badge("first_match", "Primer combate", "初", "Subió al tatami en un torneo oficial"),
    Badge("first_win", "Primera victoria", "勝", "Ganó su primer combate"),
    Badge("ippon", "Ippon", "一", "Marcó un ippon (3 puntos)"),
    Badge("podium", "Podio", "賞", "Subió al podio en una categoría"),
    Badge("gold", "Oro", "金", "Ganó una categoría"),
    Badge("unbeaten", "Invicto", "無", "Ganó una categoría sin perder un combate"),
    Badge("wins_10", "Diez victorias", "十", "Diez combates ganados"),
    Badge("wins_50", "Cincuenta victorias", "五", "Cincuenta combates ganados"),
    Badge("senshu_10", "Senshu", "先", "Tomó la primera ventaja en diez combates"),
    Badge("tournaments_5", "Constancia", "道", "Compitió en cinco torneos"),
)


def earned_badges(
    st: CareerStats, medals: dict[str, int], tournaments: int, unbeaten_golds: int, kata_performed: int = 0
) -> list[Badge]:
    """``first_match`` exige un combate disputado (no un walkover) o una
    ejecución de kata con nota o decisión: inscribirse no basta."""
    got = {
        "first_match": st.disputed >= 1 or kata_performed >= 1,
        "first_win": st.wins >= 1,
        "ippon": st.techniques["ippon"] >= 1,
        "podium": sum(medals.values()) >= 1,
        "gold": medals.get("gold", 0) >= 1,
        "unbeaten": unbeaten_golds >= 1,
        "wins_10": st.wins >= 10,
        "wins_50": st.wins >= 50,
        "senshu_10": st.senshu >= 10,
        "tournaments_5": tournaments >= 5,
    }
    return [b for b in BADGES if got[b.code]]
