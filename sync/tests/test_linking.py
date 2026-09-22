from datetime import date, datetime, timezone

from splitset_sync.linking import Candidate, Session, assign, choose, compatible


def act(id_, d, type_, dist, hour=7):
    return Candidate(id_, d, type_, dist, datetime(d.year, d.month, d.day, hour, tzinfo=timezone.utc))


D = date(2026, 9, 21)


def test_type_compatibility():
    assert compatible("run", "Run") and compatible("run", "VirtualRun")
    assert not compatible("run", "Ride")
    assert compatible("strength", "WeightTraining") and compatible("strength", "Workout")
    assert compatible("other", "Golf")
    assert not compatible("rest", "Run")


def test_choose_prefers_closest_distance_then_earliest():
    s = Session("s1", D, 0, "run", 10000)
    cands = [act("a", D, "Run", 5000, 6), act("b", D, "Run", 9800, 18), act("c", D, "Run", 9800, 7), act("d", D, "Ride", 10000)]
    assert choose(s, cands).id == "c"          # same gap as b, earlier start


def test_choose_without_target_takes_earliest():
    s = Session("s1", D, 0, "run", None)
    assert choose(s, [act("late", D, "Run", 5000, 18), act("early", D, "Run", 12000, 6)]).id == "early"


def test_choose_ignores_other_days_and_types():
    s = Session("s1", D, 0, "run", 8000)
    assert choose(s, [act("x", date(2026, 9, 22), "Run", 8000), act("y", D, "Walk", 8000)]) is None


def test_assign_uses_each_activity_once_in_plan_order():
    sessions = [Session("long", D, 1, "run", 20000), Session("easy", D, 0, "run", 6000)]
    cands = [act("a", D, "Run", 6100, 6), act("b", D, "Run", 19500, 9)]
    got = assign(sessions, cands)
    assert got == {"easy": "a", "long": "b"}


def test_assign_leaves_unmatched_sessions_alone():
    sessions = [Session("s1", D, 0, "strength", None), Session("s2", D, 1, "run", 5000)]
    got = assign(sessions, [act("a", D, "Run", 5000)])
    assert got == {"s2": "a"}
