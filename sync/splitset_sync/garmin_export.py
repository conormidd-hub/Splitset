"""Backfill daily wellness from a Garmin account export.

intervals.icu only has wellness from the day it was connected. Garmin's own export (Account ->
Data Management -> Export Your Data) holds the full history. Point this at the unzipped
DI_CONNECT folder (or its parent). Ported from reference/import_garmin.py.

Reads:
    DI-Connect-Aggregator/UDSFile_*.json            daily summary: resting heart rate
    DI-Connect-Wellness/*_healthStatusData.json     overnight HRV (with Garmin's baseline band), breathing rate
    DI-Connect-Metrics/MetricsMaxMetData_*.json     VO2max estimates (running only, latest per day)

Writes public.wellness rows where a value is missing. Existing values from intervals.icu always
win; a day that did not exist is created with source='garmin_export'. The export's numbers are
kept under raw->'garmin_export' either way.
"""

from __future__ import annotations

import glob
import json
import os
from datetime import date
from pathlib import Path
from typing import Any
from uuid import UUID

import psycopg

COLUMNS = ["resting_hr", "hrv", "hrv_baseline_low", "hrv_baseline_high", "respiration", "vo2max"]


def find_root(path: str | os.PathLike[str]) -> Path:
    p = Path(path)
    if p.name != "DI_CONNECT" and (p / "DI_CONNECT").is_dir():
        p = p / "DI_CONNECT"
    if not (p / "DI-Connect-Aggregator").is_dir():
        raise SystemExit(f"{p} does not look like a Garmin export's DI_CONNECT folder")
    return p


def _records(root: Path, pattern: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for fp in sorted(glob.glob(str(root / pattern))):
        with open(fp, encoding="utf-8-sig") as f:
            data = json.load(f)
        out.extend(data if isinstance(data, list) else [data])
    return out


def parse_export(root: Path) -> dict[str, dict[str, Any]]:
    """Day -> metrics. Only days with at least one value."""
    days: dict[str, dict[str, Any]] = {}

    def day(d: str) -> dict[str, Any]:
        return days.setdefault(d, {})

    for u in _records(root, "DI-Connect-Aggregator/UDSFile_*.json"):
        if u.get("calendarDate") and u.get("restingHeartRate"):
            day(u["calendarDate"])["resting_hr"] = int(u["restingHeartRate"])

    for h in _records(root, "DI-Connect-Wellness/*_healthStatusData.json"):
        d = h.get("calendarDate")
        if not d:
            continue
        for m in h.get("metrics") or []:
            if m.get("value") is None:
                continue
            if m.get("type") == "HRV":
                rec = day(d)
                rec["hrv"] = float(m["value"])
                # Garmin's personal normal band; placeholders (0/0, -1/1) appear before it has formed
                lo, hi = m.get("baselineLowerLimit") or 0, m.get("baselineUpperLimit") or 0
                if lo > 0 and hi > lo:
                    rec["hrv_baseline_low"] = float(lo)
                    rec["hrv_baseline_high"] = float(hi)
            elif m.get("type") == "RESPIRATION" and m["value"] > 0:
                day(d)["respiration"] = float(m["value"])

    latest: dict[str, dict[str, Any]] = {}
    for m in _records(root, "DI-Connect-Metrics/MetricsMaxMetData_*.json"):
        if m.get("sport") != "RUNNING" or not m.get("vo2MaxValue") or not m.get("calendarDate"):
            continue
        prev = latest.get(m["calendarDate"])
        if prev is None or str(m.get("updateTimestamp", "")) >= str(prev.get("updateTimestamp", "")):
            latest[m["calendarDate"]] = m
    for d, m in latest.items():
        day(d)["vo2max"] = float(m["vo2MaxValue"])

    return {d: v for d, v in sorted(days.items()) if v and _valid_date(d)}


def _valid_date(d: str) -> bool:
    try:
        date.fromisoformat(d[:10])
        return True
    except ValueError:
        return False


UPSERT = f"""
insert into public.wellness (user_id, date, {", ".join(COLUMNS)}, source, raw)
values (%s, %s, {", ".join(["%s"] * len(COLUMNS))}, 'garmin_export', %s::jsonb)
on conflict (user_id, date) do update set
  {", ".join(f"{c} = coalesce(public.wellness.{c}, excluded.{c})" for c in COLUMNS)},
  raw = coalesce(public.wellness.raw, '{{}}'::jsonb) || excluded.raw,
  updated_at = case when {" or ".join(f"(public.wellness.{c} is null and excluded.{c} is not null)" for c in COLUMNS)}
               then now() else public.wellness.updated_at end
"""


def backfill(conn: psycopg.Connection[Any], user_id: UUID, days: dict[str, dict[str, Any]]) -> tuple[int, int]:
    """Upsert the parsed days. Returns (days written, days that were new)."""
    if not days:
        return 0, 0
    before = conn.execute(
        "select count(*) from public.wellness where user_id = %s and date = any(%s::date[])",
        (user_id, [date.fromisoformat(d[:10]) for d in days]),
    ).fetchone()[0]
    with conn.cursor() as cur:
        cur.executemany(
            UPSERT,
            [
                (user_id, date.fromisoformat(d[:10]), *[v.get(c) for c in COLUMNS], json.dumps({"garmin_export": v}))
                for d, v in days.items()
            ],
        )
    return len(days), len(days) - int(before)
