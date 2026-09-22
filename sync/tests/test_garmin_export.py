import json
from pathlib import Path

import pytest

from splitset_sync.garmin_export import COLUMNS, UPSERT, find_root, parse_export


@pytest.fixture
def export(tmp_path: Path) -> Path:
    root = tmp_path / "export" / "DI_CONNECT"
    (root / "DI-Connect-Aggregator").mkdir(parents=True)
    (root / "DI-Connect-Wellness").mkdir()
    (root / "DI-Connect-Metrics").mkdir()
    (root / "DI-Connect-Aggregator" / "UDSFile_2025-01-01_2025-01-31.json").write_text(json.dumps([
        {"calendarDate": "2025-01-01", "restingHeartRate": 48},
        {"calendarDate": "2025-01-02", "restingHeartRate": 0},
        {"calendarDate": "2025-01-03", "restingHeartRate": 51},
    ]), encoding="utf-8")
    (root / "DI-Connect-Wellness" / "2025-01-01_healthStatusData.json").write_text(json.dumps([
        {"calendarDate": "2025-01-01", "metrics": [
            {"type": "HRV", "value": 62, "baselineLowerLimit": 55, "baselineUpperLimit": 75},
            {"type": "RESPIRATION", "value": 14.5},
        ]},
        {"calendarDate": "2025-01-02", "metrics": [
            {"type": "HRV", "value": 58, "baselineLowerLimit": 0, "baselineUpperLimit": 0},
            {"type": "RESPIRATION", "value": 0},
        ]},
        {"metrics": [{"type": "HRV", "value": 99}]},
    ]), encoding="utf-8")
    (root / "DI-Connect-Metrics" / "MetricsMaxMetData_2025.json").write_text(json.dumps([
        {"calendarDate": "2025-01-03", "sport": "RUNNING", "vo2MaxValue": 51.0, "updateTimestamp": "2025-01-03T08:00:00"},
        {"calendarDate": "2025-01-03", "sport": "RUNNING", "vo2MaxValue": 52.0, "updateTimestamp": "2025-01-03T18:00:00"},
        {"calendarDate": "2025-01-03", "sport": "CYCLING", "vo2MaxValue": 60.0, "updateTimestamp": "2025-01-03T19:00:00"},
    ]), encoding="utf-8")
    return root


def test_find_root_accepts_parent_or_di_connect(export: Path):
    assert find_root(export) == export
    assert find_root(export.parent) == export
    with pytest.raises(SystemExit):
        find_root(export.parent.parent)


def test_parse_export_merges_sources_per_day(export: Path):
    days = parse_export(export)
    assert list(days) == ["2025-01-01", "2025-01-02", "2025-01-03"]
    assert days["2025-01-01"] == {"resting_hr": 48, "hrv": 62.0, "hrv_baseline_low": 55.0, "hrv_baseline_high": 75.0, "respiration": 14.5}
    assert days["2025-01-02"] == {"hrv": 58.0}          # zero RHR, placeholder band and zero respiration dropped
    assert days["2025-01-03"] == {"resting_hr": 51, "vo2max": 52.0}   # latest running estimate wins, cycling ignored


def test_upsert_keeps_existing_values():
    assert "coalesce(public.wellness.resting_hr, excluded.resting_hr)" in UPSERT
    for c in COLUMNS:
        assert f"coalesce(public.wellness.{c}, excluded.{c})" in UPSERT
    assert "'garmin_export'" in UPSERT
