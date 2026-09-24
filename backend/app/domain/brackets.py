"""Generación y resolución de llaves (secciones 17 y 27 del documento maestro).

Módulo puro: no conoce la base de datos. Trabaja con identificadores opacos
(``str``) de inscripciones y dojos, y devuelve estructuras inmutables que la
capa de servicios persiste.

Conceptos:

* **Slot**: posición en la primera ronda de una llave de eliminación directa.
  Contiene un participante o un *bye* (``None``).
* **MatchSpec**: combate de la estructura. Cada lado (aka / ao) proviene de un
  slot, del ganador de otro combate o del perdedor de otro combate.
* **resolve**: dado el resultado (ganador) de los combates jugados, calcula
  quién ocupa cada lado de cada combate, qué combates se resuelven solos por
  bye y el podio final.
"""

from __future__ import annotations

import math
import random
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from enum import StrEnum

AKA = "aka"
AO = "ao"


class ThirdPlaceRule(StrEnum):
    TWO_BRONZES = "two_bronzes"
    THIRD_PLACE_MATCH = "third_place_match"
    REPECHAGE = "repechage"


class MatchKind(StrEnum):
    MAIN = "main"
    THIRD_PLACE = "third_place"
    REPECHAGE = "repechage"


@dataclass(frozen=True)
class Entrant:
    id: str
    dojo_id: str | None = None
    seed: int | None = None  # cabeza de serie: 1 = primera


@dataclass(frozen=True)
class Source:
    """Origen de un lado de un combate."""

    kind: str  # "slot" | "winner" | "loser"
    ref: str | int  # posición del slot o código del combate

    @staticmethod
    def slot(position: int) -> Source:
        return Source("slot", position)

    @staticmethod
    def winner(match_code: str) -> Source:
        return Source("winner", match_code)

    @staticmethod
    def loser(match_code: str) -> Source:
        return Source("loser", match_code)


@dataclass(frozen=True)
class MatchSpec:
    code: str
    round: int  # 1 = primera ronda; en repechaje, ronda dentro del repechaje
    position: int  # orden dentro de la ronda
    aka: Source
    ao: Source
    kind: MatchKind = MatchKind.MAIN


@dataclass(frozen=True)
class GeneratedBracket:
    size: int
    slots: tuple[str | None, ...]  # posición -> id de inscripción o None (bye)
    matches: tuple[MatchSpec, ...]
    seed: int
    same_dojo_first_round: int
    third_place_rule: ThirdPlaceRule


# ---------------------------------------------------------------------------
# Siembra
# ---------------------------------------------------------------------------


def next_power_of_two(n: int) -> int:
    return 1 if n <= 1 else 1 << math.ceil(math.log2(n))


def seeding_order(size: int) -> list[int]:
    """Secuencia estándar de siembra: rango (1-based) en cada posición.

    Para 16: 1, 16, 8, 9, 4, 13, 5, 12, 2, 15, 7, 10, 3, 14, 6, 11.
    Rangos consecutivos quedan en mitades / cuartos opuestos.
    """
    if size < 1 or size & (size - 1):
        raise ValueError("size debe ser potencia de 2")
    order = [1]
    while len(order) < size:
        n = len(order) * 2
        order = [x for r in order for x in (r, n + 1 - r)]
    return order


def bye_positions(n_entrants: int, size: int) -> set[int]:
    """Posiciones (0-based) que quedan como bye.

    Los byes toman los rangos más bajos (n+1..size), de modo que caen frente a
    los rangos más altos, repartidos de forma equilibrada entre mitades.
    """
    order = seeding_order(size)
    return {pos for pos, rank in enumerate(order) if rank > n_entrants}


# ---------------------------------------------------------------------------
# Distribución con separación por dojo
# ---------------------------------------------------------------------------


def _dojo_key(e: Entrant) -> str:
    # Sin dojo: cada competidor es su propio "dojo" para no forzar separación.
    return e.dojo_id if e.dojo_id is not None else f"__solo__{e.id}"


def _place_positions(size: int, entrants: list[Entrant], rng: random.Random) -> dict[int, Entrant]:
    byes = bye_positions(len(entrants), size)
    order = seeding_order(size)
    rank_to_pos = {rank: pos for pos, rank in enumerate(order)}

    seeded = sorted((e for e in entrants if e.seed is not None), key=lambda e: e.seed)  # type: ignore[arg-type]
    placed: dict[int, Entrant] = {}
    for i, e in enumerate(seeded):
        placed[rank_to_pos[i + 1]] = e

    free = sorted(p for p in range(size) if p not in byes and p not in placed)
    pool = [e for e in entrants if e.seed is None]
    out: dict[int, Entrant] = {}
    if free:
        # Recursión sobre todo el rango para que la mitad izquierda/derecha
        # corresponda a las mitades reales de la llave.
        _distribute_full(size, free, pool, placed, rng, out)
    out.update(placed)
    return out


def _distribute_full(
    size: int,
    free: list[int],
    pool: list[Entrant],
    placed: dict[int, Entrant],
    rng: random.Random,
    out: dict[int, Entrant],
) -> None:
    # Recursión explícita sobre [0, size) para respetar las mitades reales.
    def rec(lo: int, hi: int, pos: list[int], pl: list[Entrant]) -> None:
        if not pl:
            return
        if hi - lo == 1:
            out[pos[0]] = pl[0]
            return
        mid = (lo + hi) // 2
        left_pos = [p for p in pos if p < mid]
        right_pos = [p for p in pos if p >= mid]
        left_pool, right_pool = _split(pl, len(left_pos), lo, mid, hi, placed, rng)
        rec(lo, mid, left_pos, left_pool)
        rec(mid, hi, right_pos, right_pool)

    rec(0, size, free, pool)


def _split(
    pool: list[Entrant],
    need_left: int,
    lo: int,
    mid: int,
    hi: int,
    placed: dict[int, Entrant],
    rng: random.Random,
) -> tuple[list[Entrant], list[Entrant]]:
    by_dojo: dict[str, list[Entrant]] = defaultdict(list)
    for e in pool:
        by_dojo[_dojo_key(e)].append(e)
    placed_left: Counter[str] = Counter(_dojo_key(e) for p, e in placed.items() if lo <= p < mid)
    placed_right: Counter[str] = Counter(_dojo_key(e) for p, e in placed.items() if mid <= p < hi)

    dojos = list(by_dojo)
    rng.shuffle(dojos)
    dojos.sort(key=lambda d: -len(by_dojo[d]))

    take_left: dict[str, int] = {}
    for d in dojos:
        total = len(by_dojo[d]) + placed_left[d] + placed_right[d]
        want = total // 2 - placed_left[d]
        take_left[d] = max(0, min(len(by_dojo[d]), want))

    def imbalance(d: str) -> int:
        left = placed_left[d] + take_left[d]
        right = placed_right[d] + len(by_dojo[d]) - take_left[d]
        return left - right

    while sum(take_left.values()) < need_left:
        cands = [d for d in dojos if take_left[d] < len(by_dojo[d])]
        best = min(imbalance(d) for d in cands)
        take_left[rng.choice([d for d in cands if imbalance(d) == best])] += 1
    while sum(take_left.values()) > need_left:
        cands = [d for d in dojos if take_left[d] > 0]
        best = max(imbalance(d) for d in cands)
        take_left[rng.choice([d for d in cands if imbalance(d) == best])] -= 1

    left: list[Entrant] = []
    right: list[Entrant] = []
    for d in dojos:
        members = by_dojo[d][:]
        rng.shuffle(members)
        k = take_left[d]
        left.extend(members[:k])
        right.extend(members[k:])
    return left, right


def count_same_dojo_first_round(slots: tuple[str | None, ...], dojo_of: dict[str, str | None]) -> int:
    n = 0
    for i in range(0, len(slots) - 1, 2):
        a, b = slots[i], slots[i + 1]
        if a and b and dojo_of.get(a) is not None and dojo_of.get(a) == dojo_of.get(b):
            n += 1
    return n


# ---------------------------------------------------------------------------
# Estructura de combates
# ---------------------------------------------------------------------------


def match_code(round_no: int, position: int) -> str:
    return f"R{round_no}-{position + 1}"


def build_single_elimination(size: int, third_place_rule: ThirdPlaceRule) -> list[MatchSpec]:
    """Combates de eliminación directa para una llave de ``size`` slots.

    El repechaje no se construye aquí: depende de quiénes llegan a la final y
    se calcula con :func:`repechage_matches` durante la resolución.
    """
    if size < 2:
        return []
    rounds = int(math.log2(size))
    matches: list[MatchSpec] = []
    for r in range(1, rounds + 1):
        n = size >> r
        for i in range(n):
            if r == 1:
                aka, ao = Source.slot(2 * i), Source.slot(2 * i + 1)
            else:
                aka = Source.winner(match_code(r - 1, 2 * i))
                ao = Source.winner(match_code(r - 1, 2 * i + 1))
            matches.append(MatchSpec(match_code(r, i), r, i, aka, ao))
    if third_place_rule == ThirdPlaceRule.THIRD_PLACE_MATCH and rounds >= 2:
        sf = rounds - 1
        matches.append(
            MatchSpec(
                "3P",
                rounds,
                1,
                Source.loser(match_code(sf, 0)),
                Source.loser(match_code(sf, 1)),
                MatchKind.THIRD_PLACE,
            )
        )
    return matches


def generate_single_elimination(
    entrants: list[Entrant],
    *,
    seed: int | None = None,
    third_place_rule: ThirdPlaceRule = ThirdPlaceRule.TWO_BRONZES,
) -> GeneratedBracket:
    """Genera una llave de eliminación directa con separación por dojo.

    Reproducible: la misma lista (mismo orden de ids), el mismo ``seed`` y la
    misma regla producen siempre la misma llave.
    """
    if len({e.id for e in entrants}) != len(entrants):
        raise ValueError("participantes duplicados")
    if seed is None:
        seed = random.SystemRandom().randrange(1, 2**31)
    rng = random.Random(seed)
    ordered = sorted(entrants, key=lambda e: e.id)
    size = next_power_of_two(max(len(ordered), 1))
    if len(ordered) <= 1:
        slots: tuple[str | None, ...] = tuple(e.id for e in ordered) or (None,)
        return GeneratedBracket(size, slots, (), seed, 0, third_place_rule)

    placed = _place_positions(size, ordered, rng)
    slots = tuple(placed[p].id if p in placed else None for p in range(size))
    dojo_of = {e.id: e.dojo_id for e in ordered}
    return GeneratedBracket(
        size=size,
        slots=slots,
        matches=tuple(build_single_elimination(size, third_place_rule)),
        seed=seed,
        same_dojo_first_round=count_same_dojo_first_round(slots, dojo_of),
        third_place_rule=third_place_rule,
    )


# ---------------------------------------------------------------------------
# Resolución: quién pelea, quién avanza, podio
# ---------------------------------------------------------------------------


@dataclass
class ResolvedMatch:
    spec: MatchSpec
    aka: str | None = None
    ao: str | None = None
    ready: bool = False  # ambos lados definidos (o bye)
    is_bye: bool = False  # se resuelve solo: un lado es bye
    winner: str | None = None
    loser: str | None = None

    @property
    def decided(self) -> bool:
        return self.winner is not None or (self.ready and self.aka is None and self.ao is None)


@dataclass
class Podium:
    gold: str | None = None
    silver: str | None = None
    bronzes: list[str] = field(default_factory=list)
    complete: bool = False

    def places(self) -> list[tuple[int, str]]:
        out: list[tuple[int, str]] = []
        if self.gold:
            out.append((1, self.gold))
        if self.silver:
            out.append((2, self.silver))
        out.extend((3, b) for b in self.bronzes)
        return out


@dataclass
class Resolution:
    matches: dict[str, ResolvedMatch]
    podium: Podium

    def playable(self) -> list[ResolvedMatch]:
        """Combates listos para disputarse (dos participantes, sin ganador)."""
        return [m for m in self.matches.values() if m.ready and not m.is_bye and m.winner is None]


_EMPTY = object()  # lado aún no definido


def resolve(
    slots: tuple[str | None, ...],
    matches: list[MatchSpec] | tuple[MatchSpec, ...],
    winners: dict[str, str],
    third_place_rule: ThirdPlaceRule = ThirdPlaceRule.TWO_BRONZES,
) -> Resolution:
    """Propaga resultados por la llave.

    ``winners`` mapea código de combate -> id del ganador. Ganadores que no
    correspondan a los participantes actuales del combate se ignoran (quedan
    como resultados huérfanos que el servicio reporta como afectados).
    """
    if len(slots) == 1 or not matches:
        podium = Podium(gold=slots[0] if slots and slots[0] else None)
        podium.complete = podium.gold is not None
        return Resolution({}, podium)

    all_specs = list(matches)
    resolved: dict[str, ResolvedMatch] = {}

    def side(src: Source):
        if src.kind == "slot":
            return slots[int(src.ref)]
        m = resolved.get(str(src.ref))
        if m is None or not m.ready:
            return _EMPTY
        if m.is_bye or m.winner is not None:
            return m.winner if src.kind == "winner" else m.loser
        if m.aka is None and m.ao is None:  # combate vacío (bye contra bye)
            return None
        return _EMPTY

    def settle(spec: MatchSpec) -> None:
        a, b = side(spec.aka), side(spec.ao)
        rm = ResolvedMatch(spec)
        if a is _EMPTY or b is _EMPTY:
            rm.aka = None if a is _EMPTY else a
            rm.ao = None if b is _EMPTY else b
            resolved[spec.code] = rm
            return
        rm.aka, rm.ao, rm.ready = a, b, True
        if a is None or b is None:
            rm.is_bye = True
            rm.winner = a if a is not None else b
            rm.loser = None
        else:
            w = winners.get(spec.code)
            if w in (a, b):
                rm.winner = w
                rm.loser = b if w == a else a
        resolved[spec.code] = rm

    for spec in sorted(all_specs, key=lambda s: (s.kind != MatchKind.MAIN, s.round, s.position)):
        settle(spec)

    main = [s for s in all_specs if s.kind == MatchKind.MAIN]
    final_round = max(s.round for s in main)
    final = resolved[match_code(final_round, 0)]
    podium = Podium()
    if final.winner:
        podium.gold, podium.silver = final.winner, final.loser

    if third_place_rule == ThirdPlaceRule.REPECHAGE and final_round >= 2:
        rep_specs = repechage_matches(resolved, final_round)
        for spec in rep_specs:
            settle(spec)
        all_specs.extend(rep_specs)

    podium.bronzes = _bronzes(resolved, final_round, third_place_rule)
    expected_bronzes = _expected_bronzes(resolved, final_round, third_place_rule)
    podium.complete = podium.gold is not None and len(podium.bronzes) >= expected_bronzes
    return Resolution(resolved, podium)


def _bronzes(resolved: dict[str, ResolvedMatch], final_round: int, rule: ThirdPlaceRule) -> list[str]:
    if final_round < 2:
        return []
    sf = [resolved[match_code(final_round - 1, i)] for i in range(2)]
    if rule == ThirdPlaceRule.TWO_BRONZES:
        return [m.loser for m in sf if m.loser]
    if rule == ThirdPlaceRule.THIRD_PLACE_MATCH:
        m = resolved.get("3P")
        if m and m.winner:
            return [m.winner]
        return []
    # Repechaje: el ganador de cada escalera. Si una escalera no existe
    # (finalista sin rivales vencidos), el bronce es del perdedor de semifinal.
    out = []
    for half in ("A", "B"):
        ladder = sorted(
            (
                m
                for m in resolved.values()
                if m.spec.kind == MatchKind.REPECHAGE and m.spec.code.startswith(f"REP{half}")
            ),
            key=lambda m: m.spec.round,
        )
        if ladder:
            if ladder[-1].winner:
                out.append(ladder[-1].winner)
        else:
            sf_m = sf[0 if half == "A" else 1]
            if sf_m.loser:
                out.append(sf_m.loser)
    return out


def _expected_bronzes(resolved: dict[str, ResolvedMatch], final_round: int, rule: ThirdPlaceRule) -> int:
    if final_round < 2:
        return 0
    sf = [resolved[match_code(final_round - 1, i)] for i in range(2)]
    real_sf = sum(1 for m in sf if not m.is_bye and m.ready)
    if rule == ThirdPlaceRule.THIRD_PLACE_MATCH:
        return 1 if real_sf == 2 else 0
    return real_sf


def repechage_matches(resolved: dict[str, ResolvedMatch], final_round: int) -> list[MatchSpec]:
    """Escaleras de repechaje (una por finalista).

    Participan quienes perdieron ante cada finalista, en orden de ronda: el
    perdedor de la ronda más temprana enfrenta al de la siguiente, y así hasta
    el perdedor de semifinal. El ganador de la última pelea recibe bronce.
    Solo se construye cuando ambas semifinales tienen ganador.
    """
    sfs = [resolved[match_code(final_round - 1, i)] for i in range(2)]
    if any(m.winner is None for m in sfs):
        return []
    specs: list[MatchSpec] = []
    for half, sf in zip(("A", "B"), sfs, strict=True):
        finalist = sf.winner
        # Combates (no bye) ganados por el finalista, por ronda.
        beaten = sorted(
            (
                m
                for m in resolved.values()
                if m.spec.kind == MatchKind.MAIN
                and m.spec.round < final_round
                and m.winner == finalist
                and not m.is_bye
                and m.loser
            ),
            key=lambda m: m.spec.round,
        )
        if len(beaten) < 2:
            continue  # solo el perdedor de semifinal: bronce directo
        prev: Source = Source.loser(beaten[0].spec.code)
        for step, m in enumerate(beaten[1:], start=1):
            code = f"REP{half}-{step}"
            specs.append(
                MatchSpec(code, step, 0 if half == "A" else 1, prev, Source.loser(m.spec.code), MatchKind.REPECHAGE)
            )
            prev = Source.winner(code)
    return specs


def dependents(matches: list[MatchSpec] | tuple[MatchSpec, ...], code: str) -> list[str]:
    """Combates que dependen (directa o indirectamente) del resultado de ``code``.

    Se usa para mostrar qué combates siguientes se ven afectados por una
    corrección tardía (sección 18).
    """
    children: dict[str, list[str]] = defaultdict(list)
    for s in matches:
        for src in (s.aka, s.ao):
            if src.kind in ("winner", "loser"):
                children[str(src.ref)].append(s.code)
    out: list[str] = []
    stack = list(children.get(code, []))
    seen: set[str] = set()
    while stack:
        c = stack.pop()
        if c in seen:
            continue
        seen.add(c)
        out.append(c)
        stack.extend(children.get(c, []))
    return sorted(out)


# ---------------------------------------------------------------------------
# Round robin
# ---------------------------------------------------------------------------


def round_robin_schedule(entrant_ids: list[str]) -> list[MatchSpec]:
    """Calendario todos contra todos (método del círculo).

    En round robin los lados apuntan a "slots" que son índices en la lista de
    participantes.
    """
    ids = list(range(len(entrant_ids)))
    if len(ids) < 2:
        return []
    if len(ids) % 2:
        ids.append(-1)
    n = len(ids)
    specs: list[MatchSpec] = []
    for r in range(n - 1):
        pos = 0
        for i in range(n // 2):
            a, b = ids[i], ids[n - 1 - i]
            if a != -1 and b != -1:
                if r % 2:
                    a, b = b, a
                specs.append(MatchSpec(f"RR{r + 1}-{pos + 1}", r + 1, pos, Source.slot(a), Source.slot(b)))
                pos += 1
        ids = [ids[0], ids[-1], *ids[1:-1]]
    return specs


@dataclass(frozen=True)
class RRResult:
    aka: str
    ao: str
    winner: str
    aka_points: int = 0
    ao_points: int = 0


@dataclass
class RRStanding:
    entrant: str
    wins: int = 0
    played: int = 0
    points_for: int = 0
    points_against: int = 0
    rank: int = 0
    tied: bool = False  # empate no resuelto por los criterios automáticos

    @property
    def diff(self) -> int:
        return self.points_for - self.points_against


def round_robin_standings(entrant_ids: list[str], results: list[RRResult]) -> list[RRStanding]:
    """Clasificación: victorias; desempate por enfrentamiento directo (mini-liga
    entre empatados), luego diferencia de puntos, luego puntos a favor.
    """
    table = {e: RRStanding(e) for e in entrant_ids}
    for r in results:
        for me, pts_for, pts_against in ((r.aka, r.aka_points, r.ao_points), (r.ao, r.ao_points, r.aka_points)):
            s = table[me]
            s.played += 1
            s.points_for += pts_for
            s.points_against += pts_against
        table[r.winner].wins += 1

    def h2h_wins(group: set[str], e: str) -> int:
        return sum(1 for r in results if r.winner == e and {r.aka, r.ao} <= group)

    ordered: list[RRStanding] = []
    by_wins: dict[int, list[RRStanding]] = defaultdict(list)
    for s in table.values():
        by_wins[s.wins].append(s)
    for wins in sorted(by_wins, reverse=True):
        group = by_wins[wins]
        names = {s.entrant for s in group}
        key = {s.entrant: (h2h_wins(names, s.entrant), s.diff, s.points_for) for s in group}
        group.sort(key=lambda s: (key[s.entrant], s.entrant), reverse=True)
        ordered.extend(group)

    rank = 0
    prev_key = None
    for i, s in enumerate(ordered):
        names = {x.entrant for x in ordered if x.wins == s.wins}
        k = (s.wins, h2h_wins(names, s.entrant), s.diff, s.points_for)
        if k != prev_key:
            rank = i + 1
        else:
            s.tied = True
            ordered[i - 1].tied = True
        s.rank = rank
        prev_key = k
    return ordered
