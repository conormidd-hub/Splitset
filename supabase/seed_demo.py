#!/usr/bin/env python3
"""Create the demo athlete and fill it with a year of sample data.

    cd sync && uv run python ../supabase/seed_demo.py

Reads SUPABASE_DB_URL, EXPO_PUBLIC_DEMO_EMAIL and EXPO_PUBLIC_DEMO_PASSWORD from the
environment or the root .env (see .env.example). Point SUPABASE_DB_URL at splitset-dev:
preview builds use that project, and the demo account only exists where this has run.

Re-running rebuilds the account from scratch: the demo user is deleted (every row cascades
with it) and recreated with the same id, so a preview that has been played with can be
reset in one command. The script refuses to touch any account that is not the demo one.

The data is deterministic (fixed random seed) and relative to today: a year of running and
lifting for a Melbourne-based athlete who runs four times a week, lifts twice, raced a half
marathon six weeks ago, had a week off and a few days ill. Activities, stream detail and
wellness go in through the sync job's own writers, so their shape is exactly what a real
intervals.icu sync produces.

Runs are simulated at 1 Hz on four fixed routes whose drawn length equals the watch distance
(the shapes are reparametrised by arc length), with a per-run start offset, smoothed GPS noise
and a cadence stream, so the map features (segments, heat map, frequent routes, per-point
metrics) see data that behaves like real recordings.
"""

from __future__ import annotations

import bisect
import json
import math
import random
import sys
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from functools import cached_property
from pathlib import Path
from typing import Any
from uuid import UUID, uuid5
from zoneinfo import ZoneInfo

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sync"))
from splitset_sync import db  # noqa: E402
from splitset_sync.config import env  # noqa: E402
from splitset_sync.normalise import ACTIVITY_COLUMNS  # noqa: E402
from splitset_sync.streams import derive_details  # noqa: E402
from splitset_sync.wellness import WELLNESS_COLUMNS  # noqa: E402
from seed_library import LEGACY_NAMES  # noqa: E402  (this folder is on sys.path)
from backfill_e1rm import backfill  # noqa: E402

# ---------------------------------------------------------------- the athlete

DEMO_ID = UUID("00000000-0000-4000-a000-00000000d3a0")
DEMO_NS = UUID("00000000-0000-4000-a000-00000000d3a1")   # namespace for stable child ids
TZ = ZoneInfo("Australia/Melbourne")
SEED = 20260922
DISPLAY_NAME = "Demo Athlete"
ATHLETE_ID = "i1234567"
DEVICE = "Garmin Forerunner 265"
HR_MAX, LTHR, HR_REST = 192, 172, 50
HR_ZONES = [137, 150, 160, 168, 176, 184, 192]   # zone upper bounds, intervals.icu style
UTC = timezone.utc


def sid(*parts: Any) -> UUID:
    """A stable uuid for a child row, so re-seeding produces the same ids."""
    return uuid5(DEMO_NS, ":".join(str(p) for p in parts))


# ---------------------------------------------------------------- routes

ARC_STEPS = 2048     # parameter steps in each route's arc-length table: 2-3 m apart on these routes


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lng2 - lng1) / 2) ** 2
    return 2 * 6_371_000 * math.asin(math.sqrt(a))


@dataclass(frozen=True)
class Route:
    """A closed course: a loop, or a trail run out and back along the same path.

    The shape is a curve in a parameter p in [0, 1). Arc length is far from linear in p (a
    sine-perturbed ellipse covers ground fastest through its flat sides, and the raw shape is not
    length_m long to begin with), so the shape is scaled once so that a lap measures exactly
    length_m by haversine, and point(d) inverts a table of cumulative distance over ARC_STEPS
    parameter steps. The drawn path then agrees with the watch distance everywhere along it.
    """

    name: str
    lat: float
    lng: float
    length_m: float     # one lap, or out-and-back total
    rx: float           # east-west half-extent of the unscaled shape, metres
    ry: float           # north-south half-extent of the unscaled shape, metres
    alt_base: float
    alt_amp: float
    alt_phase: float
    loop: bool

    def _fold(self, p: float) -> float:
        """Position along the path in [0, 1]: p itself on a loop, out-and-back folded on a trail."""
        return p if self.loop else (2 * p if p < 0.5 else 2 * (1 - p))

    def _xy(self, p: float) -> tuple[float, float]:
        """Unscaled east and north offsets in metres at parameter p."""
        if self.loop:
            th = 2 * math.pi * p
            return (self.rx * (math.cos(th) + 0.12 * math.cos(2 * th)),
                    self.ry * (math.sin(th) + 0.10 * math.sin(3 * th)))
        s = self._fold(p)
        return (self.rx * (2 * s - 1),
                self.ry * (0.5 * math.sin(2 * math.pi * s) + 0.3 * math.sin(4 * math.pi * s + 1.0)))

    def _latlng(self, p: float, scale: float) -> tuple[float, float]:
        x, y = self._xy(p)
        return (self.lat + scale * y / 111_320,
                self.lng + scale * x / (111_320 * math.cos(math.radians(self.lat))))

    @cached_property
    def _table(self) -> tuple[list[float], float]:
        """(cumulative metres at parameter i / ARC_STEPS, the shape scale that makes a lap length_m)."""
        def cumulative(scale: float) -> list[float]:
            cum = [0.0]
            prev = self._latlng(0.0, scale)
            for i in range(1, ARC_STEPS + 1):
                cur = self._latlng(i / ARC_STEPS, scale)
                cum.append(cum[-1] + haversine_m(*prev, *cur))
                prev = cur
            return cum
        scale = self.length_m / cumulative(1.0)[-1]
        return cumulative(scale), scale          # second pass so the table describes the scaled shape

    @property
    def scale(self) -> float:
        """How much the raw shape was stretched (or shrunk) to measure length_m."""
        return self._table[1]

    def point(self, d: float) -> tuple[float, float, float]:
        """(lat, lng, altitude) at `d` metres along the route; d wraps every length_m."""
        cum, scale = self._table
        target = (d % self.length_m) * (cum[-1] / self.length_m)   # into table units (differ by rounding only)
        i = min(max(bisect.bisect_left(cum, target), 1), ARC_STEPS)
        seg = cum[i] - cum[i - 1]
        frac = (target - cum[i - 1]) / seg if seg > 0 else 0.0
        p = (i - 1 + frac) / ARC_STEPS
        lat, lng = self._latlng(p, scale)
        s = self._fold(p)
        alt = (self.alt_base + self.alt_amp * math.sin(2 * math.pi * s + self.alt_phase)
               + 0.35 * self.alt_amp * math.sin(4 * math.pi * s + 2 * self.alt_phase))
        return lat, lng, alt


ROUTES = {
    "tan":     Route("The Tan",          -37.8316, 144.9796, 3827, 560,  330, 18, 14, 0.9, True),
    "albert":  Route("Albert Park Lake", -37.8440, 144.9690, 4800, 900,  480,  6,  2, 0.0, True),
    "princes": Route("Princes Park",     -37.7840, 144.9600, 3200, 420,  300, 40,  3, 0.4, True),
    "yarra":   Route("Yarra Trail",      -37.8200, 145.0100, 6000, 2400, 500, 12, 10, 0.3, False),
}

# ---------------------------------------------------------------- the training year

@dataclass
class Event:
    day: date
    at: time
    kind: str                 # easy recovery long tempo intervals parkrun race walk ride gym rest
    km: float | None = None
    routine: str | None = None
    happened: bool = True     # False: planned but never done (shows as "missed")
    skipped: bool = False     # a plan row marked skipped, no activity


GYM = {  # routine name -> exercises: name, prescribed sets, start kg, end kg, rounding, warm-ups, rest s
    "Lower A": [
        ("Back squat",            [5, 5, 5],     80.0, 110.0, 2.5, True,  180),
        ("Romanian deadlift",     [8, 8, 8],     60.0,  85.0, 2.5, False, 150),
        ("Bulgarian split squat", [10, 10, 10],  16.0,  24.0, 2.0, False, 90),
        ("Standing calf raise",   [12, 12, 12],  60.0,  90.0, 5.0, False, 60),
        ("Plank",                 [60, 60, 60],  None,  None, 0,   False, 60),
    ],
    "Lower B": [
        ("Deadlift",              [5, 5, 5],    100.0, 140.0, 2.5, True,  210),
        ("Front squat",           [6, 6, 6],     55.0,  75.0, 2.5, False, 150),
        ("Hip thrust",            [10, 10, 10],  80.0, 120.0, 5.0, False, 120),
        ("Leg curl",              [12, 12, 12],  35.0,  50.0, 2.5, False, 60),
        ("Copenhagen plank",      [30, 30, 30],  None,  None, 0,   False, 45),
    ],
    "Upper A": [
        ("Bench press",           [5, 5, 5],     60.0,  82.5, 2.5, True,  180),
        ("Barbell row",           [8, 8, 8],     55.0,  75.0, 2.5, False, 120),
        ("Overhead press",        [8, 8, 8],     37.5,  50.0, 2.5, False, 120),
        ("Pull-up",               [6, 6, 6],      0.0,   5.0, 2.5, False, 120),
        ("Face pull",             [15, 15, 15],  15.0,  22.5, 2.5, False, 60),
    ],
    "Upper B": [
        ("Incline dumbbell press", [10, 10, 10], 22.0,  30.0, 2.0, False, 120),
        ("Lat pulldown",          [10, 10, 10],  55.0,  70.0, 2.5, False, 90),
        ("Dumbbell shoulder press", [10, 10, 10], 16.0, 22.0, 2.0, False, 90),
        ("Seated cable row",      [12, 12, 12],  50.0,  65.0, 2.5, False, 90),
        ("Dumbbell curl",         [12, 12, 12],  12.0,  16.0, 2.0, False, 60),
        ("Tricep pushdown",       [12, 12, 12],  25.0,  35.0, 2.5, False, 60),
    ],
}
DURATION_EXERCISES = {"Plank", "Copenhagen plank"}


def build_year(today: date) -> tuple[list[Event], int]:
    """Every session from 52 weeks ago to two weeks ahead. Returns events and the week count."""
    monday = today - timedelta(days=today.weekday())
    first = monday - timedelta(weeks=52)
    n = 53                               # weeks 0..52, week 52 is the current one
    events: list[Event] = []
    for w in range(n + 2):               # two planned weeks beyond today
        f = min(w, n - 1) / (n - 1)
        deload = w % 4 == 3
        race_week, taper = w == n - 7, w == n - 8
        holiday, sick = w == n - 21, w == n - 10
        k = 0.7 if (deload or taper) else 1.0
        long_km = round((12 + 10 * f) * k, 1)
        easy_km = round((6 + 3 * f) * k, 1)
        d = first + timedelta(weeks=w)
        day = lambda i: d + timedelta(days=i)  # noqa: E731
        lower = "Lower A" if w % 2 == 0 else "Lower B"
        upper = "Upper A" if w % 2 == 0 else "Upper B"

        if holiday:
            events += [Event(day(1), time(17, 30), "walk", 4.2), Event(day(4), time(17, 30), "walk", 5.1),
                       Event(day(6), time(8, 0), "easy", 6.0)]
            continue
        if sick:
            events += [Event(day(0), time(18, 0), "walk", 3.5), Event(day(5), time(8, 0), "recovery", 4.0),
                       Event(day(6), time(7, 30), "easy", 7.0)]
            continue

        if w % 4 == 1:
            events.append(Event(day(0), time(18, 0), "ride", 22.0))
        elif w % 2 == 0:
            events.append(Event(day(0), time(18, 0), "walk", 4.0))
        else:
            events.append(Event(day(0), time(7, 0), "rest"))
        events.append(Event(day(1), time(6, 15), "intervals" if w % 2 == 0 else "tempo", 10.0 if w % 2 == 0 else 9.5))
        events.append(Event(day(2), time(6, 30), "gym", routine=lower))
        events.append(Event(day(3), time(6, 15), "easy", easy_km))
        events.append(Event(day(4), time(6, 30), "gym", routine=upper))
        if race_week:
            events.append(Event(day(5), time(7, 30), "recovery", 3.0))
            events.append(Event(day(6), time(7, 0), "race", 21.15))
        else:
            events.append(Event(day(5), time(8, 0), "parkrun", 5.02) if w % 2 == 1
                          else Event(day(5), time(7, 30), "recovery", 5.0))
            events.append(Event(day(6), time(7, 0), "long", long_km))

    # two blemishes inside the plan window: a missed recovery jog and a skipped Monday
    for e in events:
        if e.day == first + timedelta(weeks=n - 3, days=5):
            e.happened = False
        if e.day == first + timedelta(weeks=n - 2) and e.kind in ("rest", "walk", "ride"):
            e.kind, e.km, e.skipped, e.happened, e.at = "easy", 5.0, True, False, time(6, 15)
    return events, n


# ---------------------------------------------------------------- running

def run_segments(kind: str, km: float, f: float, rng: random.Random) -> list[tuple[float, float, float]]:
    """(metres, m/s, target bpm) per segment. Paces in s/km improve with fitness f in [0, 1]."""
    v = lambda spk: 1000 / spk  # noqa: E731
    easy, rec = 335 - 25 * f, 352 - 20 * f
    if kind in ("easy", "recovery"):
        p = easy if kind == "easy" else rec
        hr = 143 if kind == "easy" else 134
        return [(km * 1000, v(p + rng.uniform(-4, 4)), hr + rng.uniform(-2, 2))]
    if kind == "long":
        quarter = km * 250
        base = 340 - 25 * f
        return [(quarter, v(base + 6), 144), (quarter, v(base), 148), (quarter, v(base - 2), 152), (quarter, v(base - 5), 156)]
    if kind == "tempo":
        t = 275 - 20 * f
        return [(2000, v(easy + 5), 140), (6000, v(t), 167), ((km - 8) * 1000, v(easy + 10), 150)]
    if kind == "intervals":
        rep = 250 - 20 * f
        segs: list[tuple[float, float, float]] = [(2000, v(easy + 5), 140)]
        for i in range(6):
            segs.append((1000, v(rep + i * 1.5), 173 + i))
            if i < 5:
                segs.append((400, v(390), 150))
        segs.append(((km - 10) * 1000, v(easy + 12), 148))
        return segs
    if kind == "parkrun":
        p = 258 - 22 * f
        return [(1000, v(p - 3), 168), (3000, v(p), 179), (1020, v(p - 6), 186)]
    if kind == "race":
        p = 278 - 10 * f
        return [(5000, v(p + 4), 165), (10000, v(p), 172), (5000, v(p - 3), 177), (1150, v(p - 10), 184)]
    raise ValueError(kind)


def simulate(segs: list[tuple[float, float, float]], route: Route, f: float,
             rng: random.Random) -> dict[str, list[Any]]:
    """One-hertz time, distance, heart rate, cadence, altitude and position streams.

    The watch is started a few metres into the route (a different spot each run) and its fix
    wanders with smoothed noise of 2-3 m per axis, so repeated laps overlap the way real
    recordings do instead of retracing one line. Cadence is full steps per minute, rising with
    pace and a little with fitness f, and 0 while standing still (the first sample).
    """
    start_offset = rng.uniform(0, 12)                 # metres into the route when the watch starts
    sigma = rng.uniform(2.0, 3.0)                     # GPS error per axis, metres
    smooth = 0.95                                     # AR(1) factor: the error drifts over ~20 s
    innovation = sigma * math.sqrt(1 - smooth ** 2)   # keeps the stationary spread at sigma
    err_x, err_y = rng.gauss(0, sigma), rng.gauss(0, sigma)
    cos_lat = math.cos(math.radians(route.lat))

    def fix(d: float) -> tuple[float, float, float]:
        nonlocal err_x, err_y
        la, lo, al = route.point(d + start_offset)
        err_x = smooth * err_x + rng.gauss(0, innovation)
        err_y = smooth * err_y + rng.gauss(0, innovation)
        return la + err_y / 111_320, lo + err_x / (111_320 * cos_lat), al

    t, dist, hr, cad = [0], [0.0], [float(rng.uniform(88, 100))], [0]
    la, lo, al = fix(0.0)
    lat, lng, alt = [la], [lo], [al]
    noise = cad_noise = 0.0
    for seg_m, v, target in segs:
        cad_target = 168 + 6 * f + 10 * min(1.0, max(0.0, (v - 2.8) / 1.4))   # ~170 easy, ~184 flat out
        covered = 0.0
        while covered < seg_m:
            noise = 0.92 * noise + rng.gauss(0, 0.02)
            step = max(0.3, v * (1 + noise))
            covered += step
            t.append(t[-1] + 1)
            dist.append(dist[-1] + step)
            h = hr[-1] + (target - hr[-1]) / 40 + rng.gauss(0, 0.6)
            hr.append(min(HR_MAX - 1, max(70.0, h)))
            cad_noise = 0.9 * cad_noise + rng.gauss(0, 0.6)
            cad.append(0 if step < 0.5 else int(round(cad_target + cad_noise)))
            la, lo, al = fix(dist[-1])
            lat.append(la)
            lng.append(lo)
            alt.append(al)
    return {"t": t, "d": dist, "hr": [int(round(h)) for h in hr], "cad": cad, "alt": alt, "lat": lat, "lng": lng}


def zone_times(hr: list[int]) -> list[int]:
    out = [0] * len(HR_ZONES)
    for h in hr:
        for z, top in enumerate(HR_ZONES):
            if h <= top:
                out[z] += 1
                break
        else:
            out[-1] += 1
    return out


RUN_NAMES = {"easy": "Morning Run", "recovery": "Recovery jog", "long": "Long run", "tempo": "Tempo Tuesday",
             "intervals": "6 × 1 km", "parkrun": "Parkrun", "race": "Melbourne Half Marathon"}
RUN_ROUTES = {"easy": "tan", "recovery": "princes", "long": "yarra", "tempo": "albert", "intervals": "albert",
              "parkrun": "albert", "race": "yarra"}


def season_temp(day: date, at: time, rng: random.Random) -> float:
    doy = day.timetuple().tm_yday
    base = 14 + 7 * math.sin(2 * math.pi * (doy - 20) / 365)  # southern hemisphere: warm in January
    return round(base - (3 if at.hour < 8 else 0) + rng.gauss(0, 2), 1)


def make_run(e: Event, idx: int, f: float, day_rhr: int, day_weight: float, vo2: float,
             rng: random.Random) -> tuple[dict[str, Any], dict[str, Any]]:
    """An activities row plus its activity_details record, both via the sync job's maths."""
    route = ROUTES[RUN_ROUTES[e.kind]]
    s = simulate(run_segments(e.kind, e.km or 5.0, f, rng), route, f, rng)
    act_id = f"demo{idx:04d}"
    local = datetime.combine(e.day, e.at)
    start_utc = local.replace(tzinfo=TZ).astimezone(UTC)
    moving = s["t"][-1]
    distance = s["d"][-1]
    v_avg = distance / moving
    avg_hr = sum(s["hr"]) / len(s["hr"])
    climb = sum(max(0.0, b - a) for a, b in zip(s["alt"], s["alt"][1:]))
    descent = sum(max(0.0, a - b) for a, b in zip(s["alt"], s["alt"][1:]))
    intensity = (avg_hr - HR_REST) / (LTHR - HR_REST)
    load = moving / 3600 * intensity ** 2 * 100
    moving_cad = [c for c in s["cad"] if c > 0]
    cadence = sum(moving_cad) / len(moving_cad)       # the activity figure agrees with its stream
    stride = v_avg * 60 / cadence
    row: dict[str, Any] = {c: None for c in ACTIVITY_COLUMNS}
    row.update({
        "id": act_id, "user_id": str(DEMO_ID),
        "start_time": start_utc, "start_time_local": local, "timezone": "Australia/Melbourne",
        "type": "Run", "name": RUN_NAMES[e.kind],
        "distance_m": round(distance, 1), "moving_time_s": moving,
        "elapsed_time_s": moving + (rng.randint(60, 200) if e.kind == "intervals" else rng.randint(0, 75)),
        "avg_hr": int(round(avg_hr)), "max_hr": max(s["hr"]),
        "cadence": round(cadence, 1), "stride_m": round(stride, 2),
        "gct_ms": round(300 - 24 * v_avg - 6 * f + rng.gauss(0, 4), 1),
        "gct_pct": round(36 - 2 * v_avg + rng.gauss(0, 0.5), 1),
        "vert_osc_cm": round(8.6 - 0.6 * f + rng.gauss(0, 0.25), 2),
        "vert_ratio": round((8.6 - 0.6 * f) / (stride * 100) * 100 + rng.gauss(0, 0.2), 1),
        "vo2max": vo2,
        "elev_gain_m": round(climb, 1), "elev_loss_m": round(descent, 1),
        "load": round(load, 1), "intensity": round(intensity * 100, 1), "trimp": round(load * 1.2, 1),
        "gap_ms": round(v_avg * (1 + 4.5 * climb / max(distance, 1)), 3),
        "avg_temp_c": season_temp(e.day, e.at, rng), "calories": round(distance / 1000 * 68),
        "resting_hr": day_rhr, "weight_kg": round(day_weight, 1), "lthr": LTHR, "athlete_max_hr": HR_MAX,
        "device": DEVICE, "gear_id": None,
        "hr_zone_times": zone_times(s["hr"]), "hr_zones": HR_ZONES, "pace_zone_times": None,
        "raw": json.dumps({"id": act_id, "name": RUN_NAMES[e.kind], "type": "Run",
                           "start_date_local": local.isoformat(), "source": "splitset demo seed"}),
    })
    streams = [
        {"type": "time", "data": s["t"]}, {"type": "distance", "data": [round(x, 2) for x in s["d"]]},
        {"type": "heartrate", "data": s["hr"]}, {"type": "altitude", "data": [round(a, 2) for a in s["alt"]]},
        {"type": "cadence", "data": s["cad"]},
        {"type": "latlng", "data": s["lat"], "data2": s["lng"]},
    ]
    return row, derive_details(streams, act_id, is_run=True)


def make_other(e: Event, idx: int, f: float, day_rhr: int, day_weight: float, rng: random.Random) -> dict[str, Any]:
    """A gym, walk or ride row without streams."""
    act_id = f"demo{idx:04d}"
    local = datetime.combine(e.day, e.at)
    start_utc = local.replace(tzinfo=TZ).astimezone(UTC)
    row: dict[str, Any] = {c: None for c in ACTIVITY_COLUMNS}
    if e.kind == "gym":
        moving = rng.randint(50, 68) * 60
        avg_hr, max_hr, load = rng.randint(108, 120), rng.randint(142, 158), rng.uniform(22, 34)
        name, typ, dist = e.routine, "WeightTraining", None
        cal = round(moving / 60 * 5.2)
    elif e.kind == "walk":
        moving = int((e.km or 4) * 1000 / 1.42)
        avg_hr, max_hr, load = rng.randint(88, 98), rng.randint(105, 118), rng.uniform(8, 14)
        name, typ, dist = "Evening walk", "Walk", (e.km or 4) * 1000
        cal = round((e.km or 4) * 55)
    else:
        moving = int((e.km or 20) * 1000 / (7.3 + f))
        avg_hr, max_hr, load = rng.randint(118, 130), rng.randint(150, 165), rng.uniform(28, 40)
        name, typ, dist = "Easy spin", "Ride", (e.km or 20) * 1000
        cal = round((e.km or 20) * 24)
    row.update({
        "id": act_id, "user_id": str(DEMO_ID), "start_time": start_utc, "start_time_local": local,
        "timezone": "Australia/Melbourne", "type": typ, "name": name,
        "distance_m": None if dist is None else round(dist, 1), "moving_time_s": moving,
        "elapsed_time_s": moving + rng.randint(30, 240), "avg_hr": avg_hr, "max_hr": max_hr,
        "cadence": round(rng.uniform(78, 86), 1) if typ == "Ride" else None,
        "load": round(load, 1), "intensity": round((avg_hr - HR_REST) / (LTHR - HR_REST) * 100, 1),
        "trimp": round(load * 1.2, 1), "calories": cal, "avg_temp_c": season_temp(e.day, e.at, rng),
        "resting_hr": day_rhr, "weight_kg": round(day_weight, 1), "lthr": LTHR, "athlete_max_hr": HR_MAX,
        "device": DEVICE, "hr_zones": HR_ZONES,
        "raw": json.dumps({"id": act_id, "name": name, "type": typ, "start_date_local": local.isoformat(),
                           "source": "splitset demo seed"}),
    })
    return row


# ---------------------------------------------------------------- lifting

def round_to(x: float, step: float) -> float:
    return round(round(x / step) * step, 2) if step else x


def make_workout(e: Event, w: int, n: int, exercise_ids: dict[str, UUID], routine_ids: dict[str, UUID],
                 activity_id: str, bodyweight: float, rng: random.Random) -> tuple[dict, list[dict], list[dict]]:
    """A finished workouts row with its workout_exercises and workout_sets."""
    f = w / (n - 1)
    deload = w % 4 == 3
    assert e.routine is not None
    start = datetime.combine(e.day, e.at).replace(tzinfo=TZ).astimezone(UTC)
    wid = sid("workout", e.day)
    clock = start + timedelta(minutes=4)
    exercises: list[dict] = []
    sets: list[dict] = []
    for pos, (name, scheme, w0, w1, step, warm, rest) in enumerate(GYM[e.routine]):
        weid = sid("we", e.day, pos)
        exercises.append({"id": weid, "workout_id": wid, "user_id": DEMO_ID, "exercise_id": exercise_ids[name],
                          "position": pos, "superset_group": None, "rest_seconds": rest, "notes": None,
                          "updated_at": start})
        top = None if w0 is None else round_to((w0 + (w1 - w0) * f) * (0.9 if deload else 1.0), step)
        if name == "Pull-up" and top is not None and top < 2.5:
            top = None                                   # bodyweight until the extra plate arrives
        plan: list[tuple[str, float | None, int]] = []
        if warm and top:
            plan += [("warmup", round_to(top * 0.4, step), 8), ("warmup", round_to(top * 0.6, step), 5),
                     ("warmup", round_to(top * 0.8, step), 3)]
        plan += [("working", top, r) for r in scheme]
        timed = name in DURATION_EXERCISES
        for spos, (kind, kg, target) in enumerate(plan):
            reps_done = target
            if kind == "working" and spos == len(plan) - 1 and rng.random() < 0.2 and not timed:
                reps_done = max(1, target - rng.randint(1, 2))
            clock += timedelta(seconds=(target if timed else 45) + rng.randint(-5, 10))
            working_before = sum(1 for p in plan[:spos] if p[0] == "working")
            rpe = None if kind == "warmup" else min(9.5, 7 + 0.5 * working_before + rng.choice([0, 0, 0.5]))
            sets.append({
                "id": sid("set", e.day, pos, spos), "workout_exercise_id": weid, "workout_id": wid,
                "exercise_id": exercise_ids[name], "user_id": DEMO_ID, "position": spos, "set_type": kind,
                "weight_kg": None if timed else kg,
                "reps": None if timed else reps_done,
                "rpe": rpe, "seconds": reps_done if timed else None, "distance_m": None,
                "completed": True, "completed_at": clock, "notes": None, "updated_at": clock,
            })
            clock += timedelta(seconds=rest + rng.randint(-10, 20))
    finished = clock + timedelta(minutes=3)
    workout = {"id": wid, "user_id": DEMO_ID, "routine_id": routine_ids[e.routine], "name": e.routine,
               "started_at": start, "finished_at": finished,
               "notes": "Felt heavy today" if deload and rng.random() < 0.5 else None,
               "bodyweight_kg": round(bodyweight, 1), "activity_id": activity_id, "linked_by": "auto",
               "created_at": start, "updated_at": finished}
    return workout, exercises, sets


# ---------------------------------------------------------------- database

AUTH_INSERT = """
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, created_at, updated_at,
  phone_change, phone_change_token, email_change_token_current, email_change_confirm_status,
  reauthentication_token, is_sso_user, is_anonymous
) values (
  '00000000-0000-0000-0000-000000000000', %(id)s, 'authenticated', 'authenticated', %(email)s,
  extensions.crypt(%(password)s, extensions.gen_salt('bf', 10)), now(),
  '', '', '', '',
  '{"provider": "email", "providers": ["email"]}'::jsonb, %(meta)s::jsonb, false, now(), now(),
  '', '', '', 0,
  '', false, false
)
"""

IDENTITY_INSERT = """
insert into auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
values (gen_random_uuid(), %(id)s::text, %(id)s, %(identity)s::jsonb, 'email', now(), now(), now())
"""


def reset_user(conn: psycopg.Connection[Any], email: str, password: str) -> None:
    other = conn.execute("select id from auth.users where lower(email) = lower(%s) and id <> %s",
                         (email, DEMO_ID)).fetchone()
    if other:
        raise SystemExit(f"{email} belongs to an existing account that is not the demo athlete; refusing to touch it. "
                         "Pick a different EXPO_PUBLIC_DEMO_EMAIL.")
    if len(password) < 12:
        raise SystemExit("EXPO_PUBLIC_DEMO_PASSWORD must be at least 12 characters.")
    conn.execute("delete from auth.users where id = %s", (DEMO_ID,))   # cascades through profiles to every table
    meta = json.dumps({"display_name": DISPLAY_NAME, "timezone": "Australia/Melbourne", "demo": True})
    conn.execute(AUTH_INSERT, {"id": DEMO_ID, "email": email.lower(), "password": password, "meta": meta})
    identity = json.dumps({"sub": str(DEMO_ID), "email": email.lower(), "email_verified": True, "phone_verified": False})
    conn.execute(IDENTITY_INSERT, {"id": DEMO_ID, "identity": identity})
    conn.execute("update public.profiles set display_name = %s, timezone = 'Australia/Melbourne', units = 'metric' where id = %s",
                 (DISPLAY_NAME, DEMO_ID))


def insert_rows(conn: psycopg.Connection[Any], table: str, rows: list[dict[str, Any]]) -> int:
    if not rows:
        return 0
    cols = list(rows[0])
    q = f"insert into public.{table} ({', '.join(cols)}) values ({', '.join('%s' for _ in cols)})"
    with conn.cursor() as cur:
        cur.executemany(q, [tuple(r[c] for c in cols) for r in rows])
    return len(rows)


# ---------------------------------------------------------------- main

PLAN_META = {
    "easy": ("run", "easy", "Easy {km} km", "Conversational. Keep it honest."),
    "recovery": ("run", "recovery", "Recovery {km} km", "Slower than feels necessary."),
    "long": ("run", "long", "Long run {km} km", "Steady, last quarter a touch quicker."),
    "tempo": ("run", "tempo", "Tempo 6 km", "2 km warm-up, 6 km at threshold, jog home."),
    "intervals": ("run", "intervals", "6 × 1 km", "6 × 1 km at 10 km pace, 400 m jog recoveries."),
    "parkrun": ("run", "race", "Parkrun", "Race it."),
    "race": ("run", "race", "Melbourne Half Marathon", "Goal 1:38. Even splits, kick from 18 km."),
    "walk": ("walk", None, "Walk", None),
    "ride": ("ride", None, "Easy spin", "Zone 2 only."),
    "rest": ("rest", None, "Rest day", None),
    "gym": ("strength", None, "{routine}", None),
}


def main() -> None:
    db_url = env("SUPABASE_DB_URL")
    email = env("EXPO_PUBLIC_DEMO_EMAIL")
    password = env("EXPO_PUBLIC_DEMO_PASSWORD")
    if not db_url or not email or not password:
        raise SystemExit("Set SUPABASE_DB_URL, EXPO_PUBLIC_DEMO_EMAIL and EXPO_PUBLIC_DEMO_PASSWORD "
                         "in the environment or the root .env (see .env.example).")

    rng = random.Random(SEED)
    now_local = datetime.now(TZ)
    today = now_local.date()
    events, n = build_year(today)
    first_monday = today - timedelta(days=today.weekday()) - timedelta(weeks=52)
    week_of = lambda d: (d - first_monday).days // 7  # noqa: E731
    fitness = lambda d: min(max(week_of(d), 0), n - 1) / (n - 1)  # noqa: E731

    # daily baselines that the activities also quote
    day0, days = first_monday - timedelta(days=7), []
    d = day0
    while d <= today:
        days.append(d)
        d += timedelta(days=1)
    sick_days = {first_monday + timedelta(weeks=n - 10, days=i) for i in range(1, 5)}
    base_rhr = {d: int(round(53 - 5 * fitness(d) + rng.gauss(0, 1.1) + (7 if d in sick_days else 0))) for d in days}
    base_weight = {d: 74.6 - 1.8 * fitness(d) + rng.gauss(0, 0.3) for d in days}
    vo2 = {d: float(round(50 + 4.4 * fitness(d))) for d in days}

    # ---- the shared exercise library must be in place
    with db.connect(db_url) as conn:
        rows = conn.execute("select id, name, slug from public.exercises where owner_id is null").fetchall()
    exercise_ids = {r["name"]: r["id"] for r in rows}
    # seed_library.py renames matched rows to the library's names ("Bench press" becomes
    # "Bench press (barbell)"); GYM keeps the old names, which still resolve through the slug
    by_slug = {r["slug"]: r["id"] for r in rows if r["slug"]}
    for name, slug in LEGACY_NAMES.items():
        if name not in exercise_ids and slug in by_slug:
            exercise_ids[name] = by_slug[slug]
    missing = {x[0] for ex in GYM.values() for x in ex} - set(exercise_ids)
    if missing:
        raise SystemExit(f"exercise library is missing {sorted(missing)}; apply the migrations first")
    routine_ids = {name: sid("routine", name) for name in GYM}

    # ---- activities (past only) and a workout for every gym day
    act_rows: list[dict[str, Any]] = []
    detail_recs: list[dict[str, Any]] = []
    workouts: list[dict] = []
    wexercises: list[dict] = []
    wsets: list[dict] = []
    activity_of: dict[int, str] = {}      # event index -> activity id
    workout_of: dict[int, UUID] = {}
    idx = 0
    for i, e in enumerate(events):
        if not e.happened or e.kind == "rest":
            continue
        starts = datetime.combine(e.day, e.at).replace(tzinfo=TZ)
        if starts + timedelta(hours=2) > now_local:
            continue
        idx += 1
        f = fitness(e.day)
        if e.kind in RUN_NAMES:
            row, rec = make_run(e, idx, f, base_rhr[e.day], base_weight[e.day], vo2[e.day], rng)
            detail_recs.append(rec)
        else:
            row = make_other(e, idx, f, base_rhr[e.day], base_weight[e.day], rng)
        act_rows.append(row)
        activity_of[i] = row["id"]
        if e.kind == "gym":
            wk, wex, ws = make_workout(e, week_of(e.day), n, exercise_ids, routine_ids, row["id"], base_weight[e.day], rng)
            workouts.append(wk)
            wexercises += wex
            wsets += ws
            workout_of[i] = wk["id"]

    # ---- wellness, with fitness and fatigue driven by the activities above
    load_by_day: dict[date, float] = {}
    ran_on: set[date] = set()
    for r in act_rows:
        dd = r["start_time_local"].date()
        load_by_day[dd] = load_by_day.get(dd, 0.0) + (r["load"] or 0.0)
        if r["type"] == "Run":
            ran_on.add(dd)
    race_day = next((e.day for e in events if e.kind == "race"), None)
    ctl, atl, ctl_hist, wrows = 32.0, 32.0, [], []
    for dd in days:
        load = load_by_day.get(dd, 0.0)
        ctl += (load - ctl) / 42
        atl += (load - atl) / 7
        ctl_hist.append(ctl)
        f = fitness(dd)
        sick = dd in sick_days
        strain = max(0.0, atl - ctl)
        rhr = base_rhr[dd] + (1 if strain > 8 else 0) + (4 if race_day and dd == race_day + timedelta(days=1) else 0)
        hrv = 52 + 16 * f + rng.gauss(0, 6) - 0.4 * strain - (15 if sick else 0)
        hrv = max(25.0, min(110.0, hrv))
        weigh_day = dd.weekday() in (0, 2, 4, 5)
        sleep_h = max(5.0, min(9.2, rng.gauss(7.2, 0.6) - (0.5 if dd.weekday() == 5 else 0)))
        sleep_score = max(30.0, min(98.0, 50 + (sleep_h - 5.5) * 12 + rng.gauss(0, 6)))
        row: dict[str, Any] = {c: None for c in WELLNESS_COLUMNS}
        row.update({
            "user_id": str(DEMO_ID), "date": dd,
            "resting_hr": rhr,
            "hrv": None if rng.random() < 0.06 else round(hrv, 1),
            "hrv_sdnn": None if rng.random() < 0.06 else round(hrv * 1.35 + rng.gauss(0, 3), 1),
            "weight_kg": round(base_weight[dd], 1) if weigh_day else None,
            "body_fat_pct": round(16.5 - 2 * f + rng.gauss(0, 0.3), 1) if weigh_day else None,
            "sleep_s": None if rng.random() < 0.03 else int(sleep_h * 3600),
            "sleep_score": round(sleep_score), "sleep_quality": max(1, min(5, round(sleep_score / 20))),
            "vo2max": vo2[dd], "ctl": round(ctl, 1), "atl": round(atl, 1),
            "ramp_rate": round(ctl - ctl_hist[max(0, len(ctl_hist) - 8)], 1),
            "steps": 2500 if sick else max(2500, int(rng.gauss(7200 + (4200 if dd in ran_on else 0), 1500))),
            "stress": round(max(5.0, 28 + rng.gauss(0, 7) + (15 if sick else 0))),
            "respiration": round(14.2 + rng.gauss(0, 0.6), 1),
            "spo2": round(max(93.0, min(100.0, 97 + rng.gauss(0, 0.8)))),
            "readiness": round(max(20.0, min(100.0, 70 + (hrv - (52 + 16 * f)) / 2 - (rhr - base_rhr[dd]) * 2
                                                 - strain * 0.6 + rng.gauss(0, 4)))),
            "source": "intervals",
        })
        row["raw"] = json.dumps({"id": dd.isoformat(), "source": "splitset demo seed"})
        wrows.append(row)

    # ---- routines (templates) carrying the current targets
    routines, rexercises, rsets = [], [], []
    for rpos, (rname, exs) in enumerate(GYM.items()):
        rid = routine_ids[rname]
        routines.append({"id": rid, "user_id": DEMO_ID, "name": rname, "position": rpos, "archived": False,
                         "notes": "Lower body, squat focus" if rname == "Lower A" else None})
        for pos, (name, scheme, w0, w1, step, warm, rest) in enumerate(exs):
            reid = sid("re", rname, pos)
            rexercises.append({"id": reid, "routine_id": rid, "user_id": DEMO_ID, "exercise_id": exercise_ids[name],
                               "position": pos, "superset_group": None, "rest_seconds": rest, "notes": None})
            timed = name in DURATION_EXERCISES
            top = None if w0 is None or name == "Pull-up" else round_to(w1, step)
            for spos, target in enumerate(scheme):
                rsets.append({"id": sid("rs", rname, pos, spos), "routine_exercise_id": reid, "user_id": DEMO_ID,
                              "position": spos, "set_type": "working",
                              "target_reps": None if timed else target, "target_reps_max": None,
                              "target_weight_kg": None if timed else top,
                              "target_rpe": None, "target_seconds": target if timed else None})

    # ---- plan: three weeks back to two weeks ahead
    plan_from = first_monday + timedelta(weeks=n - 4)
    plan_to = first_monday + timedelta(weeks=n + 2) - timedelta(days=1)
    plans = []
    for i, e in enumerate(events):
        if not (plan_from <= e.day <= plan_to):
            continue
        ptype, subtype, title, notes = PLAN_META[e.kind]
        title = title.format(km=f"{e.km:g}" if e.km else "", routine=e.routine or "")
        status, linked_by, act_id, wo_id = "planned", None, None, None
        if e.skipped:
            status = "skipped"
        elif i in workout_of:
            status, linked_by, wo_id = "done", "auto", workout_of[i]
        elif i in activity_of:
            status, linked_by, act_id = "done", "auto", activity_of[i]
        elif e.kind == "rest" and e.day < today:
            status, linked_by = "done", "manual"
        plans.append({
            "id": sid("plan", e.day, e.kind), "user_id": DEMO_ID, "date": e.day, "position": 0, "type": ptype,
            "subtype": "lower" if e.routine and e.routine.startswith("Lower") else "upper" if e.routine else subtype,
            "title": title, "target_distance_m": e.km * 1000 if e.km and ptype in ("run", "walk", "ride") else None,
            "target_seconds": int(e.km * 330) if e.kind == "long" and e.km else None,
            "routine_id": routine_ids[e.routine] if e.routine else None, "notes": notes,
            "status": status, "activity_id": act_id, "workout_id": wo_id, "linked_by": linked_by,
        })

    # ---- connection and the sync log
    last_cron = datetime.combine(today, time(5, 17)).replace(tzinfo=TZ)
    if last_cron > now_local:
        last_cron -= timedelta(days=1)
    sync_runs = []
    for k in range(6):
        started = last_cron - timedelta(hours=14 * (k % 2) + 24 * (k // 2))
        sync_runs.append({"user_id": DEMO_ID, "started_at": started,
                          "finished_at": started + timedelta(seconds=rng.randint(28, 70)),
                          "status": "ok", "triggered_by": "cron",
                          "github_run_id": str(18_270_000_000 + rng.randint(0, 99_999)),
                          "window_oldest": started.date() - timedelta(days=7),
                          "window_newest": started.date() + timedelta(days=1),
                          "activities_fetched": rng.randint(3, 6), "activities_upserted": rng.randint(3, 6),
                          "streams_fetched": rng.randint(0, 2), "streams_pending": 0, "wellness_days": 8,
                          "plan_links": rng.randint(0, 1), "error": None})
    # paused on purpose: the sync job only picks up active connections, and this one has no key
    connection = {"user_id": DEMO_ID, "athlete_id": ATHLETE_ID, "api_key_secret_id": None, "status": "paused",
                  "oldest_date": first_monday - timedelta(days=7), "last_synced_at": last_cron,
                  "last_success_at": last_cron, "last_error": None, "consecutive_auth_failures": 0}

    # ---- write everything in one transaction
    with db.connect(db_url) as conn:
        reset_user(conn, email, password)
        n_act = db.upsert_activities(conn, act_rows)
        for rec in detail_recs:
            db.upsert_details(conn, DEMO_ID, rec)
        n_well = db.upsert_wellness(conn, wrows)
        insert_rows(conn, "intervals_connections", [connection])
        insert_rows(conn, "sync_runs", sync_runs)
        insert_rows(conn, "exercises", [{"id": sid("exercise", "box"), "owner_id": DEMO_ID,
                                         "name": "Single-leg box squat", "muscle_group": "quads",
                                         "equipment": "bodyweight", "measure": "weight_reps",
                                         "is_bodyweight": True, "is_unilateral": True}])
        insert_rows(conn, "routines", routines)
        insert_rows(conn, "routine_exercises", rexercises)
        insert_rows(conn, "routine_sets", rsets)
        insert_rows(conn, "workouts", workouts)
        insert_rows(conn, "workout_exercises", wexercises)
        insert_rows(conn, "workout_sets", wsets)
        insert_rows(conn, "plan_sessions", plans)
        e1rms = backfill(conn, DEMO_ID)   # every set's e1RM, from the app's engine (build phase 3)
        conn.commit()

    runs = sum(1 for r in act_rows if r["type"] == "Run")
    print(f"demo athlete {email} rebuilt (user {DEMO_ID})")
    print(f"  activities {n_act} ({runs} runs with stream detail, {len(workouts)} gym, "
          f"{n_act - runs - len(workouts)} other) from {act_rows[0]['start_time_local'].date()} "
          f"to {act_rows[-1]['start_time_local'].date()}")
    print(f"  wellness {n_well} days, {len(wsets)} sets in {len(workouts)} workouts, {len(routines)} routines, "
          f"{len(plans)} plan sessions ({plan_from} to {plan_to}), {len(sync_runs)} sync runs")
    print(f"  e1RMs on {e1rms.sets} sets, bodyweight on {e1rms.workouts} more workouts")


if __name__ == "__main__":
    main()
