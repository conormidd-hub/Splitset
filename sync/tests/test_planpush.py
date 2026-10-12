from datetime import date

from splitset_sync.planpush import digest, event_body, pace_band, plan_actions, steps_text

TODAY = date(2026, 10, 12)


def session(**kw):
    base = {"id": "s1", "date": date(2026, 10, 14), "type": "run", "subtype": "tempo", "title": "Tempo",
            "target_distance_m": 10000, "target_seconds": None, "steps": None, "status": "planned",
            "external_event_id": None, "external_hash": None}
    return {**base, **kw}


def stamp(s):
    return f"{s['date'].isoformat()}:{digest(event_body(s))}"


def test_simple_sessions_become_distance_or_time_steps():
    assert event_body(session())["description"] == "- 10km"
    assert event_body(session())["name"] == "Tempo - 10 km"
    body = event_body(session(target_distance_m=None, target_seconds=45 * 60, title="Easy – recovery"))
    assert body["description"] == "- 45m"           # minutes: "m" alone means minutes to intervals.icu
    assert body["name"] == "Easy - recovery"        # en dash flattened for the watch
    assert body["start_date_local"] == "2026-10-14T00:00:00" and body["category"] == "WORKOUT"


def test_only_runs_with_something_to_do_go_to_the_watch():
    assert event_body(session(type="strength")) is None
    assert event_body(session(subtype="race")) is None
    assert event_body(session(status="skipped")) is None
    assert event_body(session(target_distance_m=None)) is None


def test_steps_keep_repeats_and_pace_bands():
    steps = [{"km": 2, "kind": "easy"},
             {"rep": 5, "km": 1, "kind": "interval", "pace": "3:55-4:00", "recKm": 0.4, "recNote": "jog"},
             {"km": 2, "kind": "easy"}]
    assert steps_text(steps) == (
        "- 2km\n\n"
        "4x\n- 1km 3:48-4:08 pace\n- 0.4km\n\n- 1km 3:48-4:08 pace\n\n"
        "- 2km")
    assert event_body(session(steps=steps))["name"] == "Tempo - 10.6 km"
    assert pace_band("4:12") == "4:02-4:22"


def test_new_session_is_created_and_unchanged_one_left_alone():
    new = session()
    sent = session(id="s2", external_event_id="e2")
    sent["external_hash"] = stamp(sent)
    acts = plan_actions([new, sent], [], TODAY)
    assert [(a.kind, a.session_id) for a in acts] == [("create", "s1")]
    assert acts[0].stamp == stamp(new)


def test_a_moved_session_updates_its_event():
    s = session(external_event_id="e1")
    s["external_hash"] = stamp(s)
    moved = {**s, "date": date(2026, 10, 16)}
    (a,) = plan_actions([moved], [], TODAY)
    assert (a.kind, a.event_id, a.body["start_date_local"]) == ("update", "e1", "2026-10-16T00:00:00")
    assert a.stamp.startswith("2026-10-16:")


def test_skipped_or_moved_into_the_past_removes_the_event():
    s = session(external_event_id="e1")
    s["external_hash"] = stamp(s)
    assert [a.kind for a in plan_actions([{**s, "status": "skipped"}], [], TODAY)] == ["delete"]
    assert [a.kind for a in plan_actions([{**s, "date": date(2026, 10, 10)}], [], TODAY)] == ["delete"]


def test_history_is_left_alone():
    past = session(date=date(2026, 10, 5), external_event_id="e9")
    past["external_hash"] = stamp(past)
    assert plan_actions([past], [], TODAY) == []


def test_window_is_two_weeks_and_deleted_sessions_take_their_event():
    far = session(date=date(2026, 10, 26))
    edge = session(id="s3", date=date(2026, 10, 25))
    acts = plan_actions([far, edge], [{"id": 7, "event_id": 4242}], TODAY)
    assert [(a.kind, a.session_id, a.event_id, a.tombstone_id) for a in acts] == [
        ("delete", None, "4242", 7), ("create", "s3", None, None)]
