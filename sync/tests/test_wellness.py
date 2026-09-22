from datetime import date

from splitset_sync.wellness import WELLNESS_COLUMNS, normalise_wellness

USER = "00000000-0000-0000-0000-000000000001"


def test_full_record_maps_every_column():
    rec = {"id": "2026-09-21", "restingHR": 47, "hrv": 61.5, "hrvSDNN": 88.0, "weight": 71.4,
           "bodyFat": 12.1, "sleepSecs": 26100, "sleepScore": 81, "sleepQuality": 3, "vo2max": 52.3,
           "ctl": 41.2, "atl": 48.9, "rampRate": 1.1, "steps": 9800, "stress": 22, "respiration": 14.2,
           "spO2": 97, "readiness": 74}
    row = normalise_wellness(rec, USER)
    assert row["user_id"] == USER and row["date"] == date(2026, 9, 21)
    assert row["resting_hr"] == 47 and row["sleep_s"] == 26100 and row["steps"] == 9800
    assert row["sleep_quality"] == 3
    assert row["hrv"] == 61.5 and row["hrv_sdnn"] == 88.0 and row["spo2"] == 97
    assert row["source"] == "intervals"
    for col in WELLNESS_COLUMNS:
        assert col in row, col


def test_empty_day_is_skipped():
    assert normalise_wellness({"id": "2026-09-22"}, USER) is None
    assert normalise_wellness({"id": "2026-09-22", "hrv": None, "ctl": None}, USER) is None


def test_bad_or_missing_date_is_skipped():
    assert normalise_wellness({"hrv": 60}, USER) is None
    assert normalise_wellness({"id": "yesterday", "hrv": 60}, USER) is None


def test_partial_day_keeps_nulls():
    row = normalise_wellness({"id": "2026-09-22", "ctl": 40.0, "atl": 45.5}, USER)
    assert row["ctl"] == 40.0 and row["atl"] == 45.5
    assert row["hrv"] is None and row["resting_hr"] is None
