from datetime import date, datetime, timedelta
from decimal import Decimal

import pytest

from app.domain.categories import (
    CategoryRule,
    Competitor,
    age_at,
    can_transition,
    grade_to_ordinal,
    registration_warnings,
    suggest_categories,
)
from app.domain.identity import PersonKey, find_duplicates, normalize_name
from app.domain.kata import (
    KataError,
    ScoringRules,
    decide_flags,
    kata_round_medals,
    rank_performances,
    score_performance,
)
from app.domain.kumite import (
    EventType,
    KumiteRules,
    MatchEvent,
    TieRule,
    compute_scoreboard,
    suggest_decision,
)

T0 = datetime(2026, 10, 1, 10, 0, 0)


def ev(i, type_, sec, **kw):
    return MatchEvent(id=f"e{i}", type=EventType(type_), at=T0 + timedelta(seconds=sec), **kw)


def test_scoreboard_from_events_with_annulment():
    events = [
        ev(1, "start", 0),
        ev(2, "point", 10, color="aka", value=2),
        ev(3, "resume", 12),
        ev(4, "point", 20, color="ao", value=1),  # color equivocado: el reloj se detuvo igual
        ev(5, "annul", 21, target_id="e4"),
        ev(6, "resume", 25),
        ev(7, "point", 30, color="aka", value=1),
    ]
    sb = compute_scoreboard(events, KumiteRules())
    assert sb.score == {"aka": 3, "ao": 0}
    assert sb.senshu == "aka"
    assert "e4" in sb.annulled_event_ids
    # tiempo efectivo: 0-10, 12-20 (pausa por el punto, aunque se anule), 25-30 -> 23 s
    assert sb.elapsed_seconds == pytest.approx(23)


def test_annul_of_annul_restores_event():
    events = [
        ev(1, "point", 1, color="ao", value=3),
        ev(2, "annul", 2, target_id="e1"),
        ev(3, "annul", 3, target_id="e2"),
    ]
    assert compute_scoreboard(events, KumiteRules()).score["ao"] == 3


def test_point_gap_victory():
    events = [ev(i, "point", i, color="aka", value=3) for i in range(1, 4)]
    d = suggest_decision(compute_scoreboard(events, KumiteRules()), KumiteRules(), time_over=False)
    assert d.winner == "aka" and d.method == "point_gap"


def test_tie_rules():
    events = [ev(1, "point", 1, color="ao", value=1), ev(2, "point", 2, color="aka", value=1)]
    sb = compute_scoreboard(events, KumiteRules())
    assert suggest_decision(sb, KumiteRules(tie_rule=TieRule.HANTEI), True).needs == "hantei"
    assert suggest_decision(sb, KumiteRules(tie_rule=TieRule.GOLDEN_POINT), True).needs == "golden_point"
    d = suggest_decision(sb, KumiteRules(tie_rule=TieRule.SENSHU_HANTEI), True)
    assert d.winner == "ao" and d.method == "senshu"
    sb2 = compute_scoreboard([*events, ev(3, "hantei", 3, color="aka")], KumiteRules())
    assert suggest_decision(sb2, KumiteRules(), True).winner == "aka"


def test_hansoku_and_finish_correction():
    events = [ev(1, "sanction", 1, color="ao", value=5)]
    sb = compute_scoreboard(events, KumiteRules())
    assert suggest_decision(sb, KumiteRules(), False).winner == "aka"
    events += [ev(2, "finish", 2, color="aka", method="hansoku"), ev(3, "finish", 3, color="ao", method="correction")]
    assert compute_scoreboard(events, KumiteRules()).winner == "ao"


def test_flags():
    assert decide_flags(["aka", "ao", "aka"], 3).winner == "aka"
    r = decide_flags(["aka", "ao", None, None], 5)
    assert r.needs_head_judge and r.winner is None
    # 2-1 con dos jueces sin votar no es mayoría de un panel de 5
    r = decide_flags(["aka", "ao", "aka", None, None], 5)
    assert r.needs_head_judge and r.winner is None
    assert decide_flags(["aka", "ao", "aka", "aka", None], 5).winner == "aka"
    assert decide_flags(["aka", "ao"], 3, head_judge_vote="ao").winner == "ao"
    with pytest.raises(KataError):
        decide_flags(["aka"], 4)


@pytest.mark.parametrize(
    "judges,scores,total",
    [
        (3, ["7.0", "7.5", "8.0"], Decimal("22.5")),
        (5, ["7.0", "7.5", "8.0", "8.5", "9.0"], Decimal("24.0")),
        (7, ["6.0", "7.0", "7.5", "8.0", "8.5", "9.0", "9.9"], Decimal("40.0")),
    ],
)
def test_kata_scoring_by_judges(judges, scores, total):
    assert score_performance(scores, ScoringRules(judges=judges)).total == total


def test_kata_validation():
    with pytest.raises(KataError):
        score_performance(["7.25", "7", "7"], ScoringRules(judges=3))
    with pytest.raises(KataError):
        score_performance(["4.9", "7", "7"], ScoringRules(judges=3))


def test_kata_tie_break_by_discarded_scores():
    r = ScoringRules(judges=5)
    results = {
        "a": score_performance(["7.0", "8.0", "8.0", "8.0", "9.0"], r),  # 24.0, min desc. 7.0
        "b": score_performance(["7.5", "8.0", "8.0", "8.0", "8.5"], r),  # 24.0, min desc. 7.5
        "c": score_performance(["7.5", "8.0", "8.0", "8.0", "9.5"], r),  # 24.0, 7.5, max 9.5
        "d": score_performance(["6.0", "6.0", "6.0", "6.0", "6.0"], r),
    }
    ranked = rank_performances(results)
    assert [p.entrant for p in ranked] == ["c", "b", "a", "d"]
    assert ranked[1].tie_break_used == ["max_discarded"]
    assert ranked[2].tie_break_used == ["min_discarded"]
    assert not any(p.unresolved_tie for p in ranked)
    medals = kata_round_medals(ranked, bronzes=2)
    assert medals == {1: ["c"], 2: ["b"], 3: ["a", "d"]}


def test_kata_unresolved_tie():
    r = ScoringRules(judges=3)
    ranked = rank_performances({"a": score_performance(["8", "8", "8"], r), "b": score_performance(["8", "8", "8"], r)})
    assert all(p.unresolved_tie for p in ranked)
    assert kata_round_medals(ranked) == {1: [], 2: [], 3: []}


def test_grades_and_age():
    assert grade_to_ordinal("10 kyu") == 1
    assert grade_to_ordinal("1 kyu") == 10
    assert grade_to_ordinal("2 DAN") == 12
    assert age_at(date(2014, 12, 31), date(2026, 12, 30)) == 11
    assert age_at(date(2014, 12, 31), date(2026, 12, 31)) == 12


def test_registration_warnings_and_suggestions():
    cat = CategoryRule("c1", "kumite", "M", 12, 13, grade_to_ordinal("10 kyu"), grade_to_ordinal("7 kyu"), "-45")
    ok = Competitor("M", date(2013, 5, 1), grade_to_ordinal("8 kyu"), "-45 kg")
    ref = date(2026, 10, 1)
    assert registration_warnings(ok, cat, ref) == []
    high = Competitor("M", date(2013, 5, 1), grade_to_ordinal("3 kyu"), "-45")
    codes = [w.code for w in registration_warnings(high, cat, ref)]
    assert codes == ["GRADE_ABOVE_MAX"]
    girl = Competitor("F", date(2010, 1, 1), None, None)
    codes = {w.code for w in registration_warnings(girl, cat, ref)}
    assert codes == {"SEX_MISMATCH", "AGE_ABOVE_MAX", "GRADE_UNKNOWN", "WEIGHT_UNKNOWN"}
    assert suggest_categories(ok, [cat], ref) == [cat]


def test_tournament_transitions():
    assert can_transition("draft", "registration_open")
    assert can_transition("finished", "in_progress")
    assert not can_transition("draft", "finished")


def test_duplicate_detection():
    a = PersonKey("1", "José Luis", "Pérez García", date(2012, 3, 4), "DNI", "71234567")
    existing = [
        PersonKey("2", "Jose Luis", "Perez Garcia", date(2012, 3, 4)),
        PersonKey("3", "Jose", "Peres Garcia", date(2012, 3, 4)),
        PersonKey("4", "Ana", "Torres", date(2012, 3, 4), "DNI", "71.234.567"),
        PersonKey("5", "Pedro", "Pérez", date(2012, 3, 4)),
    ]
    found = {d.person_id: d.reason for d in find_duplicates(a, existing)}
    assert found["2"] == "name_birth"
    assert found["3"] == "similar_name_birth"
    assert found["4"] == "document"
    assert "5" not in found
    assert normalize_name("  ÁNGEL   Ñuñez ") == "angel nunez"


def test_kata_tie_inside_same_medal_tier_does_not_block():
    r = ScoringRules(judges=3)
    res = {
        "a": score_performance(["9", "9", "9"], r),
        "b": score_performance(["8", "8", "8"], r),
        "c": score_performance(["7", "7", "7"], r),
        "d": score_performance(["7", "7", "7"], r),
        "e": score_performance(["6", "6", "6"], r),
    }
    ranked = rank_performances(res)
    medals = kata_round_medals(ranked, bronzes=2)
    assert medals[1] == ["a"] and medals[2] == ["b"] and set(medals[3]) == {"c", "d"}
    # Con un solo bronce, el empate 3.º/4.º sí bloquea el bronce
    assert kata_round_medals(ranked, bronzes=1) == {1: ["a"], 2: ["b"], 3: []}
    # Empate 1.º/2.º bloquea todo
    res["b"] = score_performance(["9", "9", "9"], r)
    assert kata_round_medals(rank_performances(res)) == {1: [], 2: [], 3: []}
