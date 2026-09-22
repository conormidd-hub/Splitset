#!/usr/bin/env python3
"""Builds grafana/dashboards/splitset.json from a compact panel description.

    python grafana/build_dashboard.py

Hand-editing Grafana JSON is miserable; regenerating it from here is not. Every panel queries
the `reporting` schema and filters on the `$user` dashboard variable. Import the JSON in Grafana
(Dashboards, New, Import) and pick your Splitset PostgreSQL datasource when prompted.
"""

from __future__ import annotations

import json
from pathlib import Path

DS = {"type": "grafana-postgresql-datasource", "uid": "${DS_SPLITSET}"}
U = "user_id = '${user}'::uuid"

OUT = Path(__file__).parent / "dashboards" / "splitset.json"

_id = 0


def next_id() -> int:
    global _id
    _id += 1
    return _id


def target(raw_sql: str, fmt: str = "time_series", ref: str = "A") -> dict:
    return {"refId": ref, "datasource": DS, "rawQuery": True, "editorMode": "code",
            "format": fmt, "rawSql": raw_sql.strip()}


def timeseries(title: str, grid: tuple[int, int, int, int], targets: list[dict], *, unit: str | None = None,
               draw: str = "line", fill: int = 10, stack: bool = False, min_: float | None = None,
               max_: float | None = None, thresholds: list[dict] | None = None, threshold_style: str = "off",
               description: str = "", decimals: int | None = None, overrides: list[dict] | None = None) -> dict:
    x, y, w, h = grid
    custom = {"drawStyle": draw, "lineWidth": 2 if draw == "line" else 1, "fillOpacity": fill,
              "showPoints": "never" if draw == "line" else "auto", "pointSize": 5, "spanNulls": True,
              "stacking": {"mode": "normal" if stack else "none", "group": "A"},
              "thresholdsStyle": {"mode": threshold_style}, "axisSoftMin": min_}
    defaults: dict = {"custom": custom, "color": {"mode": "palette-classic"}}
    if unit:
        defaults["unit"] = unit
    if decimals is not None:
        defaults["decimals"] = decimals
    if min_ is not None:
        defaults["min"] = min_
    if max_ is not None:
        defaults["max"] = max_
    if thresholds:
        defaults["thresholds"] = {"mode": "absolute", "steps": thresholds}
    return {"id": next_id(), "type": "timeseries", "title": title, "description": description,
            "datasource": DS, "gridPos": {"x": x, "y": y, "w": w, "h": h},
            "fieldConfig": {"defaults": defaults, "overrides": overrides or []},
            "options": {"legend": {"displayMode": "list", "placement": "bottom", "showLegend": True},
                        "tooltip": {"mode": "multi", "sort": "none"}},
            "targets": targets}


def stat(title: str, grid: tuple[int, int, int, int], raw_sql: str, *, unit: str | None = None,
         decimals: int | None = None, thresholds: list[dict] | None = None, description: str = "") -> dict:
    x, y, w, h = grid
    defaults: dict = {"color": {"mode": "thresholds"},
                      "thresholds": {"mode": "absolute", "steps": thresholds or [{"color": "text", "value": None}]}}
    if unit:
        defaults["unit"] = unit
    if decimals is not None:
        defaults["decimals"] = decimals
    return {"id": next_id(), "type": "stat", "title": title, "description": description, "datasource": DS,
            "gridPos": {"x": x, "y": y, "w": w, "h": h},
            "fieldConfig": {"defaults": defaults, "overrides": []},
            "options": {"reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
                        "colorMode": "value", "graphMode": "none", "justifyMode": "auto", "textMode": "auto",
                        "orientation": "auto", "wideLayout": True},
            "targets": [target(raw_sql, "table")]}


def table(title: str, grid: tuple[int, int, int, int], raw_sql: str, description: str = "") -> dict:
    x, y, w, h = grid
    return {"id": next_id(), "type": "table", "title": title, "description": description, "datasource": DS,
            "gridPos": {"x": x, "y": y, "w": w, "h": h},
            "fieldConfig": {"defaults": {"custom": {"align": "auto", "cellOptions": {"type": "auto"}}}, "overrides": []},
            "options": {"showHeader": True, "cellHeight": "sm", "footer": {"show": False}},
            "targets": [target(raw_sql, "table")]}


def row(title: str, y: int) -> dict:
    return {"id": next_id(), "type": "row", "title": title, "collapsed": False,
            "gridPos": {"x": 0, "y": y, "w": 24, "h": 1}, "panels": []}


PACE = "to_char(make_interval(secs => round(sec_per_km)), 'MI:SS')"

panels = [
    # ---------------------------------------------------------------- headline
    stat("Run km, last 7 days", (0, 0, 4, 4),
         f"select coalesce(sum(km), 0) as value from reporting.daily_load where {U} and day > current_date - 7",
         unit="lengthkm", decimals=1),
    stat("Run km, last 28 days", (4, 0, 4, 4),
         f"select coalesce(sum(km), 0) as value from reporting.daily_load where {U} and day > current_date - 28",
         unit="lengthkm", decimals=0),
    stat("Fitness (CTL)", (8, 0, 4, 4),
         f"select ctl as value from reporting.wellness_daily where {U} and ctl is not null order by date desc limit 1",
         decimals=1, description="42-day exponentially weighted training load, from intervals.icu."),
    stat("Fatigue (ATL)", (12, 0, 4, 4),
         f"select atl as value from reporting.wellness_daily where {U} and atl is not null order by date desc limit 1",
         decimals=1, description="7-day exponentially weighted training load."),
    stat("Acute:chronic", (16, 0, 4, 4),
         f"select acwr as value from reporting.daily_load where {U} and acwr is not null order by day desc limit 1",
         decimals=2, description="7-day mean daily load over 28-day mean. 0.8 to 1.3 is the usual comfort band.",
         thresholds=[{"color": "blue", "value": None}, {"color": "green", "value": 0.8}, {"color": "red", "value": 1.3}]),
    stat("Resting HR, 7-day mean", (20, 0, 4, 4),
         f"select rhr_7d as value from reporting.wellness_daily where {U} and resting_hr is not null order by date desc limit 1",
         unit="bpm", decimals=0),

    # ---------------------------------------------------------------- volume and load
    row("Volume and load", 4),
    timeseries("Weekly running distance", (0, 5, 12, 8), [target(
        f"select week as time, km as \"km\" from reporting.weekly_volume where {U} and type in ('Run','VirtualRun','TrailRun') and $__timeFilter(week) order by 1")],
        unit="lengthkm", draw="bars", fill=80, decimals=0),
    timeseries("Longest run each week", (12, 5, 12, 8), [target(
        f"select week as time, max(longest_km) as \"longest\" from reporting.weekly_volume where {U} and type in ('Run','VirtualRun','TrailRun') and $__timeFilter(week) group by 1 order by 1")],
        unit="lengthkm", draw="bars", fill=80, decimals=1,
        description="A staircase with step-backs, not a sawtooth."),
    timeseries("Daily load: acute vs chronic", (0, 13, 12, 8), [target(
        f"select day as time, load as \"daily load\", acute_7d as \"7-day mean\", chronic_28d as \"28-day mean\" from reporting.daily_load where {U} and $__timeFilter(day) order by 1")],
        overrides=[{"matcher": {"id": "byName", "options": "daily load"},
                    "properties": [{"id": "custom.drawStyle", "value": "bars"}, {"id": "custom.fillOpacity", "value": 40},
                                   {"id": "custom.lineWidth", "value": 0}]}]),
    timeseries("Acute:chronic workload ratio", (12, 13, 12, 8), [target(
        f"select day as time, acwr as \"ACWR\" from reporting.daily_load where {U} and $__timeFilter(day) order by 1")],
        min_=0, max_=2, decimals=2, threshold_style="area",
        thresholds=[{"color": "transparent", "value": None}, {"color": "green", "value": 0.8}, {"color": "red", "value": 1.3}],
        description="A ramp gauge, not an injury score. Rising fast above 1.3 means the last week is well above what the last month prepared you for."),
    timeseries("Fitness and fatigue", (0, 21, 12, 8), [target(
        f"select date as time, ctl as \"Fitness (CTL)\", atl as \"Fatigue (ATL)\", tsb as \"Form (CTL - ATL)\" from reporting.wellness_daily where {U} and ctl is not null and $__timeFilter(date) order by 1")],
        decimals=0,
        overrides=[{"matcher": {"id": "byName", "options": "Fitness (CTL)"}, "properties": [{"id": "custom.fillOpacity", "value": 25}]}]),
    timeseries("Time in heart-rate zone per month (runs)", (12, 21, 12, 8), [target(
        f"select month as time, 'Z' || zone as metric, seconds / 3600.0 as hours from reporting.hr_zone_monthly where {U} and $__timeFilter(month) order by 1, 2")],
        unit="h", draw="bars", fill=80, stack=True, decimals=1),

    # ---------------------------------------------------------------- recovery
    row("Recovery", 29),
    timeseries("Resting heart rate", (0, 30, 12, 8), [target(
        f"select date as time, resting_hr as \"resting HR\", rhr_7d as \"7-day mean\", rhr_30d as \"30-day mean\" from reporting.wellness_daily where {U} and resting_hr is not null and $__timeFilter(date) order by 1")],
        unit="bpm", decimals=0, min_=35,
        overrides=[{"matcher": {"id": "byName", "options": "resting HR"},
                    "properties": [{"id": "custom.drawStyle", "value": "points"}, {"id": "custom.pointSize", "value": 4}]}]),
    timeseries("HRV", (12, 30, 12, 8), [target(
        f"select date as time, hrv as \"HRV\", hrv_7d as \"7-day mean\", hrv_60d as \"60-day mean\" from reporting.wellness_daily where {U} and hrv is not null and $__timeFilter(date) order by 1")],
        unit="ms", decimals=0,
        overrides=[{"matcher": {"id": "byName", "options": "HRV"},
                    "properties": [{"id": "custom.drawStyle", "value": "points"}, {"id": "custom.pointSize", "value": 4}]}],
        description="Act on the rolling mean leaving its usual range, not on one low morning."),
    timeseries("Sleep", (0, 38, 12, 8), [target(
        f"select date as time, sleep_h as \"hours\", sleep_s_7d / 3600.0 as \"7-day mean\" from reporting.wellness_daily where {U} and sleep_s is not null and $__timeFilter(date) order by 1")],
        unit="h", decimals=1, min_=0,
        overrides=[{"matcher": {"id": "byName", "options": "hours"},
                    "properties": [{"id": "custom.drawStyle", "value": "bars"}, {"id": "custom.fillOpacity", "value": 50}, {"id": "custom.lineWidth", "value": 0}]}]),
    timeseries("Weight (weigh-ins only)", (12, 38, 12, 8), [target(
        f"select date as time, weight_kg as \"kg\" from reporting.wellness_daily where {U} and weight_kg is not null and $__timeFilter(date) order by 1")],
        unit="masskg", decimals=1, draw="line", fill=0,
        overrides=[{"matcher": {"id": "byName", "options": "kg"}, "properties": [{"id": "custom.showPoints", "value": "always"}]}]),

    # ---------------------------------------------------------------- records and sessions
    row("Records and sessions", 46),
    table("All-time fastest by distance", (0, 47, 10, 10),
          f"""select effort_m as "Distance (m)",
                     to_char(make_interval(secs => round(seconds)), 'HH24:MI:SS') as "Time",
                     {PACE} as "Pace /km",
                     local_date as "Date", name as "Run"
                from reporting.records where {U} order by effort_m""",
          description="Fastest rolling window of each distance found inside any run, so a 5 km record can come from the middle of a 10 km."),
    table("Recent activities", (10, 47, 14, 10),
          f"""select start_time_local as "Start", type as "Type", name as "Name",
                     round(km::numeric, 1) as "km",
                     case when sec_per_km is not null then {PACE} end as "Pace /km",
                     avg_hr as "Avg HR", round(load::numeric) as "Load", round(elev_gain_m::numeric) as "Climb m"
                from reporting.activities where {U} and $__timeFilter(start_time)
               order by start_time desc limit 100"""),
    timeseries("Easy-run heart rate at pace", (0, 57, 24, 9), [target(
        f"select start_time as time, avg_hr as \"avg HR\" from reporting.activities where {U} and type in ('Run','VirtualRun','TrailRun') and avg_hr is not null and km >= 4 and $__timeFilter(start_time) order by 1")],
        unit="bpm", draw="points", fill=0,
        description="Every run of 4 km or more. The in-app trends page will do the pace-normalised version; this is the raw view."),
]

dashboard = {
    "__inputs": [{"name": "DS_SPLITSET", "label": "Splitset Postgres", "description": "", "type": "datasource",
                  "pluginId": "grafana-postgresql-datasource", "pluginName": "PostgreSQL"}],
    "__requires": [
        {"type": "grafana", "id": "grafana", "name": "Grafana", "version": "11.0.0"},
        {"type": "datasource", "id": "grafana-postgresql-datasource", "name": "PostgreSQL", "version": "1.0.0"},
        {"type": "panel", "id": "timeseries", "name": "Time series", "version": ""},
        {"type": "panel", "id": "stat", "name": "Stat", "version": ""},
        {"type": "panel", "id": "table", "name": "Table", "version": ""},
    ],
    "uid": "splitset-main",
    "title": "Splitset",
    "tags": ["splitset"],
    "timezone": "browser",
    "editable": True,
    "graphTooltip": 1,
    "schemaVersion": 39,
    "version": 1,
    "refresh": "",
    "time": {"from": "now-6M", "to": "now"},
    "timepicker": {"refresh_intervals": ["5m", "15m", "1h"]},
    "templating": {"list": [{
        "name": "user", "label": "Athlete", "type": "query", "datasource": DS,
        "query": "select display_name as __text, user_id::text as __value from reporting.users order by 1",
        "definition": "select display_name as __text, user_id::text as __value from reporting.users order by 1",
        "refresh": 1, "sort": 1, "includeAll": False, "multi": False, "current": {}, "options": [],
    }]},
    "annotations": {"list": []},
    "links": [],
    "panels": panels,
}


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(dashboard, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUT} ({len(panels)} panels)")


if __name__ == "__main__":
    main()
