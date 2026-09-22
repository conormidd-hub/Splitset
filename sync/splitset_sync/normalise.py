"""Turn an intervals.icu activity payload into a row for public.activities.

The CANDIDATES map is ported from reference/sync.py and encodes the field names intervals.icu
actually uses: ground contact is "average_stance_time" (not any "ground_time" spelling),
vertical oscillation arrives in millimetres, and some devices report cadence per leg.

No filtering happens here: every activity type is kept, including strength sessions with no
distance. The caller decides what to skip.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

# our column -> candidate names in the payload, best first
CANDIDATES: dict[str, list[str]] = {
    "start_time":       ["start_date"],
    "start_time_local": ["start_date_local", "startDateLocal"],
    "timezone":         ["timezone"],
    "name":             ["name"],
    "type":             ["type"],
    "distance_m":       ["distance", "icu_distance"],
    "moving_time_s":    ["moving_time", "icu_moving_time", "elapsed_time"],
    "elapsed_time_s":   ["elapsed_time", "icu_elapsed_time"],
    "avg_hr":           ["average_heartrate", "icu_average_heartrate", "avg_hr"],
    "max_hr":           ["max_heartrate", "icu_max_heartrate", "max_hr"],
    "cadence":          ["average_cadence", "icu_average_cadence"],
    "stride_m":         ["average_stride", "icu_average_stride"],
    "gct_ms":           ["average_stance_time", "ground_time", "icu_ground_time"],
    "gct_pct":          ["average_stance_time_percent"],
    "vert_osc_mm":      ["average_vertical_oscillation", "vertical_oscillation"],
    "vert_ratio":       ["average_vertical_ratio"],
    "avg_power_w":      ["icu_average_watts", "average_watts"],
    "vo2max":           ["icu_vo2max", "vo2max"],
    "elev_gain_m":      ["total_elevation_gain", "icu_elevation_gain"],
    "elev_loss_m":      ["total_elevation_loss"],
    "load":             ["icu_training_load", "training_load"],
    "intensity":        ["icu_intensity", "intensity"],
    "trimp":            ["trimp"],
    "gap_ms":           ["gap"],
    "avg_temp_c":       ["average_temp", "avg_temp"],
    "calories":         ["calories", "icu_calories"],
    "resting_hr":       ["icu_resting_hr"],
    "weight_kg":        ["icu_weight"],
    "lthr":             ["lthr"],
    "athlete_max_hr":   ["athlete_max_hr"],
    "device":           ["device_name"],
    "gear_id":          ["gear_id"],
    "hr_zone_times":    ["icu_hr_zone_times"],
    "hr_zones":         ["icu_hr_zones"],
    "pace_zone_times":  ["pace_zone_times"],
}

INT_COLS = {"moving_time_s", "elapsed_time_s", "avg_hr", "max_hr", "resting_hr", "lthr", "athlete_max_hr"}
LIST_COLS = {"hr_zone_times", "hr_zones", "pace_zone_times"}
TEXT_COLS = {"name", "type", "timezone", "device", "gear_id"}

# Column order of public.activities, minus id/user_id/raw which are added explicitly.
ACTIVITY_COLUMNS: list[str] = [
    "start_time", "start_time_local", "timezone", "type", "name",
    "distance_m", "moving_time_s", "elapsed_time_s", "avg_hr", "max_hr", "cadence", "stride_m",
    "gct_ms", "gct_pct", "vert_osc_cm", "vert_ratio", "avg_power_w", "vo2max",
    "elev_gain_m", "elev_loss_m", "load", "intensity", "trimp", "gap_ms", "avg_temp_c", "calories",
    "resting_hr", "weight_kg", "lthr", "athlete_max_hr", "device", "gear_id",
    "hr_zone_times", "hr_zones", "pace_zone_times",
]

RUN_TYPES = {"run", "trailrun", "virtualrun", "treadmill"}


def is_run_type(activity_type: str | None) -> bool:
    return (activity_type or "").replace(" ", "").lower() in RUN_TYPES


def pick(payload: dict[str, Any], options: list[str]) -> Any:
    for opt in options:
        v = payload.get(opt)
        if v is not None and v != "":
            return v
    return None


def _num(v: Any) -> float | None:
    if v is None or v == "":
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f:  # NaN
        return None
    return f


def _int(v: Any) -> int | None:
    f = _num(v)
    return None if f is None else int(round(f))


def _int_list(v: Any) -> list[int] | None:
    if not isinstance(v, (list, tuple)):
        return None
    out = []
    for x in v:
        i = _int(x)
        out.append(0 if i is None else i)
    return out


def parse_utc(v: Any) -> datetime | None:
    """ISO 8601 with Z or offset -> aware UTC datetime. Naive input is assumed UTC."""
    if not v:
        return None
    s = str(v).strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def parse_local(v: Any) -> datetime | None:
    """Wall-clock local time as a naive datetime (any offset in the string is dropped)."""
    if not v:
        return None
    s = str(v).strip()
    if s.endswith("Z"):
        s = s[:-1]
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    return dt.replace(tzinfo=None)


def normalise_activity(payload: dict[str, Any], user_id: str) -> dict[str, Any] | None:
    """A typed row for public.activities, or None when the payload has no id or start time."""
    act_id = payload.get("id")
    if act_id in (None, ""):
        return None
    picked = {col: pick(payload, opts) for col, opts in CANDIDATES.items()}

    start_time = parse_utc(picked["start_time"]) or parse_utc(picked["start_time_local"])
    start_local = parse_local(picked["start_time_local"]) or (
        start_time.replace(tzinfo=None) if start_time else None)
    if start_time is None or start_local is None:
        return None

    row: dict[str, Any] = {"id": str(act_id), "user_id": user_id}
    for col in ACTIVITY_COLUMNS:
        if col == "start_time":
            row[col] = start_time
        elif col == "start_time_local":
            row[col] = start_local
        elif col == "vert_osc_cm":
            mm = _num(picked.get("vert_osc_mm"))
            row[col] = None if mm is None else round(mm / 10, 2)
        elif col in TEXT_COLS:
            v = picked.get(col)
            row[col] = None if v is None else str(v)
        elif col in INT_COLS:
            row[col] = _int(picked.get(col))
        elif col in LIST_COLS:
            row[col] = _int_list(picked.get(col))
        else:
            row[col] = _num(picked.get(col))

    # some devices report running cadence per leg; normalise to full steps per minute
    cad = row.get("cadence")
    if cad is not None and is_run_type(row["type"]) and cad < 120:
        row["cadence"] = round(cad * 2, 1)
    elif cad is not None:
        row["cadence"] = round(cad, 1)

    row["type"] = row["type"] or "Unknown"
    row["raw"] = json.dumps(payload, separators=(",", ":"), allow_nan=False, default=str)
    return row
