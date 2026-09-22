import json
from datetime import datetime, timezone

from splitset_sync.normalise import ACTIVITY_COLUMNS, is_run_type, normalise_activity, parse_local, parse_utc

USER = "00000000-0000-0000-0000-000000000001"


def rows(fixture_json):
    out = [normalise_activity(p, USER) for p in fixture_json("activities_sample.json")]
    return [r for r in out if r]


def test_all_three_real_activities_survive_and_the_idless_one_does_not(fixture_json):
    r = rows(fixture_json)
    assert [x["id"] for x in r] == ["i10000001", "i10000002", "i10000003"]
    assert all(x["user_id"] == USER for x in r)


def test_run_columns_map_and_scale(fixture_json):
    run = rows(fixture_json)[0]
    assert run["type"] == "Run"
    assert run["start_time"] == datetime(2026, 9, 20, 20, 12, 34, tzinfo=timezone.utc)
    assert run["start_time_local"] == datetime(2026, 9, 21, 6, 12, 34)
    assert run["timezone"] == "Australia/Melbourne"
    assert run["distance_m"] == 10012.4
    assert run["moving_time_s"] == 3005 and run["elapsed_time_s"] == 3050
    assert run["avg_hr"] == 146 and run["max_hr"] == 171
    assert run["cadence"] == 173.0                     # 86.5 per leg, doubled
    assert run["gct_ms"] == 241.0 and run["gct_pct"] == 32.5
    assert run["vert_osc_cm"] == 9.2                  # 92 mm
    assert run["vert_ratio"] == 8.1
    assert run["avg_power_w"] == 291
    assert run["vo2max"] == 52.3
    assert run["elev_gain_m"] == 84.0 and run["elev_loss_m"] == 80.5
    assert run["load"] == 78 and run["intensity"] == 82.4 and run["trimp"] == 95.1
    assert run["gap_ms"] == 3.41 and run["avg_temp_c"] == 11.0 and run["calories"] == 712
    assert run["resting_hr"] == 47 and run["weight_kg"] == 71.4
    assert run["lthr"] == 172 and run["athlete_max_hr"] == 190
    assert run["device"] == "Garmin Forerunner 265" and run["gear_id"] == "g123"
    assert run["hr_zone_times"] == [120, 900, 1500, 400, 85]
    assert run["hr_zones"] == [135, 150, 163, 172, 190]
    assert run["pace_zone_times"] == [200, 1200, 1300, 300, 5]
    assert json.loads(run["raw"])["id"] == "i10000001"


def test_ride_cadence_is_not_doubled(fixture_json):
    ride = rows(fixture_json)[1]
    assert ride["type"] == "Ride"
    assert ride["cadence"] == 88.0
    assert ride["gct_ms"] is None and ride["hr_zone_times"] is None


def test_strength_session_without_distance_is_kept(fixture_json):
    strength = rows(fixture_json)[2]
    assert strength["type"] == "WeightTraining"
    assert strength["distance_m"] is None
    assert strength["moving_time_s"] == 2700
    assert strength["load"] == 15


def test_row_has_every_activity_column(fixture_json):
    run = rows(fixture_json)[0]
    for col in ACTIVITY_COLUMNS:
        assert col in run, col
    assert "raw" in run and "id" in run and "user_id" in run


def test_missing_start_is_rejected():
    assert normalise_activity({"id": "i1", "type": "Run"}, USER) is None


def test_local_falls_back_to_utc_when_absent():
    r = normalise_activity({"id": "i1", "type": "Run", "start_date": "2026-01-01T10:00:00Z"}, USER)
    assert r["start_time_local"] == datetime(2026, 1, 1, 10, 0, 0)


def test_run_type_matching():
    assert is_run_type("Run") and is_run_type("TrailRun") and is_run_type("Virtual Run")
    assert not is_run_type("Ride") and not is_run_type(None)


def test_parsers():
    assert parse_utc("2026-01-01T10:00:00+10:00") == datetime(2026, 1, 1, 0, 0, tzinfo=timezone.utc)
    assert parse_utc("not a date") is None
    assert parse_local("2026-01-01T10:00:00+10:00") == datetime(2026, 1, 1, 10, 0)
