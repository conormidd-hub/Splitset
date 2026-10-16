#!/usr/bin/env python3
"""Checks scripts/load_model.py against the hand-verified numbers in
docs/load-model-spec.md §13 and checks that data/load_model_fixtures.json (the
copy the app's own tests load) is up to date.

Run from the repo root:
  python3 scripts/verify_spec_fixtures.py           check only
  python3 scripts/verify_spec_fixtures.py --write   also rewrite the JSON after editing fixtures here
Exit code 1 if any fixture fails or the JSON is stale.

Fixture inputs may carry:
  extra_exercises     library entries the test must define first (custom / unmapped exercises)
  constants_override  {"pb.manual_policy": "..."} style overrides for that fixture only
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import load_model as M  # noqa: E402

TOL = 0.01


def S(w, r, n, **kw):
    return [dict(w=w, r=r, **kw) for _ in range(n)]


def H(pbs, at=-168.0):
    """Monthly PB records dated one week before t = 0."""
    return [{"slug": s, "e1rm": float(v), "at": at, "source": "logged"} for s, v in pbs.items()]


PUSH = [("bench_press_bb", S(90, 8, 4)), ("incline_bench_db", S(30, 10, 3)), ("ohp_db", S(22.5, 8, 3)),
        ("lateral_raise_db", S(10, 15, 3)), ("tri_pushdown_rope", S(30, 12, 3)), ("skullcrusher", S(30, 10, 3))]
PULL = [("deadlift", S(140, 5, 3)), ("barbell_row", S(70, 8, 4)), ("lat_pulldown", S(60, 10, 3)),
        ("face_pull", S(20, 15, 3)), ("bb_curl", S(30, 10, 3)), ("hammer_curl", S(14, 12, 3))]
LEGS = [("squat_bb", S(110, 6, 4)), ("rdl_bb", S(100, 8, 3)), ("leg_press", S(180, 12, 3)),
        ("leg_curl_lying", S(40, 12, 3)), ("calf_raise_standing", S(80, 15, 4))]
PBS = {"bench_press_bb": 120, "incline_bench_db": 40, "ohp_db": 30, "lateral_raise_db": 13,
       "tri_pushdown_rope": 40, "skullcrusher": 40, "deadlift": 180, "barbell_row": 95, "lat_pulldown": 80,
       "face_pull": 30, "bb_curl": 40, "hammer_curl": 20, "squat_bb": 140, "rdl_bb": 130, "leg_press": 260,
       "leg_curl_lying": 60, "calf_raise_standing": 130}

# Mon 18:00 = t 18. Push Mon, Pull Tue, Legs Wed, repeat Thu–Sat.
PPL_WEEK = [{"start": 18 + 24 * d - 1, "end": 18 + 24 * d, "exercises": ex}
            for d, ex in enumerate([PUSH, PULL, LEGS, PUSH, PULL, LEGS])]

FIXTURES = [
    # ---------- §3–§4 single sets ----------
    {"id": "F01", "kind": "exercise", "about": "Set inside the PB: 90 x 8 vs PB 120",
     "inputs": {"slug": "bench_press_bb", "sets": S(90, 8, 1), "history": H({"bench_press_bb": 120})},
     "expect": {"pb_source": "monthly", "refs": [120], "I": [0.75], "inol": [0.32], "L_e": 0.32}},
    {"id": "F02", "kind": "exercise", "about": "New PB mid-session updates the reference first; a single is capped at I = 0.95",
     "inputs": {"slug": "bench_press_bb", "sets": S(115, 3, 1) + S(125, 1, 1), "history": H({"bench_press_bb": 120})},
     "expect": {"refs": [126.5, 126.5], "I": [0.9091, 0.95], "inol": [0.33, 0.20], "records": [126.5, 125.0]}},
    {"id": "F03", "kind": "exercise", "about": "20 reps: scored, reps capped at 20 for e1RM and INOL",
     "inputs": {"slug": "bench_press_bb", "sets": S(60, 20, 1), "history": H({"bench_press_bb": 120})},
     "expect": {"I": [0.5], "inol": [0.40], "records": [100.0]}},
    {"id": "F04", "kind": "exercise", "about": "RPE 8 adds 2 reps in reserve to the e1RM",
     "inputs": {"slug": "bench_press_bb", "sets": [dict(w=100, r=5, rpe=8)], "history": H({"bench_press_bb": 120})},
     "expect": {"refs": [123.33], "I": [0.8108], "inol": [0.2643], "records": [123.33]}},
    {"id": "F05", "kind": "exercise", "about": "Pyramid with a warm-up and a PB triple",
     "inputs": {"slug": "bench_press_bb", "history": H({"bench_press_bb": 120}),
                "sets": [dict(w=60, r=12, warmup=True), dict(w=80, r=8), dict(w=100, r=5), dict(w=110, r=3), dict(w=90, r=8)]},
     "expect": {"refs": [120, 120, 120, 121.0, 121.0], "inol": [None, 0.24, 0.30, 0.33, 0.3123], "L_e": 1.1823}},
    {"id": "F06", "kind": "exercise", "about": "Rep scheme comparison: 8 x 3 at 90%",
     "inputs": {"slug": "bench_press_bb", "sets": S(108, 3, 8), "history": H({"bench_press_bb": 120})},
     "expect": {"I": [0.9] * 8, "L_e": 2.40}},
    {"id": "F07", "kind": "exercise", "about": "Warm-up excluded from load but still raises the reference",
     "inputs": {"slug": "bench_press_bb", "sets": [dict(w=100, r=6, warmup=True), dict(w=80, r=8)], "history": H({"bench_press_bb": 110})},
     "expect": {"refs": [120.0, 120.0], "inol": [None, 0.24], "L_e": 0.24}},

    # ---------- §3.2 load modes ----------
    {"id": "F08", "kind": "exercise", "about": "Pull-up: bodyweight 80 + 10 kg, PB e1RM 112",
     "inputs": {"slug": "pull_up", "sets": S(10, 5, 1), "history": H({"pull_up": 112}), "bodyweight": 80},
     "expect": {"w": [90.0], "I": [0.8036], "inol": [0.2545]}},
    {"id": "F09", "kind": "exercise", "about": "Assisted pull-up: 80 kg body, 30 kg assistance",
     "inputs": {"slug": "assisted_pull_up", "sets": S(30, 8, 1), "history": H({"assisted_pull_up": 70}), "bodyweight": 80},
     "expect": {"w": [50.0], "I": [0.7143], "inol": [0.28], "L_e": 0.224}},
    {"id": "F10", "kind": "exercise", "about": "Fixed mode: plank 3 x 60 s, no RPE",
     "inputs": {"slug": "plank", "sets": [dict(seconds=60)] * 3, "history": []},
     "expect": {"L_e": 0.90}},
    {"id": "F11", "kind": "exercise", "about": "Fixed mode with RPE 9",
     "inputs": {"slug": "plank", "sets": [dict(seconds=60, rpe=9)] * 3, "history": []},
     "expect": {"L_e": 1.05}},
    {"id": "F12", "kind": "exercise", "about": "Unilateral logged per side counts each side as half a set",
     "inputs": {"slug": "db_row", "sets": [dict(w=30, r=10, side="left"), dict(w=30, r=10, side="right")], "history": H({"db_row": 45})},
     "expect": {"inol": [0.15, 0.15], "L_e": 0.30}},

    # ---------- §3.3–§3.5 PB resolution ----------
    {"id": "F13", "kind": "pb", "about": "Lapsed: last session 60 days ago → best of that last month × 0.95",
     "inputs": {"slug": "bench_press_bb", "at": 60 * 24, "history": [
         {"slug": "bench_press_bb", "e1rm": 120.0, "at": 0, "source": "logged"},
         {"slug": "bench_press_bb", "e1rm": 110.0, "at": -20 * 24, "source": "logged"},
         {"slug": "bench_press_bb", "e1rm": 125.0, "at": -40 * 24, "source": "logged"}]},
     "expect": {"pb": 114.0, "source": "lapsed"}},
    {"id": "F14", "kind": "exercise", "about": "Estimated: incline DB from bench 120 × 0.32 × 0.9",
     "inputs": {"slug": "incline_bench_db", "sets": S(24, 10, 3), "history": H({"bench_press_bb": 120})},
     "expect": {"pb_source": "estimated", "pb_before": 34.56, "I": [0.6944] * 3, "L_e": 0.9818}},
    {"id": "F15", "kind": "pb", "about": "Estimated through three hops: db_curl → bb_curl → barbell_row → bench",
     "inputs": {"slug": "db_curl", "at": 0, "history": H({"bench_press_bb": 120})},
     "expect": {"pb": 18.59, "source": "estimated", "via": "bench_press_bb"}},
    {"id": "F16", "kind": "pb", "about": "Estimated from the nearest lift that has a PB",
     "inputs": {"slug": "db_curl", "at": 0, "history": H({"bench_press_bb": 120, "bb_curl": 45})},
     "expect": {"pb": 18.225, "source": "estimated", "via": "bb_curl"}},
    {"id": "F17", "kind": "exercise", "about": "Calibration: no history, no estimate link → reference from the session, 2 RIR assumed",
     "inputs": {"slug": "landmine_press", "sets": S(30, 10, 3), "history": []},
     "expect": {"pb_source": "calibration", "refs": [42.0] * 3, "I": [0.7143] * 3, "L_e": 1.05, "records": [40.0] * 3}},
    {"id": "F18", "kind": "manual_timeline", "about": "Manual PB 130 on day 0; logged 132 on day 10 overwrites it; manual expires after 30 days",
     "inputs": {"slug": "bench_press_bb", "manual": {"e1rm": 130.0, "day": 0},
                "sessions": [{"day": 1, "sets": S(100, 5, 3)}, {"day": 3, "sets": S(100, 5, 3)},
                             {"day": 10, "sets": S(120, 3, 1)}, {"day": 35, "sets": S(100, 5, 1)}]},
     "expect": {"pb_before": [130.0, 130.0, 130.0, 132.0], "pb_kind": ["manual", "manual", "manual", "logged"],
                "first_set_I": [0.7692, 0.7692, 0.9091, 0.7576]}},
    {"id": "F19", "kind": "manual_timeline", "about": "Manual PB never beaten: logged data takes over on day 31",
     "inputs": {"slug": "bench_press_bb", "manual": {"e1rm": 130.0, "day": 0},
                "sessions": [{"day": 1, "sets": S(100, 5, 3)}, {"day": 15, "sets": S(100, 5, 3)},
                             {"day": 29, "sets": S(100, 5, 3)}, {"day": 31, "sets": S(100, 5, 1)}]},
     "expect": {"pb_before": [130.0, 130.0, 130.0, 116.67]}},

    # ---------- §5–§7 one workout ----------
    {"id": "F20", "kind": "workout", "about": "Push day (session view)",
     "inputs": {"exercises": PUSH, "history": H(PBS)},
     "expect": {
         "L_e": {"bench_press_bb": 1.28, "incline_bench_db": 1.20, "ohp_db": 0.96, "lateral_raise_db": 1.35,
                 "tri_pushdown_rope": 1.008, "skullcrusher": 1.20},
         "L_m": {"chest": 2.48, "triceps": 3.584, "front_delts": 1.952, "side_delts": 1.734, "traps": 0.462},
         "level": {"chest": 3, "triceps": 4, "front_delts": 3, "side_delts": 3, "traps": 1, "lats": 0},
         "R": {"chest": 59.71, "triceps": 75.61, "front_delts": 52.11, "side_delts": 24.48, "traps": 30.65},
         "ready_in_h": {"chest": 53.69, "triceps": 70.34, "side_delts": 20.95},
         "trainable_in_h": {"chest": 23.59, "triceps": 43.97, "front_delts": 12.07}}},
    {"id": "F21", "kind": "workout", "about": "One set of curls: biceps Low, forearms below the visible threshold",
     "inputs": {"exercises": [("bb_curl", S(30, 10, 1))], "history": H({"bb_curl": 40})},
     "expect": {"L_m": {"biceps": 0.40, "forearms": 0.16}, "level": {"biceps": 1, "forearms": 0},
                "R": {"biceps": 29.76}, "ready_in_h": {"biceps": 11.16}}},
    {"id": "F22", "kind": "workout", "about": "Exercise with no muscle mapping contributes nothing and does not throw",
     "inputs": {"extra_exercises": [{"slug": "__unmapped__", "load_mode": "weight", "fatigue": "standard",
                                     "primary": [], "secondary": [], "tertiary": [], "pb_estimate": None}],
                "exercises": [("__unmapped__", S(50, 10, 3))], "history": H({"__unmapped__": 80})},
     "expect": {"L_m_all_zero": True}},

    # ---------- §8–§9 over time ----------
    {"id": "F23", "kind": "timeline", "about": "Push day decay, chest",
     "inputs": {"workouts": [{"start": -1, "end": 0, "exercises": PUSH}], "history": H(PBS), "muscles": ["chest"],
                "at": [0, 12, 24, 36, 48, 54]},
     "expect": {"chest": {"F": [2.48, 1.982, 1.483, 0.985, 0.486, 0.237], "level": [3, 3, 2, 2, 1, 0]}}},
    {"id": "F24", "kind": "timeline", "about": "Stacking: push day repeated 24 h later",
     "inputs": {"workouts": [{"start": -1, "end": 0, "exercises": PUSH}, {"start": 23, "end": 24, "exercises": PUSH}],
                "history": H(PBS), "muscles": ["chest", "triceps"], "at": [24]},
     "expect": {"chest": {"F": [3.963], "level": [4], "ready_in_h": [53.75]},
                "triceps": {"F": [6.03], "level": [5], "trainable_in_h": [48.0]}}},
    {"id": "F25", "kind": "timeline", "about": "Weekly cap: chest pushed four times in six days stays red until the first session leaves the week",
     "inputs": {"workouts": [{"start": t - 1, "end": t, "exercises": PUSH} for t in (0, 48, 96, 144)],
                "history": H(PBS), "muscles": ["chest"], "at": [150, 160, 168.25]},
     "expect": {"chest": {"F": [2.468, 1.815, 1.473], "W": [9.92, 9.92, 7.44], "level": [4, 4, 2]}}},
    {"id": "F26", "kind": "timeline", "about": "PPL x2 week: Wednesday 20:00, two hours after legs (the preview image)",
     "inputs": {"workouts": PPL_WEEK[:3], "history": H(PBS), "at": [68],
                "muscles": ["chest", "traps", "lats", "lower_back", "front_delts", "side_delts", "rear_delts", "biceps",
                            "triceps", "forearms", "abs", "obliques", "glutes", "quads", "adductors", "hamstrings", "calves"]},
     "expect": {"chest": {"level": [1]}, "traps": {"level": [3]}, "lats": {"level": [2]}, "lower_back": {"level": [2]},
                "front_delts": {"level": [0]}, "side_delts": {"level": [0]}, "rear_delts": {"level": [2]},
                "biceps": {"level": [3], "F": [2.07]}, "triceps": {"level": [2]}, "forearms": {"level": [0]},
                "abs": {"level": [0]}, "obliques": {"level": [0]}, "glutes": {"level": [3]}, "quads": {"level": [3], "F": [2.43]},
                "adductors": {"level": [2]}, "hamstrings": {"level": [4], "F": [2.56]}, "calves": {"level": [2]}}},
    {"id": "F27", "kind": "timeline", "about": "PPL x2 week: Saturday 20:00, weekly load stays under the cap",
     "inputs": {"workouts": PPL_WEEK, "history": H(PBS), "at": [140], "muscles": ["triceps", "biceps", "traps"]},
     "expect": {"triceps": {"W": [7.17]}, "biceps": {"W": [6.54]}, "traps": {"W": [6.14]}}},

    # ---------- added after review ----------
    {"id": "F28", "kind": "workout", "about": "Same exercise in two blocks of one workout keeps one running reference",
     "inputs": {"exercises": [("bench_press_bb", S(110, 3, 1)), ("ohp_bb", S(50, 8, 1)), ("bench_press_bb", S(100, 5, 1))],
                "history": H({"bench_press_bb": 100, "ohp_bb": 70})},
     "expect": {"L_e": {"bench_press_bb": 0.6181}, "set_refs": {"bench_press_bb": [121.0, 121.0]}}},
    {"id": "F29", "kind": "manual_timeline", "about": "Manual policy replace_on_log: any later logged set retires the manual entry",
     "inputs": {"slug": "bench_press_bb", "manual": {"e1rm": 130.0, "day": 0},
                "constants_override": {"pb.manual_policy": "replace_on_log"},
                "sessions": [{"day": 1, "sets": S(100, 5, 3)}, {"day": 3, "sets": S(100, 5, 3)},
                             {"day": 10, "sets": S(120, 3, 1)}, {"day": 35, "sets": S(100, 5, 1)}]},
     "expect": {"pb_before": [130.0, 116.67, 116.67, 132.0], "pb_kind": ["manual", "logged", "logged", "logged"]}},
    {"id": "F30", "kind": "pb", "about": "Custom exercise based on a library curl: the fourth hop reaches bench",
     "inputs": {"slug": "custom_drag_curl", "at": 0, "history": H({"bench_press_bb": 120}),
                "extra_exercises": [{"slug": "custom_drag_curl", "load_mode": "weight", "fatigue": "standard",
                                     "primary": ["biceps"], "secondary": [], "tertiary": [],
                                     "pb_estimate": {"from": "db_curl", "ratio": 1.0}}]},
     "expect": {"pb": 18.59, "source": "estimated", "via": "bench_press_bb"}},
    {"id": "F31", "kind": "exercise", "about": "Bodyweight snapshot on the set wins over the current profile weight",
     "inputs": {"slug": "pull_up", "sets": [dict(w=10, r=5, bodyweight=78)], "history": H({"pull_up": 112}), "bodyweight": 82},
     "expect": {"w": [88.0], "I": [0.7857], "inol": [0.2333]}},
]


# ---------------- evaluator ----------------
def close(a, b):
    return abs(a - b) <= TOL


def run(fx):
    k, i, e = fx["kind"], fx["inputs"], fx["expect"]
    errs = []
    for ex in i.get("extra_exercises", []):
        M.EX[ex["slug"]] = ex
    saved = {}
    for key, val in i.get("constants_override", {}).items():
        sect, name = key.split(".")
        saved[key] = M.C[sect][name]
        M.C[sect][name] = val
    try:
        return _run(k, i, e, errs)
    finally:
        for key, val in saved.items():
            sect, name = key.split(".")
            M.C[sect][name] = val


def _run(k, i, e, errs):

    def cmp(name, got, want):
        if want is None:
            return
        if isinstance(want, bool):
            ok = got == want
        elif isinstance(want, (int, float)) and not isinstance(want, bool):
            ok = got is not None and close(got, want)
        else:
            ok = got == want
        if not ok:
            errs.append(f"{name}: got {got}, want {want}")

    if k == "exercise":
        r = M.score_exercise(i["slug"], i["sets"], i.get("start", 0), list(i["history"]), i.get("bodyweight", 75))
        cmp("pb_source", r["pb_source"], e.get("pb_source"))
        cmp("pb_before", r["pb_before"], e.get("pb_before"))
        cmp("L_e", r["L_e"], e.get("L_e"))
        for key, src in (("refs", "ref"), ("I", "I"), ("inol", "inol"), ("w", "w")):
            for n, want in enumerate(e.get(key, [])):
                cmp(f"{key}[{n}]", r["sets"][n].get(src), want)
        for n, want in enumerate(e.get("records", [])):
            cmp(f"records[{n}]", r["records"][n]["e1rm"], want)
    elif k == "pb":
        pb, src, via = M.pb_before(i["slug"], i["at"], i["history"])
        cmp("pb", pb, e["pb"])
        cmp("source", src, e["source"])
        cmp("via", via, e.get("via"))
    elif k == "manual_timeline":
        hist = [{"slug": i["slug"], "e1rm": i["manual"]["e1rm"], "at": i["manual"]["day"] * 24, "source": "manual"}]
        for n, sess in enumerate(i["sessions"]):
            t = sess["day"] * 24
            pb0, _, kind = M.pb_before(i["slug"], t, hist)
            cmp(f"pb_before[{n}]", pb0, e["pb_before"][n])
            if "pb_kind" in e:
                cmp(f"pb_kind[{n}]", kind, e["pb_kind"][n])
            sc = M.score_workout({"start": t, "end": t + 1, "exercises": [(i["slug"], sess["sets"])]}, hist)
            if "first_set_I" in e:
                cmp(f"first_set_I[{n}]", sc["detail"][i["slug"]]["sets"][0]["I"], e["first_set_I"][n])
    elif k == "workout":
        sc = M.score_workout({"start": -1, "end": 0, "exercises": i["exercises"]}, list(i["history"]))
        if e.get("L_m_all_zero"):
            cmp("L_m all zero", all(v == 0 for v in sc["L_m"].values()), True)
        sm = M.session_map(sc)
        for slug, want in e.get("L_e", {}).items():
            cmp(f"L_e.{slug}", sc["L_e"][slug], want)
        for m, want in e.get("L_m", {}).items():
            cmp(f"L_m.{m}", sc["L_m"][m], want)
        for m, want in e.get("level", {}).items():
            cmp(f"level.{m}", sm[m]["level"], want)
        for m, want in e.get("R", {}).items():
            cmp(f"R.{m}", sc["R"][m], want)
        for m, want in e.get("ready_in_h", {}).items():
            cmp(f"ready_in_h.{m}", sm[m]["ready_in_h"], want)
        for m, want in e.get("trainable_in_h", {}).items():
            cmp(f"trainable_in_h.{m}", sm[m]["trainable_in_h"], want)
        for slug, refs in e.get("set_refs", {}).items():
            for n, want in enumerate(refs):
                cmp(f"set_refs.{slug}[{n}]", sc["detail"][slug]["sets"][n]["ref"], want)
    elif k == "timeline":
        hist = list(i["history"])
        scored = [M.score_workout(w, hist) for w in i["workouts"]]
        for m in i["muscles"]:
            terms = M.terms_for(scored, m)
            for n, t in enumerate(i["at"]):
                st = M.muscle_state(terms, t)
                for key in ("F", "W", "level", "ready_in_h", "trainable_in_h"):
                    want = e.get(m, {}).get(key)
                    if want is not None:
                        cmp(f"{m}.{key}@{t}", st[key], want[n])
    return errs


def main():
    fails = 0
    for fx in FIXTURES:
        errs = run(fx)
        print(("ok   " if not errs else "FAIL ") + fx["id"] + "  " + fx["about"])
        for err in errs:
            print("       " + err)
        fails += bool(errs)

    lib = M.LIB
    checks = [
        ("library: 161 exercises, 17 muscles", len(lib["exercises"]) == 161 and len(lib["muscles"]) == 17),
        ("library: every muscle is a primary somewhere",
         all(any(m["id"] in e["primary"] for e in lib["exercises"]) for m in lib["muscles"])),
        ("library: every load split sums to 100", all(sum(e["load_split"].values()) == 100 for e in lib["exercises"])),
    ]
    for name, ok in checks:
        print(("ok   " if ok else "FAIL ") + name)
        fails += not ok

    out = Path(__file__).resolve().parent.parent / "data" / "load_model_fixtures.json"
    text = json.dumps({"tolerance": TOL, "time_unit": "hours", "default_bodyweight_kg": 75,
                       "fixtures": FIXTURES}, indent=1)
    if "--write" in sys.argv:
        out.write_text(text, encoding="utf-8")
        print(f"\n{len(FIXTURES)} fixtures written to data/load_model_fixtures.json")
    elif not out.exists() or out.read_text(encoding="utf-8") != text:
        print("\nFAIL data/load_model_fixtures.json is out of date: run with --write")
        fails += 1
    else:
        print(f"\n{len(FIXTURES)} fixtures; data/load_model_fixtures.json is up to date")
    if fails:
        print(f"{fails} FAILED")
        raise SystemExit(1)
    print("all pass")


if __name__ == "__main__":
    main()
