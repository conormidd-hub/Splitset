#!/usr/bin/env python3
"""Pull running data from intervals.icu: activities, wellness, and per-run streams.

Setup (once):
    pip install requests pandas numpy
    export INTERVALS_ATHLETE_ID=i123456      # from your intervals.icu /settings page
    export INTERVALS_API_KEY=your_key_here   # same page, near the bottom

Then:
    python3 sync.py                  # everything since 2024-01-01
    python3 sync.py 2025-01-01       # or from a given date
    python3 sync.py --no-streams     # skip the per-run GPS/HR download

Outputs:
    activities.csv    one row per run (merged with existing history, never clobbered)
    wellness.csv      one row per day: resting HR, HRV, weight, sleep, CTL/ATL, VO2max
    data/runs/*.json  per-run detail: encoded route, km splits, HR zones, best efforts

The per-run files are cached: an activity is only downloaded once, so the first sync
does the big backfill and every later sync only touches new runs.
"""

import argparse
import json
import os
import sys
import time as _time

import numpy as np
import pandas as pd
import requests

API_ROOT = "https://intervals.icu/api/v1"
RUNS_DIR = os.path.join("data", "runs")

# Best-effort distances computed from streams: JSON key -> metres.
# The keys are load-bearing - template.html looks efforts up by these strings.
EFFORT_TARGETS = {
    "1000": 1000, "1609": 1609.34, "3000": 3000, "5000": 5000,
    "10000": 10000, "15000": 15000, "21097": 21097.5, "42195": 42195,
}

# Time-in-zone comes straight from intervals.icu (icu_hr_zone_times / icu_hr_zones),
# so it covers every run rather than only the ones with a cached stream, and it uses
# the athlete's own zone bounds rather than a guess.

# our column -> possible names in the intervals.icu payload, best first.
# The names matter: intervals.icu calls ground contact "average_stance_time", not
# any of the "ground_time" spellings, and vertical oscillation arrives in mm.
CANDIDATES = {
    "id":            ["id"],
    "date":          ["start_date_local", "start_date", "startDateLocal"],
    # kept separately from the date: the debrief needs the hour to look up what the
    # weather was actually doing while he was out in it
    "start_local":   ["start_date_local", "startDateLocal", "start_date"],
    "name":          ["name"],
    "type":          ["type"],
    "distance_m":    ["distance", "icu_distance"],
    "moving_time_s": ["moving_time", "icu_moving_time", "elapsed_time"],
    "elapsed_time_s": ["elapsed_time", "icu_elapsed_time"],
    "avg_hr":        ["average_heartrate", "icu_average_heartrate", "avg_hr"],
    "max_hr":        ["max_heartrate", "icu_max_heartrate", "max_hr"],
    "cadence_spm":   ["average_cadence", "icu_average_cadence"],
    "stride_m":      ["average_stride", "icu_average_stride"],
    "gct_ms":        ["average_stance_time", "ground_time", "icu_ground_time"],
    "gct_pct":       ["average_stance_time_percent"],
    "vert_osc_mm":   ["average_vertical_oscillation", "vertical_oscillation"],
    "vert_ratio":    ["average_vertical_ratio"],
    "avg_power_w":   ["icu_average_watts", "average_watts"],
    "vo2max":        ["icu_vo2max", "vo2max"],
    "elev_gain_m":   ["total_elevation_gain", "icu_elevation_gain"],
    "elev_loss_m":   ["total_elevation_loss"],
    "load":          ["icu_training_load", "training_load"],
    "intensity":     ["icu_intensity", "intensity"],
    "trimp":         ["trimp"],
    "gap_ms":        ["gap"],
    "avg_temp_c":    ["average_temp", "avg_temp"],
    "calories":      ["calories", "icu_calories"],
    # per-activity readings that are far denser than the wellness feed
    "resting_hr":    ["icu_resting_hr"],
    "weight_kg":     ["icu_weight"],
    "lthr":          ["lthr"],
    "max_hr_zone":   ["athlete_max_hr"],
    "device":        ["device_name"],
    # already-computed time-in-zone, so every run has zones without a stream fetch
    "hr_zone_times": ["icu_hr_zone_times"],
    "hr_zones":      ["icu_hr_zones"],
    "pace_zone_times": ["pace_zone_times"],
}

# Columns holding a list, stored pipe-joined so the CSV stays one flat table.
LIST_COLS = ["hr_zone_times", "hr_zones", "pace_zone_times"]

OUT_COLS = [
    "date", "start_local", "id", "name", "type", "distance_km", "moving_time_s", "elapsed_time_s",
    "avg_hr", "max_hr", "cadence_spm", "stride_m", "gct_ms", "gct_pct", "vert_osc_cm",
    "vert_ratio", "avg_power_w", "vo2max", "elev_gain_m", "elev_loss_m", "load",
    "intensity", "trimp", "gap_ms", "avg_temp_c", "calories", "resting_hr", "weight_kg",
    "lthr", "max_hr_zone", "device", "hr_zone_times", "hr_zones", "pace_zone_times",
]

WELLNESS_FIELDS = {
    "resting_hr": ["restingHR", "resting_hr"],
    "hrv":        ["hrv"],
    "weight_kg":  ["weight"],
    "sleep_s":    ["sleepSecs", "sleep_secs"],
    "sleep_score": ["sleepScore", "sleep_score"],
    "vo2max":     ["vo2max"],
    "ctl":        ["ctl"],
    "atl":        ["atl"],
    "steps":      ["steps"],
}


def session(api_key):
    s = requests.Session()
    s.auth = ("API_KEY", api_key)
    s.headers["Accept"] = "application/json"
    return s


def check_auth(resp):
    if resp.status_code in (401, 403):
        raise SystemExit(
            f"{resp.status_code} from intervals.icu. Two usual causes:\n"
            "  - athlete id needs a leading 'i' (i123456, not 123456)\n"
            "  - the API key has been regenerated on the settings page"
        )


# ---------------------------------------------------------------- activities

def fetch_activities(sess, athlete_id, oldest, newest):
    resp = sess.get(
        f"{API_ROOT}/athlete/{athlete_id}/activities",
        params={"oldest": oldest, "newest": newest},
        timeout=90,
    )
    check_auth(resp)
    resp.raise_for_status()
    return pd.DataFrame(resp.json())


def tidy(raw):
    print(f"intervals.icu returned {len(raw)} activities")
    if raw.empty:
        return pd.DataFrame(columns=OUT_COLS)

    df = pd.DataFrame(index=raw.index)
    for out_name, options in CANDIDATES.items():
        for opt in options:
            if opt in raw.columns:
                df[out_name] = raw[opt]
                break
        else:
            df[out_name] = pd.NA
            print(f"  note: no source column found for {out_name}")

    # runs only
    if "type" in raw.columns:
        df = df[raw["type"].astype(str).str.contains("Run", case=False, na=False)]
        print(f"{len(df)} of those are runs")

    df["id"] = df["id"].astype(str).replace({"<NA>": "", "nan": "", "None": ""})
    df["start_local"] = pd.to_datetime(df.get("start_local"), errors="coerce", format="mixed").dt.strftime("%H:%M")
    df["date"] = pd.to_datetime(df["date"], errors="coerce", format="mixed").dt.strftime("%Y-%m-%d")
    df["distance_km"] = (pd.to_numeric(df.pop("distance_m"), errors="coerce") / 1000).round(3)
    for c in ("moving_time_s", "elapsed_time_s"):
        df[c] = pd.to_numeric(df[c], errors="coerce")

    # some devices report cadence per leg; normalise to full steps per minute
    cad = pd.to_numeric(df["cadence_spm"], errors="coerce")
    if cad.notna().any() and cad.median() < 120:
        print("  cadence looks per-leg, doubling it")
        cad = cad * 2
    df["cadence_spm"] = cad.round(1)

    # intervals.icu reports vertical oscillation in mm; the Garmin history in the
    # CSV is cm, so normalise to cm rather than mixing units in one column
    df["vert_osc_cm"] = (pd.to_numeric(df.pop("vert_osc_mm"), errors="coerce") / 10).round(2)

    # flatten list-valued columns to "a|b|c"
    for c in LIST_COLS:
        df[c] = df[c].apply(
            lambda v: "|".join(str(x) for x in v) if isinstance(v, (list, tuple)) else pd.NA
        )

    df = df[OUT_COLS]
    df = df[df["distance_km"].notna() & (df["distance_km"] >= 0.5) & df["date"].notna()]
    return df.sort_values("date")


def merge_activities(fresh, path="activities.csv"):
    """Merge with anything already on disk so the old Garmin history survives.

    Match on date + rounded distance (+ an occurrence counter so two identical
    runs in one day don't collide). Fill blanks in the fetched rows from the
    existing ones rather than replacing wholesale: intervals.icu does not pass
    through Garmin's running dynamics (ground contact, stride, oscillation),
    so a straight overwrite would erase them from the whole history.
    """
    if not os.path.exists(path):
        return fresh

    # utf-8-sig, not utf-8: PowerShell 5.1's Export-Csv -Encoding UTF8 writes a BOM,
    # and sync.ps1 may have produced this file. It reads BOM-less UTF-8 fine too.
    existing = pd.read_csv(path, dtype={"id": str}, encoding="utf-8-sig")
    before = len(existing)
    for col in OUT_COLS:
        if col not in existing.columns:
            existing[col] = pd.NA

    key = ["date", "km_key", "occ"]
    for frame in (existing, fresh):
        frame["km_key"] = pd.to_numeric(frame["distance_km"], errors="coerce").round(2)
        frame["occ"] = frame.groupby(["date", "km_key"]).cumcount()

    merged = (
        fresh.set_index(key)
             .combine_first(existing.set_index(key))
             .reset_index()
    )
    merged = merged[OUT_COLS]
    print(f"{before} existing + {len(fresh)} fetched -> {len(merged)} after merge")
    return merged.sort_values("date")


# ---------------------------------------------------------------- wellness

def sync_wellness(sess, athlete_id, oldest, newest, path="wellness.csv"):
    resp = sess.get(
        f"{API_ROOT}/athlete/{athlete_id}/wellness",
        params={"oldest": oldest, "newest": newest},
        timeout=90,
    )
    check_auth(resp)
    if resp.status_code != 200:
        print(f"wellness fetch failed ({resp.status_code}) - skipping")
        return
    raw = resp.json()
    if not raw:
        print("no wellness data returned")
        return

    rows = []
    for rec in raw:
        row = {"date": rec.get("id")}
        for out, options in WELLNESS_FIELDS.items():
            for opt in options:
                if rec.get(opt) is not None:
                    row[out] = rec[opt]
                    break
        rows.append(row)
    df = pd.DataFrame(rows)
    df = df[df["date"].notna()].sort_values("date")
    # keep only days that actually have something on them
    value_cols = [c for c in df.columns if c != "date"]
    df = df.dropna(subset=value_cols, how="all")
    df.to_csv(path, index=False)
    print(f"wellness: saved {len(df)} days -> {path}")


# ---------------------------------------------------------------- streams

def encode_polyline(coords, precision=5):
    """Google encoded polyline algorithm."""
    factor = 10 ** precision
    out = []
    prev_lat = prev_lng = 0
    for lat, lng in coords:
        ilat, ilng = round(lat * factor), round(lng * factor)
        for v in (ilat - prev_lat, ilng - prev_lng):
            v = ~(v << 1) if v < 0 else (v << 1)
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        prev_lat, prev_lng = ilat, ilng
    return "".join(out)


def simplify_route(latlng, dist):
    """Thin the GPS track: keep a point roughly every 12 m, capped at ~1800 points."""
    keep = [0]
    last_d = dist[0]
    for i in range(1, len(latlng)):
        if dist[i] - last_d >= 12:
            keep.append(i)
            last_d = dist[i]
    if keep[-1] != len(latlng) - 1:
        keep.append(len(latlng) - 1)
    if len(keep) > 1800:
        step = len(keep) / 1800
        keep = [keep[int(i * step)] for i in range(1800)] + [keep[-1]]
    return [latlng[i] for i in keep]


def best_efforts(dist, tsec):
    """Fastest rolling window for each target distance. Two-pointer with
    linear interpolation at the trailing edge."""
    out = {}
    n = len(dist)
    for key, target in EFFORT_TARGETS.items():
        if dist[-1] < target:
            continue
        best = None
        i = 0
        for j in range(n):
            while i + 1 < j and dist[j] - dist[i + 1] >= target:
                i += 1
            span = dist[j] - dist[i]
            if span >= target:
                seg = dist[i + 1] - dist[i] if i + 1 < n else 0
                overshoot = span - target
                if seg > 0:
                    t_start = tsec[i] + (tsec[i + 1] - tsec[i]) * (overshoot / seg)
                else:
                    t_start = tsec[i]
                dur = tsec[j] - t_start
                if dur > 0 and (best is None or dur < best):
                    best = dur
        if best:
            out[key] = round(float(best), 1)
    return out


def km_splits(dist, tsec, hr, alt):
    """Per-km: seconds, avg HR, elevation delta."""
    splits = []
    total_km = int(dist[-1] // 1000)
    j = 0
    prev_t = tsec[0]
    prev_i = 0
    for k in range(1, total_km + 1):
        target = k * 1000
        while j < len(dist) and dist[j] < target:
            j += 1
        if j >= len(dist):
            break
        # interpolate the crossing time
        if j > 0 and dist[j] != dist[j - 1]:
            frac = (target - dist[j - 1]) / (dist[j] - dist[j - 1])
            t_cross = tsec[j - 1] + (tsec[j] - tsec[j - 1]) * frac
        else:
            t_cross = tsec[j]
        seg_hr = None
        if hr is not None:
            window = hr[prev_i:j + 1]
            window = window[~np.isnan(window)]
            if len(window):
                seg_hr = int(round(float(window.mean())))
        seg_el = None
        if alt is not None and j > prev_i:
            d = np.diff(alt[prev_i:j + 1])
            d = d[~np.isnan(d)]
            if len(d):
                seg_el = int(round(float(d[d > 0].sum())))
        splits.append({
            "k": k,
            "t": round(float(t_cross - prev_t), 1),
            "hr": seg_hr,
            "el": seg_el,
        })
        prev_t = t_cross
        prev_i = j
    return splits


def derive_run(streams, act_id):
    # intervals.icu splits a two-valued stream across data/data2 - for latlng that
    # is latitude in "data" and longitude in "data2", NOT a list of [lat,lng] pairs.
    by_type = {s.get("type"): s.get("data") for s in streams if isinstance(s, dict)}
    by_type2 = {s.get("type"): s.get("data2") for s in streams if isinstance(s, dict)}
    tsec = by_type.get("time")
    dist = by_type.get("distance")
    if not tsec or not dist or len(tsec) < 10:
        return {"id": act_id, "no_streams": True}

    tsec = np.asarray(tsec, dtype=float)
    dist = np.asarray(dist, dtype=float)
    # force monotonic distance (GPS jitter can step backwards)
    dist = np.maximum.accumulate(np.nan_to_num(dist, nan=0.0))

    hr = by_type.get("heartrate")
    hr = np.asarray(hr, dtype=float) if hr else None
    if hr is not None and len(hr) != len(tsec):
        hr = None
    alt = by_type.get("altitude")
    alt = np.asarray(alt, dtype=float) if alt else None
    if alt is not None and len(alt) != len(tsec):
        alt = None

    out = {
        "id": act_id,
        "efforts": best_efforts(dist, tsec),
        "splits": km_splits(dist, tsec, hr, alt),
    }

    lats, lngs = by_type.get("latlng"), by_type2.get("latlng")
    if lats and lngs and len(lats) == len(tsec) and len(lngs) == len(lats):
        valid_idx = [i for i in range(len(lats))
                     if lats[i] is not None and lngs[i] is not None]
        if len(valid_idx) > 10:
            pts = [(lats[i], lngs[i]) for i in valid_idx]
            vdist = dist[valid_idx]          # distances aligned with the kept points
            route = simplify_route(pts, vdist)
            rlat = [p[0] for p in route]
            rlng = [p[1] for p in route]
            out["poly"] = encode_polyline(route)
            out["bbox"] = [round(min(rlat), 5), round(min(rlng), 5),
                           round(max(rlat), 5), round(max(rlng), 5)]
    return out


def sync_streams(sess, ids, max_fetch):
    os.makedirs(RUNS_DIR, exist_ok=True)
    todo = [i for i in ids if i and not os.path.exists(os.path.join(RUNS_DIR, f"{i}.json"))]
    if not todo:
        print("streams: cache is up to date")
        return
    todo = todo[:max_fetch]
    print(f"streams: fetching {len(todo)} activities "
          f"({len(ids) - len(todo)} already cached or deferred)")

    for n, act_id in enumerate(todo, 1):
        try:
            resp = sess.get(
                f"{API_ROOT}/activity/{act_id}/streams",
                params={"types": "time,distance,latlng,heartrate,altitude"},
                timeout=90,
            )
            check_auth(resp)
            if resp.status_code == 404:
                rec = {"id": act_id, "no_streams": True}
            else:
                resp.raise_for_status()
                rec = derive_run(resp.json(), act_id)
        except requests.RequestException as e:
            print(f"  [{n}/{len(todo)}] {act_id}: {e} - will retry next sync")
            continue
        with open(os.path.join(RUNS_DIR, f"{act_id}.json"), "w") as f:
            json.dump(rec, f, separators=(",", ":"))
        tag = "no streams" if rec.get("no_streams") else \
            (f"{len(rec.get('splits', []))} km"
             + (", route" if "poly" in rec else ", NO ROUTE")
             + (f", {len(rec.get('efforts', {}))} efforts" if rec.get("efforts") else ""))
        print(f"  [{n}/{len(todo)}] {act_id}: {tag}")
        _time.sleep(0.25)


# ---------------------------------------------------------------- main

def read_dotenv(path=".env"):
    """Credentials from a local .env file, for running outside the GitHub Action."""
    out = {}
    if not os.path.exists(path):
        return out
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip("\"'")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("oldest", nargs="?", default="2024-01-01")
    ap.add_argument("--no-streams", action="store_true", help="skip per-run stream download")
    ap.add_argument("--max-streams", type=int, default=500,
                    help="cap per-run downloads in one sync (default 500)")
    args = ap.parse_args()

    dotenv = read_dotenv()
    athlete_id = os.environ.get("INTERVALS_ATHLETE_ID") or dotenv.get("INTERVALS_ATHLETE_ID")
    api_key = os.environ.get("INTERVALS_API_KEY") or dotenv.get("INTERVALS_API_KEY")
    if not athlete_id or not api_key:
        raise SystemExit(
            "No intervals.icu credentials found.\n"
            "Set INTERVALS_ATHLETE_ID and INTERVALS_API_KEY, or put them in a .env file:\n"
            "    INTERVALS_ATHLETE_ID=i123456\n"
            "    INTERVALS_API_KEY=your_key_here"
        )
    if not str(athlete_id).startswith("i"):
        athlete_id = f"i{athlete_id}"

    newest = pd.Timestamp.today().strftime("%Y-%m-%d")
    sess = session(api_key)

    fresh = tidy(fetch_activities(sess, athlete_id, args.oldest, newest))
    merged = merge_activities(fresh)
    if merged.empty:
        raise SystemExit("Nothing to write - stopping rather than overwriting good data.")
    merged.to_csv("activities.csv", index=False)
    print(f"Saved {len(merged)} runs ({merged['date'].min()} to {merged['date'].max()})")

    sync_wellness(sess, athlete_id, args.oldest, newest)

    if not args.no_streams:
        ids = [i for i in merged["id"].fillna("").astype(str) if i]
        sync_streams(sess, ids, args.max_streams)


if __name__ == "__main__":
    main()
