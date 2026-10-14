"""Turn an intervals.icu wellness record into a row for public.wellness.

Each record's `id` is the date. The field list is the reference project's WELLNESS_FIELDS
extended with the rest of the intervals.icu wellness record (HRV SDNN, sleep quality, body fat,
SpO2, stress, respiration, readiness, ramp rate, floors, sleeping HR) and the two custom Body
Battery fields. Not all of it is Garmin's: `stress` is intervals.icu's own 1-4 rating and
`readiness` is filled by Oura, not Garmin. The full record is kept in `raw`.
"""

from __future__ import annotations

import json
from datetime import date
from typing import Any

WELLNESS_FIELDS: dict[str, list[str]] = {
    "resting_hr":    ["restingHR", "resting_hr"],
    "hrv":           ["hrv"],
    "hrv_sdnn":      ["hrvSDNN"],
    "weight_kg":     ["weight"],
    "body_fat_pct":  ["bodyFat"],
    "sleep_s":       ["sleepSecs", "sleep_secs"],
    "sleep_score":   ["sleepScore", "sleep_score"],
    "sleep_quality": ["sleepQuality"],
    "vo2max":        ["vo2max"],
    "ctl":           ["ctl"],
    "atl":           ["atl"],
    "ramp_rate":     ["rampRate"],
    "steps":         ["steps"],
    "stress":        ["stress"],
    "respiration":   ["respiration"],
    "spo2":          ["spO2"],
    "readiness":     ["readiness"],
    # Garmin Body Battery only reaches intervals.icu as custom wellness fields with these codes
    "body_battery_max": ["BodyBatteryMax"],
    "body_battery_min": ["BodyBatteryMin"],
    "floors":        ["floorsClimbed"],
    "avg_sleeping_hr": ["avgSleepingHR"],
}

INT_COLS = {"resting_hr", "sleep_s", "sleep_quality", "steps", "body_battery_max", "body_battery_min", "floors"}
WELLNESS_COLUMNS: list[str] = list(WELLNESS_FIELDS)


def _num(v: Any) -> float | None:
    if v is None or v == "":
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if f != f else f


def parse_date(v: Any) -> date | None:
    if not v:
        return None
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


def normalise_wellness(rec: dict[str, Any], user_id: str) -> dict[str, Any] | None:
    """A typed row, or None when the record has no date or no metric at all."""
    d = parse_date(rec.get("id") or rec.get("date"))
    if d is None:
        return None
    row: dict[str, Any] = {"user_id": user_id, "date": d}
    any_value = False
    for col, options in WELLNESS_FIELDS.items():
        val = None
        for opt in options:
            if rec.get(opt) is not None:
                val = rec[opt]
                break
        f = _num(val)
        if f is not None:
            any_value = True
        row[col] = None if f is None else (int(round(f)) if col in INT_COLS else f)
    if not any_value:
        return None
    row["source"] = "intervals"
    row["raw"] = json.dumps(rec, separators=(",", ":"), allow_nan=False, default=str)
    return row
