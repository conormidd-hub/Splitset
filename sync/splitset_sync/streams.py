"""Derived per-activity detail from intervals.icu streams.

Pure functions, ported from reference/sync.py: best rolling efforts, kilometre splits, a thinned
route as a Google encoded polyline with its bounding box, plus a coarse downsample of the
time/distance/heart-rate/altitude/cadence series for charts.

intervals.icu returns streams as a list of {type, data, data2}. A two-valued stream is split across
data/data2: for latlng that is latitude in "data" and longitude in "data2", not [lat, lng] pairs.

The samples object always carries the keys t, d, hr, alt and cad (a missing series is null, never
absent) and, whenever a polyline was built, route_d: the watch distance in metres at each polyline
point, so the app can place per-sample metrics on the map without re-measuring the track.

Cadence unit: some watches report running cadence per leg (~85) and others in full steps per
minute (~170). The choice is made once per activity, so one stream is never half doubled: when
`is_run` and the median of the non-zero cadence samples is below 120 the whole stream is doubled,
matching the activity-level rule in normalise.py. Rides are left as they are.
"""

from __future__ import annotations

from typing import Any

import numpy as np

# Best-effort distances: JSON key -> metres. The keys are the contract with the app and
# reporting views, which look efforts up by these strings.
EFFORT_TARGETS: dict[str, float] = {
    "1000": 1000, "1609": 1609.34, "3000": 3000, "5000": 5000,
    "10000": 10000, "15000": 15000, "21097": 21097.5, "42195": 42195,
}

MIN_SAMPLES = 10          # fewer time points than this and the activity has no usable streams
ROUTE_SPACING_M = 12      # keep a route point roughly every this many metres
ROUTE_MAX_POINTS = 1800
SAMPLES_MAX_POINTS = 2400  # at 10 s that is 6 h 40 min


def encode_polyline(coords: list[tuple[float, float]], precision: int = 5) -> str:
    """Google encoded polyline algorithm."""
    factor = 10 ** precision
    out: list[str] = []
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


def simplify_route_indices(latlng: list[tuple[float, float]], dist: np.ndarray) -> list[int]:
    """Indices of the points to keep when thinning a GPS track.

    Keeps a point roughly every ROUTE_SPACING_M of watch distance plus the last one, then
    index-subsamples when that still exceeds ROUTE_MAX_POINTS. The result is strictly increasing,
    so anything indexed by it (positions, distances) stays in track order.
    """
    keep = [0]
    last_d = dist[0]
    for i in range(1, len(latlng)):
        if dist[i] - last_d >= ROUTE_SPACING_M:
            keep.append(i)
            last_d = dist[i]
    if keep[-1] != len(latlng) - 1:
        keep.append(len(latlng) - 1)
    if len(keep) > ROUTE_MAX_POINTS:
        step = len(keep) / ROUTE_MAX_POINTS
        keep = [keep[int(i * step)] for i in range(ROUTE_MAX_POINTS)] + [keep[-1]]
    return keep


def simplify_route(latlng: list[tuple[float, float]], dist: np.ndarray) -> list[tuple[float, float]]:
    """Thin the GPS track: keep a point roughly every ROUTE_SPACING_M, capped at ROUTE_MAX_POINTS."""
    return [latlng[i] for i in simplify_route_indices(latlng, dist)]


def best_efforts(dist: np.ndarray, tsec: np.ndarray) -> dict[str, float]:
    """Fastest rolling window for each target distance.

    Two-pointer sweep with linear interpolation at the trailing edge so the window is exactly
    the target length rather than the nearest sample boundary.
    """
    out: dict[str, float] = {}
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


def km_splits(dist: np.ndarray, tsec: np.ndarray,
              hr: np.ndarray | None, alt: np.ndarray | None) -> list[dict[str, Any]]:
    """Per whole kilometre: seconds taken, mean heart rate, metres climbed."""
    splits: list[dict[str, Any]] = []
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
        splits.append({"k": k, "t": round(float(t_cross - prev_t), 1), "hr": seg_hr, "el": seg_el})
        prev_t = t_cross
        prev_i = j
    return splits


def downsample(tsec: np.ndarray, dist: np.ndarray, hr: np.ndarray | None, alt: np.ndarray | None,
               every_s: int, cad: np.ndarray | None = None) -> dict[str, list[Any]] | None:
    """One sample every `every_s` seconds: t (s), d (m), hr (bpm or null), alt (m or null),
    cad (steps or rpm, null when absent or zero). Every key is present even when its series is null.
    """
    if every_s <= 0 or len(tsec) < 2:
        return None
    marks = np.arange(0, float(tsec[-1]) + every_s, every_s)
    idx = np.unique(np.minimum(np.searchsorted(tsec, marks, side="left"), len(tsec) - 1))
    if len(idx) > SAMPLES_MAX_POINTS:
        idx = idx[np.linspace(0, len(idx) - 1, SAMPLES_MAX_POINTS).astype(int)]

    def series(a: np.ndarray | None, nd: int) -> list[Any] | None:
        if a is None:
            return None
        vals = a[idx]
        return [None if np.isnan(v) else round(float(v), nd) for v in vals]

    def ints(a: np.ndarray | None, zero_is_null: bool) -> list[Any] | None:
        if a is None:
            return None
        out: list[Any] = []
        for v in a[idx]:
            if np.isnan(v):
                out.append(None)
                continue
            iv = int(round(float(v)))
            out.append(None if zero_is_null and iv <= 0 else iv)
        return out

    return {
        "t": [int(round(float(v))) for v in tsec[idx]],
        "d": [int(round(float(v))) for v in dist[idx]],
        "hr": ints(hr, zero_is_null=False),
        "alt": series(alt, 1),
        "cad": ints(cad, zero_is_null=True),
    }


def _aligned(values: Any, n: int) -> np.ndarray | None:
    """Numeric array of length n, or None when the stream is missing or misaligned."""
    if not values or len(values) != n:
        return None
    return np.asarray([np.nan if v is None else v for v in values], dtype=float)


CADENCE_PER_LEG_MAX = 120   # a running cadence stream whose non-zero median is below this is per leg


def normalise_run_cadence(cad: np.ndarray | None, is_run: bool) -> np.ndarray | None:
    """Full steps per minute for runs: double a per-leg stream (median of non-zero samples < 120).

    Decided once for the whole stream so a run is never half doubled. Rides come back untouched.
    """
    if cad is None or not is_run:
        return cad
    nz = cad[~np.isnan(cad) & (cad > 0)]
    if len(nz) and float(np.median(nz)) < CADENCE_PER_LEG_MAX:
        return cad * 2
    return cad


def derive_details(streams: list[dict[str, Any]] | None, activity_id: str,
                   sample_every_s: int = 10, is_run: bool = False) -> dict[str, Any]:
    """Everything activity_details stores for one activity.

    `is_run` only affects the cadence unit (see normalise_run_cadence).
    """
    empty = {"activity_id": activity_id, "has_streams": False, "splits": None,
             "best_efforts": None, "polyline": None, "bbox": None, "samples": None}
    if not streams:
        return empty
    by_type = {s.get("type"): s.get("data") for s in streams if isinstance(s, dict)}
    by_type2 = {s.get("type"): s.get("data2") for s in streams if isinstance(s, dict)}
    tsec_raw = by_type.get("time")
    dist_raw = by_type.get("distance")
    if not tsec_raw or not dist_raw or len(tsec_raw) < MIN_SAMPLES or len(dist_raw) != len(tsec_raw):
        return empty

    tsec = np.asarray([0.0 if v is None else v for v in tsec_raw], dtype=float)
    dist = np.asarray([np.nan if v is None else v for v in dist_raw], dtype=float)
    # force monotonic distance: GPS jitter can step backwards
    dist = np.maximum.accumulate(np.nan_to_num(dist, nan=0.0))
    n = len(tsec)
    hr = _aligned(by_type.get("heartrate"), n)
    alt = _aligned(by_type.get("altitude"), n)
    cad = normalise_run_cadence(_aligned(by_type.get("cadence"), n), is_run)

    out: dict[str, Any] = {
        "activity_id": activity_id,
        "has_streams": True,
        "best_efforts": best_efforts(dist, tsec) or None,
        "splits": km_splits(dist, tsec, hr, alt) or None,
        "polyline": None,
        "bbox": None,
        "samples": downsample(tsec, dist, hr, alt, sample_every_s, cad=cad),
    }

    lats, lngs = by_type.get("latlng"), by_type2.get("latlng")
    if lats and lngs and len(lats) == n and len(lngs) == n:
        valid_idx = [i for i in range(n) if lats[i] is not None and lngs[i] is not None]
        if len(valid_idx) > MIN_SAMPLES:
            pts = [(float(lats[i]), float(lngs[i])) for i in valid_idx]
            valid_dist = dist[valid_idx]
            keep = simplify_route_indices(pts, valid_dist)
            route = [pts[i] for i in keep]
            rlat = [p[0] for p in route]
            rlng = [p[1] for p in route]
            out["polyline"] = encode_polyline(route)
            out["bbox"] = [round(min(rlat), 5), round(min(rlng), 5),
                           round(max(rlat), 5), round(max(rlng), 5)]
            # watch distance at each polyline point, one entry per decoded point. Only when samples
            # exist (sample_every_s <= 0 disables them, and route_d has nowhere else to live).
            if out["samples"] is not None:
                out["samples"]["route_d"] = [int(valid_dist[i]) for i in keep]
    return out
