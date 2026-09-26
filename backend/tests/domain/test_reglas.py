"""Reglas configurables (docs/reglas-configurables.md): dominio puro."""

import random
from datetime import date, datetime, timedelta
from decimal import Decimal

import pytest

from app.domain import brackets as bd
from app.domain.categories import (
    CategoryRule,
    Competitor,
    competition_age,
    parse_weight_range,
    registration_warnings,
    suggest_categories,
)
from app.domain.kata import (
    KataError,
    ScoringRules,
    decide_kata_match,
    qualifiers,
    rank_performances,
    score_performance,
)
from app.domain.kumite import (
    EventType,
    KumiteRules,
    MatchEvent,
    SanctionPreset,
    TieRule,
    compute_scoreboard,
    is_time_over,
    suggest_decision,
)
from app.domain.stats import FightLine, MatchFacts, career, earned_badges, mvp_index
from app.domain.teams import BoutResult, ExtraBoutTie, TeamTieRule, decide_team

T0 = datetime(2026, 10, 1, 10, 0, 0)


def ev(i, type_, sec, **kw):
    return MatchEvent(id=f"e{i}", type=EventType(type_), at=T0 + timedelta(seconds=sec), **kw)


# ---------------------------------------------------------------------------
# Estadísticas
# ---------------------------------------------------------------------------


def facts(aka=0, ao=0, elapsed=60.0):
    f = MatchFacts()
    f.score = {"aka": aka, "ao": ao}
    f.elapsed = elapsed
    return f


def test_walkover_and_uncontested_gold_do_not_feed_the_index():
    st = career([FightLine("aka", "win", "walkover", facts(elapsed=0))])
    assert st.walkover_wins == 1 and st.disputed == 0
    # Oro sin combate (1 inscrito) y victoria por walkover: valen el mínimo (0).
    assert mvp_index(st, {"gold": 1}, {"gold": 1}) == 0
    # El mismo oro, disputado, sí suma.
    assert mvp_index(st, {"gold": 1}) == 30


def test_first_match_badge_needs_a_disputed_match_or_kata():
    empty = career([])
    assert "first_match" not in {b.code for b in earned_badges(empty, {}, tournaments=1, unbeaten_golds=0)}
    wo = career([FightLine("aka", "win", "walkover", facts(elapsed=0))])
    assert "first_match" not in {b.code for b in earned_badges(wo, {}, 1, 0)}
    assert "first_match" in {b.code for b in earned_badges(empty, {}, 1, 0, kata_performed=1)}
    real = career([FightLine("aka", "loss", "points", facts(0, 2))])
    assert "first_match" in {b.code for b in earned_badges(real, {}, 1, 0)}


def test_fastest_win_only_counts_early_endings_relative_to_category_time():
    lines = [
        FightLine("aka", "win", "points", facts(3, 1, 20), 120),  # a tiempo cumplido: no cuenta
        FightLine("aka", "win", "point_gap", facts(8, 0, 60), 180),  # 1/3 del tiempo
        FightLine("aka", "win", "hansoku", facts(1, 0, 45), 90),  # 1/2 del tiempo
    ]
    st = career(lines)
    assert st.fastest_win == 60 and st.fastest_win_fraction == pytest.approx(1 / 3)


# ---------------------------------------------------------------------------
# Kumite: dos escaleras, senshu automático y punto de oro
# ---------------------------------------------------------------------------


def test_two_category_ladders_are_independent():
    rules = KumiteRules(sanction_preset=SanctionPreset.TWO_CATEGORIES, sanction_levels=("C", "K", "HC", "H"))
    events = [
        ev(1, "sanction", 1, color="aka", value=3, infraction="jogai"),
        ev(2, "sanction", 2, color="aka", value=2, infraction="excessive_contact"),
        ev(3, "sanction", 3, color="ao", value=1, infraction="other", ladder="c2"),
    ]
    sb = compute_scoreboard(events, rules)
    assert sb.sanction == {"aka": 2, "ao": 0} and sb.sanction_c2 == {"aka": 3, "ao": 1}
    assert suggest_decision(sb, rules, False).winner is None
    sb = compute_scoreboard([*events, ev(4, "sanction", 4, color="aka", value=4, infraction="mubobi")], rules)
    assert suggest_decision(sb, rules, False).winner == "ao"
    # Con una sola escalera (por defecto) todo va a la misma.
    single = compute_scoreboard(events, KumiteRules())
    assert single.sanction == {"aka": 3, "ao": 1} and single.sanction_c2 == {"aka": 0, "ao": 0}


def test_senshu_lost_automatically_in_the_last_seconds():
    base = [ev(1, "start", 0), ev(2, "point", 10, color="aka", value=1), ev(3, "resume", 12)]
    late = ev(4, "sanction", 110, color="aka", value=2)  # 108 s de reloj: dentro de los últimos 15 de 120
    rules_off = KumiteRules()
    rules_on = KumiteRules(senshu_auto_loss=True, senshu_loss_level=2)
    assert compute_scoreboard([*base, late], rules_off).senshu == "aka"
    sb = compute_scoreboard([*base, late], rules_on)
    assert sb.senshu is None and sb.senshu_lost == ["aka"]
    early = ev(4, "sanction", 30, color="aka", value=2)
    assert compute_scoreboard([*base, early], rules_on).senshu == "aka"
    low = ev(4, "sanction", 110, color="aka", value=1)
    assert compute_scoreboard([*base, low], rules_on).senshu == "aka"


def test_golden_point_period_and_first_point_wins():
    rules = KumiteRules(duration_seconds=60, tie_rule=TieRule.GOLDEN_POINT, golden_point_seconds=30)
    events = [ev(1, "start", 0), ev(2, "pause", 60)]
    sb = compute_scoreboard(events, rules)
    assert suggest_decision(sb, rules, is_time_over(sb, rules)).needs == "golden_point"
    events += [ev(3, "golden_point", 61), ev(4, "resume", 62)]
    sb = compute_scoreboard(events, rules, now=T0 + timedelta(seconds=70))
    assert sb.golden_point and not is_time_over(sb, rules)
    assert suggest_decision(sb, rules, is_time_over(sb, rules)).winner is None
    sb = compute_scoreboard([*events, ev(5, "point", 75, color="ao", value=1)], rules)
    d = suggest_decision(sb, rules, is_time_over(sb, rules))
    assert (d.winner, d.method) == ("ao", "golden_point")
    # Sin puntos al terminar el periodo extra: hantei.
    sb = compute_scoreboard([*events, ev(5, "pause", 100)], rules)
    assert is_time_over(sb, rules) and suggest_decision(sb, rules, True).needs == "hantei"


# ---------------------------------------------------------------------------
# Kata
# ---------------------------------------------------------------------------


def test_wkf_technical_athletic_scoring():
    rules = ScoringRules(judges=7, discard_each_side=2, split=True)
    tech = ["8.0", "8.2", "8.4", "8.4", "8.6", "8.8", "9.0"]  # quedan 8.4 8.4 8.6 = 25.4
    ath = ["8.0", "8.0", "8.2", "8.4", "8.4", "8.6", "9.0"]  # quedan 8.2 8.4 8.4 = 25.0
    r = score_performance(tech, rules, ath)
    assert r.technical == Decimal("25.4") and r.athletic == Decimal("25.0")
    assert r.total == Decimal("25.28")  # 25.4 * 0.7 + 25.0 * 0.3
    assert rules.counted == 3
    with pytest.raises(KataError):
        score_performance(tech, rules)


def test_kata_match_by_scores_and_tie_breaks():
    rules = ScoringRules(judges=5)
    aka = score_performance(["7.0", "7.5", "7.5", "7.5", "8.0"], rules)  # 22.5
    ao = score_performance(["7.2", "7.4", "7.5", "7.6", "7.8"], rules)  # 22.5, mínima descartada 7.2
    assert decide_kata_match(aka, ao) == "ao"
    same = score_performance(["7.0", "7.5", "7.5", "7.5", "8.0"], rules)
    assert decide_kata_match(aka, same) is None
    assert decide_kata_match(aka, same, head_judge_vote="aka") == "aka"


def test_qualifiers_blocked_by_a_tie_on_the_cut():
    rules = ScoringRules(judges=3)
    res = {
        "a": score_performance(["8.0", "8.0", "8.0"], rules),
        "b": score_performance(["7.5", "7.5", "7.5"], rules),
        "c": score_performance(["7.5", "7.5", "7.5"], rules),
        "d": score_performance(["7.0", "7.0", "7.0"], rules),
    }
    ranked = rank_performances(res)
    assert qualifiers(ranked, 1) == (["a"], True)
    assert qualifiers(ranked, 2)[1] is False  # b y c empatan en el corte
    assert qualifiers(ranked, 3)[1] is True


# ---------------------------------------------------------------------------
# Equipos
# ---------------------------------------------------------------------------


def test_drawn_extra_bout_needs_hantei_by_default_rule():
    bouts = [
        BoutResult(True, "aka", 3, 0),
        BoutResult(True, "ao", 0, 3),
        BoutResult(True, None, 1, 1),
        BoutResult(True, None, 0, 0, is_extra=True),
    ]
    d = decide_team(bouts, 3, TeamTieRule.EXTRA_BOUT, ExtraBoutTie.HANTEI)
    assert d.extra_bout_needs_hantei and not d.needs_extra_bout and d.winner is None
    d = decide_team(bouts, 3, TeamTieRule.EXTRA_BOUT, ExtraBoutTie.REPEAT)
    assert d.needs_extra_bout


# ---------------------------------------------------------------------------
# Categorías
# ---------------------------------------------------------------------------


def test_age_modes_and_weight_ranges():
    born = date(2013, 11, 20)
    ref = date(2026, 10, 1)
    assert competition_age(born, ref) == 12
    assert competition_age(born, ref, "birth_year") == 13
    cat = CategoryRule("c", "kumite", "M", 13, 13)
    comp = Competitor("M", born, None)
    assert [w.code for w in registration_warnings(comp, cat, ref)] == ["AGE_BELOW_MIN"]
    assert registration_warnings(comp, cat, ref, "birth_year") == []
    assert parse_weight_range("-45") == (None, Decimal("45"))
    assert parse_weight_range("+84 kg") == (Decimal("84"), None)
    assert parse_weight_range("45-50") == (Decimal("45"), Decimal("50"))
    assert parse_weight_range("Libre") == (None, None)


def test_suggestions_without_weight_ignore_weight_but_not_the_rest():
    ref = date(2026, 10, 1)
    heavy = CategoryRule("h", "kumite", "M", 12, 13, None, None, "+50")
    light = CategoryRule("l", "kumite", "M", 12, 13, None, None, "-50")
    girls = CategoryRule("g", "kumite", "F", 12, 13, None, None, "-50")
    no_weight = Competitor("M", date(2013, 5, 1), None, None)
    assert {c.id for c in suggest_categories(no_weight, [heavy, light, girls], ref)} == {"h", "l"}
    declared = Competitor("M", date(2013, 5, 1), None, "-50")
    assert {c.id for c in suggest_categories(declared, [heavy, light, girls], ref)} == {"l"}


# ---------------------------------------------------------------------------
# Llaves
# ---------------------------------------------------------------------------


def results_rr():
    # a vence a b y c; b vence a c; d vence a a; c vence a d; b vence a d
    return [
        bd.RRResult("a", "b", "a", 3, 1),
        bd.RRResult("a", "c", "a", 2, 0),
        bd.RRResult("b", "c", "b", 1, 0),
        bd.RRResult("d", "a", "d", 4, 0),
        bd.RRResult("c", "d", "c", 2, 1),
        bd.RRResult("b", "d", "b", 5, 0),
    ]


def test_round_robin_criteria_are_configurable():
    ids = ["a", "b", "c", "d"]
    default = bd.round_robin_standings(ids, results_rr())
    # a y b con 2 victorias: a ganó el directo.
    assert [s.entrant for s in default][:2] == ["a", "b"]
    by_diff = bd.round_robin_standings(ids, results_rr(), ("wins", "diff"))
    # diferencia: b = +5, a = +1
    assert [s.entrant for s in by_diff][:2] == ["b", "a"]
    by_sanctions = bd.round_robin_standings(ids, results_rr(), ("wins", "fewer_sanctions"), {"a": 3, "b": 1})
    assert [s.entrant for s in by_sanctions][:2] == ["b", "a"]
    drawn = bd.round_robin_standings(ids, results_rr(), ("wins", "draw"), draw_seed=7)
    assert not any(s.tied for s in drawn)
    with pytest.raises(ValueError):
        bd.round_robin_standings(ids, [], ("wins", "karma"))


def test_round_robin_two_bronzes():
    ids = ["a", "b", "c", "d", "e"]
    res = [bd.RRResult(x, y, x) for i, x in enumerate(ids) for y in ids[i + 1 :]]
    st = bd.round_robin_standings(ids, res)
    assert bd.round_robin_places(st, 1) == ([(1, "a"), (2, "b"), (3, "c")], True)
    assert bd.round_robin_places(st, 2) == ([(1, "a"), (2, "b"), (3, "c"), (3, "d")], True)


def test_repechage_excludes_losers_by_kiken_shikkaku_or_hansoku():
    ents = [bd.Entrant(str(i)) for i in range(8)]
    g = bd.generate_single_elimination(ents, seed=3, third_place_rule=bd.ThirdPlaceRule.REPECHAGE)
    specs = list(g.matches)
    winners = {}
    # El de arriba gana siempre: el finalista A vence en R1-1, R2-1 y la semifinal.
    for rnd in (1, 2):
        for m in [s for s in specs if s.round == rnd]:
            res = bd.resolve(g.slots, specs, winners, bd.ThirdPlaceRule.REPECHAGE)
            winners[m.code] = res.matches[m.code].aka
    full = bd.resolve(g.slots, specs, winners, bd.ThirdPlaceRule.REPECHAGE)
    assert {s.spec.code for s in full.matches.values() if s.spec.kind == bd.MatchKind.REPECHAGE} == {"REPA-1", "REPB-1"}
    # El perdedor de R1-1 perdió por kiken: no entra; el de semifinal recibe bronce directo.
    excl = bd.resolve(g.slots, specs, winners, bd.ThirdPlaceRule.REPECHAGE, {"R1-1"})
    reps = {s.spec.code for s in excl.matches.values() if s.spec.kind == bd.MatchKind.REPECHAGE}
    assert reps == {"REPB-1"}
    loser_sf_a = full.matches["R2-1"].loser
    assert loser_sf_a in excl.podium.bronzes


def test_city_is_a_second_separation_criterion():
    # 8 dojos distintos, 4 de Lima y 4 de Arequipa: sin ciudad pueden cruzarse
    # dos de la misma ciudad; con ciudad, ninguno en primera ronda.
    ents = [bd.Entrant(str(i), f"d{i}", None, "Lima" if i < 4 else "Arequipa") for i in range(8)]
    city = {e.id: e.city for e in ents}
    for seed in range(20):
        g = bd.generate_single_elimination(ents, seed=seed)
        assert bd.count_same_dojo_first_round(g.slots, city) == 0
    # Sin ciudad, la llave es la de siempre.
    plain = [bd.Entrant(e.id, e.dojo_id) for e in ents]
    assert bd.generate_single_elimination(plain, seed=5).slots == bd.generate_single_elimination(plain, seed=5).slots


def test_best_bye_position_avoids_same_dojo():
    slots = ["1", None, "2", None, "3", "4", "5", "6"]
    dojo = {"1": "A", "2": "B", "3": "A", "4": "C", "5": "D", "6": "E"}
    assert bd.best_bye_position(slots, [1, 3], "A", dojo) == 3
    assert bd.best_bye_position(slots, [1, 3], "B", dojo) == 1
    assert bd.best_bye_position(slots, [1, 3], "Z", dojo) == 1  # empate: la posición más baja


def test_groups_split_and_knockout_crosses():
    ents = [bd.Entrant(str(i), f"d{i % 3}") for i in range(12)]
    groups = bd.split_groups(ents, 4, random.Random(1))
    assert sorted(len(g) for g in groups) == [3, 3, 3, 3]
    assert all(len({e.dojo_id for e in g}) == 3 for g in groups)  # sin repetir dojo en un grupo
    size, layout = bd.knockout_positions(2, 2)
    assert size == 4
    pairs = {frozenset([layout[i], layout[i + 1]]) for i in range(0, 4, 2)}
    assert pairs == {frozenset([(0, 1), (1, 2)]), frozenset([(1, 1), (0, 2)])}  # A1–B2 y B1–A2
    size, layout = bd.knockout_positions(4, 2)
    for i in range(0, size, 2):
        assert layout[i][0] != layout[i + 1][0]
    halves = [layout[: size // 2], layout[size // 2 :]]
    for g in range(4):
        assert sum(1 for h in halves if any(q and q[0] == g for q in h)) == 2  # 1.º y 2.º en mitades distintas
