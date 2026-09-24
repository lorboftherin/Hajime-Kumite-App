"""Kumite por equipos: decisión del enfrentamiento (sección 15)."""

from app.domain.teams import BoutResult, TeamTieRule, decide_team

AKA, AO = "aka", "ao"


def win(color, aka=0, ao=0, extra=False):
    return BoutResult(True, color, aka, ao, extra)


def draw(score=0, extra=False):
    return BoutResult(True, None, score, score, extra)


PENDING = BoutResult(False)


def test_majority_decides_before_all_bouts():
    d = decide_team([win(AKA, 3, 0), win(AKA, 2, 1), PENDING], 3, TeamTieRule.POINTS)
    assert (d.winner, d.method, d.wins) == (AKA, "victories", {AKA: 2, AO: 0})
    assert d.pending_bouts == 1


def test_pending_without_majority():
    d = decide_team([win(AKA, 3, 0), win(AO, 0, 2), PENDING], 3, TeamTieRule.POINTS)
    assert d.winner is None and not d.needs_extra_bout and d.pending_bouts == 1


def test_bouts_not_yet_created_count_as_pending():
    d = decide_team([win(AKA, 3, 0)], 3, TeamTieRule.POINTS)
    assert d.winner is None and d.pending_bouts == 2


def test_more_victories_wins_with_draws():
    d = decide_team([win(AO, 0, 1), draw(2), draw(0)], 3, TeamTieRule.POINTS)
    assert (d.winner, d.method, d.draws) == (AO, "victories", 2)


def test_tie_in_victories_broken_by_points():
    d = decide_team([win(AKA, 5, 0), win(AO, 1, 2), draw(1)], 3, TeamTieRule.POINTS)
    assert (d.winner, d.method, d.points) == (AKA, "points", {AKA: 7, AO: 3})


def test_tie_in_victories_and_points_needs_extra_bout():
    d = decide_team([win(AKA, 2, 0), win(AO, 0, 2), draw(1)], 3, TeamTieRule.POINTS)
    assert d.winner is None and d.needs_extra_bout and "puntos" in d.reason


def test_extra_bout_rule_ignores_points():
    d = decide_team([win(AKA, 8, 0), win(AO, 0, 1), draw()], 3, TeamTieRule.EXTRA_BOUT)
    assert d.winner is None and d.needs_extra_bout


def test_extra_bout_decides_and_a_drawn_extra_asks_for_another():
    base = [win(AKA, 2, 0), win(AO, 0, 2), draw()]
    running = decide_team([*base, BoutResult(False, is_extra=True)], 3, TeamTieRule.EXTRA_BOUT)
    assert running.winner is None and not running.needs_extra_bout
    drawn = decide_team([*base, draw(extra=True)], 3, TeamTieRule.EXTRA_BOUT)
    assert drawn.winner is None and drawn.needs_extra_bout
    decided = decide_team([*base, draw(extra=True), win(AO, 0, 1, extra=True)], 3, TeamTieRule.EXTRA_BOUT)
    assert (decided.winner, decided.method) == (AO, "extra_bout")
    # Los puntos del combate extra no se suman al enfrentamiento.
    assert decided.points == {AKA: 2, AO: 2}


def test_five_bouts_need_three_victories():
    d = decide_team([win(AKA), win(AKA), win(AO), PENDING, PENDING], 5, TeamTieRule.POINTS)
    assert d.winner is None
    d = decide_team([win(AKA), win(AKA), win(AO), win(AKA), PENDING], 5, TeamTieRule.POINTS)
    assert d.winner == AKA
