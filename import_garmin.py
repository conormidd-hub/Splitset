#!/usr/bin/env python3
"""Backfill daily wellness history from a Garmin account export into garmin_wellness.csv.

intervals.icu only started receiving resting HR, HRV and VO2max from Garmin in
September 2026. Garmin's own export (Account -> Data Management -> Export Your Data)
holds the full history. Run this once against the unzipped export and commit the CSV;
build.py merges it underneath the live intervals.icu feed, which wins on any day both
have.

    python import_garmin.py "C:/path/to/export/DI_CONNECT"

Reads:
    DI-Connect-Aggregator/UDSFile_*.json                 daily summary: resting HR
    DI-Connect-Wellness/*_healthStatusData.json          overnight HRV (+ Garmin's
                                                         baseline range), breathing rate
    DI-Connect-Metrics/MetricsMaxMetData_*.json          VO2max estimates (running only)
"""

import glob
import json
import os
import sys

import pandas as pd

OUT = "garmin_wellness.csv"


def records(root, pattern):
    out = []
    files = sorted(glob.glob(os.path.join(root, pattern)))
    for fp in files:
        with open(fp, encoding="utf-8-sig") as f:
            data = json.load(f)
        out.extend(data if isinstance(data, list) else [data])
    print(f"  {pattern}: {len(files)} files, {len(out)} records")
    return out


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    root = sys.argv[1]
    if os.path.basename(os.path.normpath(root)) != "DI_CONNECT" and os.path.isdir(os.path.join(root, "DI_CONNECT")):
        root = os.path.join(root, "DI_CONNECT")
    if not os.path.isdir(os.path.join(root, "DI-Connect-Aggregator")):
        raise SystemExit(f"{root} doesn't look like a Garmin export's DI_CONNECT folder.")

    days = {}

    def day(d):
        return days.setdefault(d, {"date": d})

    print("Reading export:")
    for u in records(root, "DI-Connect-Aggregator/UDSFile_*.json"):
        if u.get("calendarDate") and u.get("restingHeartRate"):
            day(u["calendarDate"])["resting_hr"] = u["restingHeartRate"]

    for h in records(root, "DI-Connect-Wellness/*_healthStatusData.json"):
        d = h.get("calendarDate")
        if not d:
            continue
        for m in h.get("metrics") or []:
            if m.get("value") is None:
                continue
            if m.get("type") == "HRV":
                rec = day(d)
                rec["hrv"] = m["value"]
                # Garmin's personal "normal" band. Before it has formed one it writes
                # placeholders (0/0, and once -1/1), so only take a band that's real.
                lo, hi = m.get("baselineLowerLimit") or 0, m.get("baselineUpperLimit") or 0
                if lo > 0 and hi > lo:
                    rec["hrv_base_lo"] = m["baselineLowerLimit"]
                    rec["hrv_base_hi"] = m["baselineUpperLimit"]
            elif m.get("type") == "RESPIRATION" and m["value"] > 0:
                day(d)["respiration"] = m["value"]

    # several VO2max updates can land on one date; keep the last, running only
    # (walking estimates are on a different scale and would add noise)
    latest = {}
    for m in records(root, "DI-Connect-Metrics/MetricsMaxMetData_*.json"):
        if m.get("sport") != "RUNNING" or not m.get("vo2MaxValue") or not m.get("calendarDate"):
            continue
        prev = latest.get(m["calendarDate"])
        if prev is None or str(m.get("updateTimestamp", "")) >= str(prev.get("updateTimestamp", "")):
            latest[m["calendarDate"]] = m
    for d, m in latest.items():
        day(d)["vo2max"] = m["vo2MaxValue"]

    cols = ["date", "resting_hr", "hrv", "hrv_base_lo", "hrv_base_hi", "respiration", "vo2max"]
    df = pd.DataFrame(list(days.values())).reindex(columns=cols).sort_values("date")
    df.to_csv(OUT, index=False)

    print(f"\nWrote {OUT}: {len(df)} days, {df['date'].min()} to {df['date'].max()}")
    for c in cols[1:]:
        s = df[["date", c]].dropna()
        if len(s):
            print(f"  {c:12s} {len(s):4d} days  {s['date'].iloc[0]} -> {s['date'].iloc[-1]}")


if __name__ == "__main__":
    main()
