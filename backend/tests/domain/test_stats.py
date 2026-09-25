"""Estadísticas derivadas de eventos: línea de tiempo, carrera, índice e insignias."""

from datetime import datetime, timedelta

from app.domain.kumite import EventType, KumiteRules, MatchEvent
from app.domain.stats import FightLine, MatchFacts, career, earned_badges, match_facts, mvp_index

T0 = datetime(2026, 10, 1, 10, 0, 0)
RULES = KumiteRules(duration_seconds=90)


def ev(i, type_, sec, **kw):
    return MatchEvent(id=f"e{i}", type=EventType(type_), at=T0 + timedelta(seconds=sec), **kw)


def test_timeline_uses_clock_time_and_skips_annulled_points():
    events = [
        ev(1, "start", 0),
        ev(2, "point", 10, color="aka", value=1),  # pausa automática en 10 s
        ev(3, "resume", 30),  # 20 s de pausa no cuentan
        ev(4, "point", 40, color="ao", value=3),
        ev(5, "annul", 45, target_id="e4"),
        ev(6, "resume", 50),
        ev(7, "point", 55, color="aka", value=2),
        ev(8, "finish", 60, color="aka", method="points"),
    ]
    f = match_facts(events, RULES)
    assert [(p.type, p.aka, p.ao) for p in f.timeline] == [("point", 1, 0), ("point", 3, 0), ("finish", 3, 0)]
    # 10 s + (40-30) antes del punto anulado + (55-50) = 25 s de reloj.
    assert [p.elapsed for p in f.timeline] == [10, 25, 25]
    assert f.points["aka"] == {"yuko": 1, "waza_ari": 1, "ippon": 0}
    assert f.points["ao"]["ippon"] == 0 and f.senshu == "aka" and f.score == {"aka": 3, "ao": 0}


def facts(aka, ao, senshu=None, elapsed=60.0, aka_ippon=0):
    f = MatchFacts()
    f.score = {"aka": aka, "ao": ao}
    f.points["aka"]["ippon"] = aka_ippon
    f.senshu = senshu
    f.elapsed = elapsed
    return f


def test_career_counts_streaks_methods_and_fastest_win():
    lines = [
        FightLine("aka", "win", "points", facts(4, 1, "aka", 70, aka_ippon=1)),
        FightLine("aka", "win", "walkover", facts(0, 0, elapsed=0)),
        FightLine("aka", "win", "point_gap", facts(8, 0, "aka", 41)),
        FightLine("ao", "loss", "points", facts(2, 1, "aka")),
        FightLine("aka", "draw", "draw", facts(1, 1, "aka")),
    ]
    st = career(lines)
    assert (st.matches, st.wins, st.losses, st.draws) == (5, 3, 1, 1)
    assert st.points_for == 4 + 0 + 8 + 1 + 1 and st.points_against == 1 + 0 + 0 + 2 + 1
    assert st.longest_streak == 3 and st.fastest_win == 41  # el walkover no es técnica
    assert st.wins_by_method == {"points": 1, "walkover": 1, "point_gap": 1}
    assert st.senshu == 3 and st.techniques["ippon"] == 1
    assert st.win_pct == 60.0


def test_mvp_index_and_badges():
    st = career([FightLine("aka", "win", "points", facts(3, 0, "aka", aka_ippon=1))])
    assert mvp_index(st, {"gold": 1}) == 10 + 30 + 3 + 1.5
    codes = {b.code for b in earned_badges(st, {"gold": 1}, 1, 1)}
    assert codes == {"first_match", "first_win", "ippon", "podium", "gold", "unbeaten"}
