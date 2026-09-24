import random
from collections import Counter

import pytest

from app.domain.brackets import (
    Entrant,
    MatchKind,
    RRResult,
    ThirdPlaceRule,
    bye_positions,
    dependents,
    generate_single_elimination,
    resolve,
    round_robin_schedule,
    round_robin_standings,
    seeding_order,
)


def entrants(dojo_sizes: list[int]) -> list[Entrant]:
    out = []
    for d, n in enumerate(dojo_sizes):
        out += [Entrant(f"d{d}-e{i}", f"dojo{d}") for i in range(n)]
    return out


def play_all(bracket, pick=lambda m: m.aka):
    """Juega todos los combates eligiendo ganador con ``pick``."""
    winners: dict[str, str] = {}
    while True:
        res = resolve(bracket.slots, bracket.matches, winners, bracket.third_place_rule)
        todo = res.playable()
        if not todo:
            return res, winners
        for m in todo:
            winners[m.spec.code] = pick(m)


def test_seeding_order_matches_document():
    assert seeding_order(16)[:6] == [1, 16, 8, 9, 4, 13]
    assert sorted(seeding_order(64)) == list(range(1, 65))


def test_byes_face_top_ranks_and_are_balanced():
    order = seeding_order(16)
    byes = bye_positions(11, 16)
    assert len(byes) == 5
    for p in byes:
        partner = p ^ 1
        assert order[partner] <= 5  # el rival del bye es un rango alto
    halves = Counter(p < 8 for p in byes)
    assert abs(halves[True] - halves[False]) <= 1
    for p in byes:
        assert (p ^ 1) not in byes  # nunca bye contra bye


@pytest.mark.parametrize("n", range(2, 65))
def test_all_sizes_generate_complete_valid_brackets(n):
    rng = random.Random(n)
    es = [Entrant(f"e{i}", f"dojo{rng.randrange(max(1, n // 3))}") for i in range(n)]
    b = generate_single_elimination(es, seed=n)
    assert b.size >= n and b.size & (b.size - 1) == 0 and b.size < 2 * n
    assert sorted(s for s in b.slots if s) == sorted(e.id for e in es)
    res, _ = play_all(b)
    assert res.podium.complete
    assert res.podium.gold and res.podium.silver
    expected_bronzes = 2 if n >= 3 else 0
    if n == 3:
        expected_bronzes = 1  # una semifinal es bye
    assert len(res.podium.bronzes) == expected_bronzes
    medalists = [res.podium.gold, res.podium.silver, *res.podium.bronzes]
    assert len(set(medalists)) == len(medalists)


def lower_bound_conflicts(sizes: list[int], bracket_size: int) -> int:
    return sum(max(0, k - bracket_size // 2) for k in sizes)


@pytest.mark.parametrize("seed", range(200))
def test_dojo_separation_is_optimal_in_first_round(seed):
    rng = random.Random(seed)
    n = rng.randint(2, 64)
    sizes: list[int] = []
    left = n
    while left:
        k = rng.randint(1, max(1, min(left, rng.choice([2, 4, n]))))
        sizes.append(k)
        left -= k
    b = generate_single_elimination(entrants(sizes), seed=seed)
    assert b.same_dojo_first_round == lower_bound_conflicts(sizes, b.size)


def test_mock_case_four_of_eight_same_dojo_no_first_round_clash():
    b = generate_single_elimination(entrants([4, 2, 1, 1]), seed=7)
    assert b.same_dojo_first_round == 0
    # Además, los 4 del dojo principal quedan en cuartos distintos.
    quarters = {i // 2 for i, s in enumerate(b.slots) if s and s.startswith("d0-")}
    assert len(quarters) == 4


def test_two_of_same_dojo_land_in_opposite_halves():
    for seed in range(20):
        b = generate_single_elimination(entrants([2, 1, 1, 1, 1]), seed=seed)
        halves = {i < b.size // 2 for i, s in enumerate(b.slots) if s and s.startswith("d0-")}
        assert halves == {True, False}


def test_same_seed_same_bracket():
    es = entrants([3, 3, 2, 1, 1, 1])
    a = generate_single_elimination(es, seed=1234)
    b = generate_single_elimination(list(reversed(es)), seed=1234)
    assert a.slots == b.slots
    c = generate_single_elimination(es, seed=999)
    assert c.slots != a.slots or c.seed != a.seed


def test_seeded_entrants_take_seed_positions():
    es = entrants([2, 2, 2, 2])
    es[0] = Entrant(es[0].id, es[0].dojo_id, seed=1)
    es[3] = Entrant(es[3].id, es[3].dojo_id, seed=2)
    b = generate_single_elimination(es, seed=5)
    assert b.slots[0] == es[0].id
    assert b.slots[b.size // 2] == es[3].id  # la 2 va a la otra mitad


def test_single_entrant_is_champion_without_matches():
    b = generate_single_elimination([Entrant("solo", "x")], seed=1)
    res = resolve(b.slots, b.matches, {})
    assert res.podium.gold == "solo" and res.podium.complete


def test_direct_final_with_two():
    b = generate_single_elimination(entrants([1, 1]), seed=1)
    assert len(b.matches) == 1
    res = resolve(b.slots, b.matches, {"R1-1": b.slots[1]})
    assert res.podium.gold == b.slots[1] and res.podium.silver == b.slots[0]
    assert res.podium.bronzes == [] and res.podium.complete


def test_third_place_match_rule():
    b = generate_single_elimination(entrants([1] * 8), seed=3, third_place_rule=ThirdPlaceRule.THIRD_PLACE_MATCH)
    assert any(m.kind == MatchKind.THIRD_PLACE for m in b.matches)
    res, winners = play_all(b)
    assert len(res.podium.bronzes) == 1
    sf_losers = {res.matches["R2-1"].loser, res.matches["R2-2"].loser}
    assert res.podium.bronzes[0] in sf_losers
    assert res.podium.complete


def test_repechage_rule():
    b = generate_single_elimination(entrants([1] * 8), seed=3, third_place_rule=ThirdPlaceRule.REPECHAGE)
    res, winners = play_all(b)
    rep = [m for m in res.matches.values() if m.spec.kind == MatchKind.REPECHAGE]
    # Llave de 8: cada finalista venció a 2 rivales -> una pelea de repechaje por lado.
    assert len(rep) == 2
    assert len(res.podium.bronzes) == 2 and res.podium.complete
    finalists = {res.podium.gold, res.podium.silver}
    for m in rep:
        for side in (m.aka, m.ao):
            lost_to = next(x for x in res.matches.values() if x.spec.kind == MatchKind.MAIN and x.loser == side)
            assert lost_to.winner in finalists


def test_repechage_in_sixteen_builds_ladders():
    b = generate_single_elimination(entrants([1] * 16), seed=11, third_place_rule=ThirdPlaceRule.REPECHAGE)
    res, _ = play_all(b)
    rep = [m for m in res.matches.values() if m.spec.kind == MatchKind.REPECHAGE]
    assert len(rep) == 4  # 3 vencidos por finalista -> 2 peleas por escalera
    assert res.podium.complete and len(res.podium.bronzes) == 2


def test_correction_shows_affected_matches():
    b = generate_single_elimination(entrants([1] * 8), seed=3)
    assert dependents(b.matches, "R1-1") == ["R2-1", "R3-1"]
    res, winners = play_all(b)
    # Cambiar el ganador de R1-1 deja huérfano el resultado de R2-1.
    m = res.matches["R1-1"]
    winners["R1-1"] = m.loser
    res2 = resolve(b.slots, b.matches, winners)
    assert res2.matches["R2-1"].winner is None or res2.matches["R2-1"].winner != m.winner


def test_round_robin_schedule_everyone_meets_once():
    ids = ["a", "b", "c", "d", "e"]
    specs = round_robin_schedule(ids)
    pairs = {frozenset((ids[int(s.aka.ref)], ids[int(s.ao.ref)])) for s in specs}
    assert len(specs) == 10 and len(pairs) == 10


def test_round_robin_standings_with_head_to_head():
    results = [
        RRResult("a", "b", "a", 3, 1),
        RRResult("b", "c", "b", 2, 0),
        RRResult("c", "a", "c", 4, 0),
        RRResult("a", "d", "a", 1, 0),
        RRResult("b", "d", "b", 1, 0),
        RRResult("c", "d", "d", 0, 1),
    ]
    table = round_robin_standings(["a", "b", "c", "d"], results)
    # a y b con 2 victorias: a ganó el enfrentamiento directo.
    assert [s.entrant for s in table][:2] == ["a", "b"]
    assert table[0].rank == 1 and table[1].rank == 2
