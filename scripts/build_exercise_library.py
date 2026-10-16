#!/usr/bin/env python3
"""Single source of truth for the Splitset exercise library.

Generates:
  docs/exercise-library.md
  data/exercise_library.csv
  data/exercise_library.json

Run from the repo root:  python3 scripts/build_exercise_library.py
Edit this file, never the generated ones.
"""
import csv
import json
from pathlib import Path

CONSTANTS = json.loads((Path(__file__).resolve().parent.parent / "data" / "recovery_constants.json").read_text())
_BASE = CONSTANTS["base_recovery_hours"]

# id: (group, display name, figure views, base recovery hours — display only; the engine reads constants)
MUSCLES = {
    "chest":       ("Chest",     "Chest",              ["front"]),
    "traps":       ("Back",      "Traps & upper back", ["front", "back"]),
    "lats":        ("Back",      "Lats",               ["back"]),
    "lower_back":  ("Back",      "Lower back",         ["back"]),
    "front_delts": ("Shoulders", "Front delts",        ["front"]),
    "side_delts":  ("Shoulders", "Side delts",         ["front", "back"]),
    "rear_delts":  ("Shoulders", "Rear delts",         ["back"]),
    "biceps":      ("Arms",      "Biceps",             ["front"]),
    "triceps":     ("Arms",      "Triceps",            ["back"]),
    "forearms":    ("Arms",      "Forearms",           ["front", "back"]),
    "abs":         ("Core",      "Abs",                ["front"]),
    "obliques":    ("Core",      "Obliques",           ["front"]),
    "glutes":      ("Legs",      "Glutes",             ["back"]),
    "quads":       ("Legs",      "Quads",              ["front"]),
    "adductors":   ("Legs",      "Adductors",          ["front", "back"]),
    "hamstrings":  ("Legs",      "Hamstrings",         ["back"]),
    "calves":      ("Legs",      "Calves",             ["front", "back"]),
}

ROLE_WEIGHTS = CONSTANTS["role_weights"]
ROLE_CAPS = CONSTANTS["role_caps"]
FATIGUE = CONSTANTS["fatigue_factors"]


def base_hours(mid):
    return _BASE.get(mid, _BASE["default"])
LOW_FATIGUE_EQUIPMENT = {"machine", "cable", "band"}
GROUPS = ["Chest", "Back", "Shoulders", "Arms", "Legs", "Core", "Full body"]

E = []


def ex(slug, name, group, equipment, primary, secondary=(), tertiary=(),
       mode="weight", bw=None, uni=False, fatigue=None, est=None, log_as=None, note=""):
    """mode: weight | bodyweight | assisted | fixed
       est:  (slug_of_related_exercise, ratio) used to estimate a starting PB
       log_as: for fixed mode, 'seconds' or 'reps'"""
    if fatigue is None:
        fatigue = "low" if equipment in LOW_FATIGUE_EQUIPMENT else "standard"
    E.append(dict(
        slug=slug, name=name, group=group, equipment=equipment,
        load_mode=mode, bw_factor=bw, unilateral=uni,
        log_as=log_as if mode == "fixed" else ("reps"),
        fatigue=fatigue,
        primary=list(primary), secondary=list(secondary), tertiary=list(tertiary),
        pb_estimate=None if est is None else {"from": est[0], "ratio": est[1]},
        note=note,
    ))


BENCH, SQUAT, DEAD, OHP, ROW, PULLDOWN, CURL = (
    "bench_press_bb", "squat_bb", "deadlift", "ohp_bb", "barbell_row", "lat_pulldown", "bb_curl")

# ---------------- Chest ----------------
ex(BENCH, "Bench press (barbell)", "Chest", "barbell", ["chest"], ["triceps", "front_delts"])
ex("bench_press_db", "Bench press (dumbbell)", "Chest", "dumbbell", ["chest"], ["front_delts", "triceps"], est=(BENCH, 0.38), note="weight per hand")
ex("incline_bench_bb", "Incline bench press (barbell)", "Chest", "barbell", ["chest"], ["front_delts", "triceps"], est=(BENCH, 0.80))
ex("incline_bench_db", "Incline bench press (dumbbell)", "Chest", "dumbbell", ["chest"], ["front_delts", "triceps"], est=(BENCH, 0.32), note="weight per hand")
ex("decline_bench_bb", "Decline bench press (barbell)", "Chest", "barbell", ["chest"], ["triceps"], ["front_delts"], est=(BENCH, 1.00))
ex("floor_press_bb", "Floor press (barbell)", "Chest", "barbell", ["chest"], ["triceps"], ["front_delts"], est=(BENCH, 0.90))
ex("smith_bench", "Bench press (Smith machine)", "Chest", "smith", ["chest"], ["triceps", "front_delts"], est=(BENCH, 0.95))
ex("smith_incline_bench", "Incline bench press (Smith machine)", "Chest", "smith", ["chest"], ["front_delts", "triceps"], est=(BENCH, 0.78))
ex("chest_press_machine", "Chest press (machine)", "Chest", "machine", ["chest"], ["triceps"], ["front_delts"])
ex("incline_chest_press_machine", "Incline chest press (machine)", "Chest", "machine", ["chest"], ["front_delts"], ["triceps"])
ex("push_up", "Push-up", "Chest", "bodyweight", ["chest"], ["triceps"], ["front_delts", "abs"], mode="bodyweight", bw=0.64)
ex("incline_push_up", "Incline push-up", "Chest", "bodyweight", ["chest"], ["triceps"], ["front_delts"], mode="bodyweight", bw=0.45)
ex("decline_push_up", "Decline push-up", "Chest", "bodyweight", ["chest"], ["front_delts", "triceps"], ["abs"], mode="bodyweight", bw=0.70)
ex("dip_chest", "Chest dip", "Chest", "bodyweight", ["chest"], ["triceps", "front_delts"], mode="bodyweight", bw=1.0)
ex("cable_fly", "Cable fly (mid)", "Chest", "cable", ["chest"], [], ["front_delts"])
ex("cable_fly_low_high", "Cable fly (low to high)", "Chest", "cable", ["chest"], ["front_delts"])
ex("cable_fly_high_low", "Cable fly (high to low)", "Chest", "cable", ["chest"], [], ["front_delts"])
ex("db_fly", "Fly (dumbbell)", "Chest", "dumbbell", ["chest"], [], ["front_delts"], est=(BENCH, 0.18), note="weight per hand")
ex("incline_db_fly", "Incline fly (dumbbell)", "Chest", "dumbbell", ["chest"], [], ["front_delts"], est=(BENCH, 0.16), note="weight per hand")
ex("pec_deck", "Pec deck", "Chest", "machine", ["chest"], [], ["front_delts"])

# ---------------- Back ----------------
ex(DEAD, "Deadlift (conventional)", "Back", "barbell", ["glutes", "lower_back"], ["hamstrings", "traps"], ["adductors", "quads", "forearms"], fatigue="high", est=(SQUAT, 1.20))
ex("sumo_deadlift", "Sumo deadlift", "Back", "barbell", ["glutes", "adductors"], ["quads", "lower_back"], ["hamstrings", "traps", "forearms"], fatigue="high", est=(DEAD, 1.00))
ex("trap_bar_deadlift", "Trap bar deadlift", "Back", "trap bar", ["quads", "glutes"], ["lower_back", "hamstrings"], ["traps", "forearms", "adductors"], fatigue="high", est=(DEAD, 1.05))
ex("deficit_deadlift", "Deficit deadlift", "Back", "barbell", ["glutes", "lower_back"], ["hamstrings", "quads"], ["adductors", "traps", "forearms"], fatigue="high", est=(DEAD, 0.90))
ex("rack_pull", "Rack pull", "Back", "barbell", ["lower_back", "traps"], ["glutes"], ["hamstrings", "forearms", "lats"], fatigue="high", est=(DEAD, 1.15))
ex(ROW, "Bent-over row (barbell)", "Back", "barbell", ["lats", "traps"], ["biceps", "rear_delts"], ["lower_back", "forearms"], est=(BENCH, 0.85))
ex("pendlay_row", "Pendlay row", "Back", "barbell", ["lats", "traps"], ["biceps", "rear_delts"], ["lower_back", "forearms"], est=(ROW, 0.95))
ex("seal_row", "Seal row", "Back", "barbell", ["lats", "traps"], ["rear_delts", "biceps"], est=(ROW, 0.80))
ex("db_row", "Single-arm row (dumbbell)", "Back", "dumbbell", ["lats"], ["traps", "biceps"], ["rear_delts", "forearms"], uni=True, est=(ROW, 0.50))
ex("chest_supported_row_db", "Chest-supported row (dumbbell)", "Back", "dumbbell", ["traps", "lats"], ["rear_delts", "biceps"], est=(ROW, 0.35), note="weight per hand")
ex("t_bar_row", "T-bar row", "Back", "barbell", ["lats", "traps"], ["biceps", "rear_delts"], ["lower_back", "forearms"], est=(ROW, 0.90))
ex("seated_cable_row", "Seated cable row", "Back", "cable", ["lats", "traps"], ["biceps", "rear_delts"], ["forearms"])
ex("machine_row", "Row (machine)", "Back", "machine", ["lats", "traps"], ["biceps", "rear_delts"])
ex("inverted_row", "Inverted row", "Back", "bodyweight", ["lats", "traps"], ["biceps", "rear_delts"], ["abs"], mode="bodyweight", bw=0.5)
ex("pull_up", "Pull-up", "Back", "bodyweight", ["lats"], ["biceps", "traps"], ["rear_delts", "forearms"], mode="bodyweight", bw=1.0)
ex("chin_up", "Chin-up", "Back", "bodyweight", ["lats", "biceps"], ["traps"], ["rear_delts", "forearms"], mode="bodyweight", bw=1.0)
ex("neutral_grip_pull_up", "Neutral-grip pull-up", "Back", "bodyweight", ["lats"], ["biceps", "traps"], ["forearms", "rear_delts"], mode="bodyweight", bw=1.0)
ex("assisted_pull_up", "Assisted pull-up (machine)", "Back", "machine", ["lats"], ["biceps", "traps"], ["rear_delts"], mode="assisted", bw=1.0, note="log the assistance weight")
ex(PULLDOWN, "Lat pulldown (wide grip)", "Back", "cable", ["lats"], ["biceps", "traps"], ["rear_delts"])
ex("close_grip_pulldown", "Lat pulldown (close grip)", "Back", "cable", ["lats"], ["biceps"], ["traps"], est=(PULLDOWN, 1.00))
ex("single_arm_pulldown", "Single-arm pulldown (cable)", "Back", "cable", ["lats"], ["biceps"], uni=True, est=(PULLDOWN, 0.45))
ex("straight_arm_pulldown", "Straight-arm pulldown", "Back", "cable", ["lats"], [], ["triceps", "rear_delts"], est=(PULLDOWN, 0.40))
ex("db_pullover", "Pullover (dumbbell)", "Back", "dumbbell", ["lats"], ["chest"], ["triceps"], est=(BENCH, 0.30))
ex("shrug_bb", "Shrug (barbell)", "Back", "barbell", ["traps"], [], ["forearms"], est=(DEAD, 0.80))
ex("shrug_db", "Shrug (dumbbell)", "Back", "dumbbell", ["traps"], [], ["forearms"], est=(DEAD, 0.35), note="weight per hand")
ex("back_extension", "Back extension", "Back", "bodyweight", ["lower_back"], ["glutes", "hamstrings"], mode="bodyweight", bw=0.5, note="add held plate as added load")
ex("good_morning", "Good morning", "Back", "barbell", ["hamstrings", "lower_back"], ["glutes"], ["adductors"], fatigue="high", est=(SQUAT, 0.45))
ex("reverse_hyper", "Reverse hyperextension", "Back", "machine", ["lower_back", "glutes"], ["hamstrings"])

# ---------------- Shoulders ----------------
ex(OHP, "Overhead press (barbell)", "Shoulders", "barbell", ["front_delts"], ["side_delts", "triceps"], ["traps", "abs"], est=(BENCH, 0.62))
ex("ohp_seated_bb", "Seated overhead press (barbell)", "Shoulders", "barbell", ["front_delts"], ["side_delts", "triceps"], ["traps"], est=(OHP, 0.95))
ex("ohp_db", "Shoulder press (dumbbell)", "Shoulders", "dumbbell", ["front_delts"], ["side_delts", "triceps"], ["traps"], est=(OHP, 0.40), note="weight per hand")
ex("arnold_press", "Arnold press", "Shoulders", "dumbbell", ["front_delts"], ["side_delts", "triceps"], est=(OHP, 0.36), note="weight per hand")
ex("smith_ohp", "Overhead press (Smith machine)", "Shoulders", "smith", ["front_delts"], ["side_delts", "triceps"], est=(OHP, 1.00))
ex("shoulder_press_machine", "Shoulder press (machine)", "Shoulders", "machine", ["front_delts"], ["side_delts", "triceps"])
ex("push_press", "Push press", "Shoulders", "barbell", ["front_delts"], ["triceps", "side_delts"], ["quads", "glutes", "traps"], est=(OHP, 1.25))
ex("landmine_press", "Landmine press", "Shoulders", "barbell", ["front_delts"], ["chest", "triceps"], ["obliques"], uni=True)
ex("lateral_raise_db", "Lateral raise (dumbbell)", "Shoulders", "dumbbell", ["side_delts"], [], ["traps"], est=(OHP, 0.17), note="weight per hand")
ex("lateral_raise_cable", "Lateral raise (cable)", "Shoulders", "cable", ["side_delts"], uni=True)
ex("lateral_raise_machine", "Lateral raise (machine)", "Shoulders", "machine", ["side_delts"])
ex("front_raise_db", "Front raise (dumbbell)", "Shoulders", "dumbbell", ["front_delts"], [], ["side_delts"], est=(OHP, 0.20), note="weight per hand")
ex("front_raise_cable", "Front raise (cable)", "Shoulders", "cable", ["front_delts"], [], ["side_delts"])
ex("rear_delt_fly_db", "Rear delt fly (dumbbell)", "Shoulders", "dumbbell", ["rear_delts"], ["traps"], est=(OHP, 0.12), note="weight per hand")
ex("reverse_pec_deck", "Reverse pec deck", "Shoulders", "machine", ["rear_delts"], ["traps"])
ex("rear_delt_cable_fly", "Rear delt fly (cable)", "Shoulders", "cable", ["rear_delts"], [], ["traps"])
ex("face_pull", "Face pull", "Shoulders", "cable", ["rear_delts"], ["traps"], ["side_delts"])
ex("upright_row_bb", "Upright row (barbell)", "Shoulders", "barbell", ["side_delts", "traps"], [], ["front_delts", "biceps"], est=(OHP, 0.75))
ex("upright_row_cable", "Upright row (cable)", "Shoulders", "cable", ["side_delts", "traps"], [], ["front_delts", "biceps"])
ex("band_pull_apart", "Band pull-apart", "Shoulders", "band", ["rear_delts"], ["traps"], mode="fixed", log_as="reps")

# ---------------- Arms ----------------
ex(CURL, "Curl (barbell)", "Arms", "barbell", ["biceps"], ["forearms"], est=(ROW, 0.45))
ex("ez_curl", "Curl (EZ bar)", "Arms", "ez bar", ["biceps"], ["forearms"], est=(CURL, 0.95))
ex("db_curl", "Curl (dumbbell)", "Arms", "dumbbell", ["biceps"], [], ["forearms"], est=(CURL, 0.45), note="weight per hand")
ex("hammer_curl", "Hammer curl (dumbbell)", "Arms", "dumbbell", ["biceps"], ["forearms"], est=(CURL, 0.50), note="weight per hand")
ex("incline_db_curl", "Incline curl (dumbbell)", "Arms", "dumbbell", ["biceps"], est=(CURL, 0.38), note="weight per hand")
ex("preacher_curl_ez", "Preacher curl (EZ bar)", "Arms", "ez bar", ["biceps"], [], ["forearms"], est=(CURL, 0.80))
ex("preacher_curl_machine", "Preacher curl (machine)", "Arms", "machine", ["biceps"])
ex("concentration_curl", "Concentration curl", "Arms", "dumbbell", ["biceps"], uni=True, est=(CURL, 0.40))
ex("spider_curl", "Spider curl (dumbbell)", "Arms", "dumbbell", ["biceps"], est=(CURL, 0.40), note="weight per hand")
ex("cable_curl", "Curl (cable)", "Arms", "cable", ["biceps"], [], ["forearms"])
ex("bayesian_curl", "Bayesian curl (cable)", "Arms", "cable", ["biceps"], uni=True)
ex("reverse_curl", "Reverse curl (EZ bar)", "Arms", "ez bar", ["forearms"], ["biceps"], est=(CURL, 0.65))
ex("close_grip_bench", "Close-grip bench press", "Arms", "barbell", ["triceps"], ["chest", "front_delts"], est=(BENCH, 0.88))
ex("dip_triceps", "Triceps dip", "Arms", "bodyweight", ["triceps"], ["chest", "front_delts"], mode="bodyweight", bw=1.0)
ex("assisted_dip", "Assisted dip (machine)", "Arms", "machine", ["triceps"], ["chest", "front_delts"], mode="assisted", bw=1.0, note="log the assistance weight")
ex("bench_dip", "Bench dip", "Arms", "bodyweight", ["triceps"], [], ["front_delts", "chest"], mode="bodyweight", bw=0.6)
ex("diamond_push_up", "Diamond push-up", "Arms", "bodyweight", ["triceps"], ["chest"], ["front_delts"], mode="bodyweight", bw=0.64)
ex("skullcrusher", "Skullcrusher (EZ bar)", "Arms", "ez bar", ["triceps"], est=(BENCH, 0.40))
ex("overhead_tri_ext_db", "Overhead triceps extension (dumbbell)", "Arms", "dumbbell", ["triceps"], est=(BENCH, 0.30), note="one dumbbell, both hands")
ex("overhead_tri_ext_cable", "Overhead triceps extension (cable)", "Arms", "cable", ["triceps"])
ex("tri_pushdown_rope", "Triceps pushdown (rope)", "Arms", "cable", ["triceps"])
ex("tri_pushdown_bar", "Triceps pushdown (bar)", "Arms", "cable", ["triceps"])
ex("tri_kickback", "Triceps kickback (dumbbell)", "Arms", "dumbbell", ["triceps"], uni=True, est=(BENCH, 0.10))
ex("jm_press", "JM press", "Arms", "barbell", ["triceps"], ["chest"], est=(BENCH, 0.65))
ex("wrist_curl", "Wrist curl", "Arms", "barbell", ["forearms"])
ex("reverse_wrist_curl", "Reverse wrist curl", "Arms", "barbell", ["forearms"])
ex("dead_hang", "Dead hang", "Arms", "bodyweight", ["forearms"], [], ["lats"], mode="fixed", log_as="seconds")

# ---------------- Legs ----------------
ex(SQUAT, "Back squat (barbell)", "Legs", "barbell", ["quads"], ["glutes", "adductors"], ["lower_back", "hamstrings", "abs"], fatigue="high")
ex("front_squat", "Front squat", "Legs", "barbell", ["quads"], ["glutes", "adductors"], ["abs", "lower_back", "traps"], fatigue="high", est=(SQUAT, 0.82))
ex("pause_squat", "Pause squat", "Legs", "barbell", ["quads"], ["glutes", "adductors"], ["lower_back", "abs"], fatigue="high", est=(SQUAT, 0.85))
ex("box_squat", "Box squat", "Legs", "barbell", ["quads", "glutes"], ["adductors", "hamstrings"], ["lower_back"], fatigue="high", est=(SQUAT, 0.95))
ex("smith_squat", "Squat (Smith machine)", "Legs", "smith", ["quads"], ["glutes"], ["adductors", "hamstrings"], est=(SQUAT, 0.95))
ex("goblet_squat", "Goblet squat", "Legs", "dumbbell", ["quads"], ["glutes", "adductors"], ["abs"], est=(SQUAT, 0.35))
ex("hack_squat", "Hack squat (machine)", "Legs", "machine", ["quads"], ["glutes"], ["adductors"], fatigue="standard")
ex("pendulum_squat", "Pendulum squat (machine)", "Legs", "machine", ["quads"], ["glutes"], ["adductors"], fatigue="standard")
ex("belt_squat", "Belt squat (machine)", "Legs", "machine", ["quads", "glutes"], ["adductors"], fatigue="standard")
ex("leg_press", "Leg press", "Legs", "machine", ["quads"], ["glutes"], ["adductors", "hamstrings"], fatigue="standard")
ex("single_leg_press", "Single-leg press", "Legs", "machine", ["quads"], ["glutes"], ["adductors"], uni=True, fatigue="standard")
ex("bulgarian_split_squat", "Bulgarian split squat", "Legs", "dumbbell", ["quads", "glutes"], ["adductors"], ["hamstrings"], uni=True, fatigue="high", est=(SQUAT, 0.25), note="weight per hand")
ex("split_squat", "Split squat", "Legs", "dumbbell", ["quads", "glutes"], ["adductors"], ["hamstrings"], uni=True, fatigue="high", est=(SQUAT, 0.30), note="weight per hand")
ex("walking_lunge", "Walking lunge", "Legs", "dumbbell", ["quads", "glutes"], ["adductors"], ["hamstrings", "calves"], uni=True, fatigue="high", est=(SQUAT, 0.28), note="weight per hand")
ex("reverse_lunge", "Reverse lunge", "Legs", "dumbbell", ["glutes", "quads"], ["adductors"], ["hamstrings"], uni=True, fatigue="high", est=(SQUAT, 0.28), note="weight per hand")
ex("step_up", "Step-up", "Legs", "dumbbell", ["quads", "glutes"], [], ["hamstrings", "adductors"], uni=True, est=(SQUAT, 0.25), note="weight per hand")
ex("leg_extension", "Leg extension", "Legs", "machine", ["quads"])
ex("sissy_squat", "Sissy squat", "Legs", "bodyweight", ["quads"], mode="bodyweight", bw=0.7)
ex("bodyweight_squat", "Bodyweight squat", "Legs", "bodyweight", ["quads"], ["glutes"], ["adductors"], mode="bodyweight", bw=0.8)
ex("pistol_squat", "Pistol squat", "Legs", "bodyweight", ["quads", "glutes"], ["adductors"], ["abs"], mode="bodyweight", bw=0.85, uni=True)
ex("wall_sit", "Wall sit", "Legs", "bodyweight", ["quads"], [], ["glutes"], mode="fixed", log_as="seconds")
ex("rdl_bb", "Romanian deadlift (barbell)", "Legs", "barbell", ["hamstrings", "glutes"], ["lower_back", "adductors"], ["forearms", "traps"], fatigue="high", est=(DEAD, 0.70))
ex("rdl_db", "Romanian deadlift (dumbbell)", "Legs", "dumbbell", ["hamstrings", "glutes"], ["lower_back", "adductors"], ["forearms"], fatigue="high", est=(DEAD, 0.30), note="weight per hand")
ex("single_leg_rdl", "Single-leg Romanian deadlift", "Legs", "dumbbell", ["hamstrings", "glutes"], ["adductors"], ["lower_back", "obliques"], uni=True, est=(DEAD, 0.20))
ex("stiff_leg_deadlift", "Stiff-leg deadlift", "Legs", "barbell", ["hamstrings"], ["glutes", "lower_back"], ["adductors", "forearms"], fatigue="high", est=(DEAD, 0.65))
ex("leg_curl_lying", "Lying leg curl", "Legs", "machine", ["hamstrings"], [], ["calves"])
ex("leg_curl_seated", "Seated leg curl", "Legs", "machine", ["hamstrings"])
ex("leg_curl_standing", "Standing leg curl", "Legs", "machine", ["hamstrings"], uni=True)
ex("nordic_curl", "Nordic hamstring curl", "Legs", "bodyweight", ["hamstrings"], [], ["calves", "glutes"], mode="bodyweight", bw=0.6, fatigue="high")
ex("glute_ham_raise", "Glute-ham raise", "Legs", "bodyweight", ["hamstrings"], ["glutes"], ["calves", "lower_back"], mode="bodyweight", bw=0.5, fatigue="high")
ex("hip_thrust_bb", "Hip thrust (barbell)", "Legs", "barbell", ["glutes"], ["hamstrings"], ["quads", "adductors"], est=(DEAD, 1.00))
ex("hip_thrust_machine", "Hip thrust (machine)", "Legs", "machine", ["glutes"], ["hamstrings"])
ex("glute_bridge_bb", "Glute bridge (barbell)", "Legs", "barbell", ["glutes"], ["hamstrings"], est=(DEAD, 0.85))
ex("glute_bridge_bw", "Glute bridge (bodyweight)", "Legs", "bodyweight", ["glutes"], ["hamstrings"], mode="bodyweight", bw=0.3)
ex("cable_kickback", "Glute kickback (cable)", "Legs", "cable", ["glutes"], [], ["hamstrings"], uni=True)
ex("cable_pull_through", "Cable pull-through", "Legs", "cable", ["glutes"], ["hamstrings"], ["lower_back"])
ex("hip_abduction", "Hip abduction (machine)", "Legs", "machine", ["glutes"])
ex("hip_adduction", "Hip adduction (machine)", "Legs", "machine", ["adductors"])
ex("copenhagen_plank", "Copenhagen plank", "Legs", "bodyweight", ["adductors"], ["obliques"], mode="fixed", log_as="seconds", uni=True)
ex("calf_raise_standing", "Standing calf raise (machine)", "Legs", "machine", ["calves"])
ex("calf_raise_seated", "Seated calf raise (machine)", "Legs", "machine", ["calves"])
ex("calf_press", "Calf press (leg press)", "Legs", "machine", ["calves"])
ex("calf_raise_smith", "Calf raise (Smith machine)", "Legs", "smith", ["calves"], fatigue="low")
ex("calf_raise_single_db", "Single-leg calf raise (dumbbell)", "Legs", "dumbbell", ["calves"], uni=True, fatigue="low")

# ---------------- Core ----------------
ex("plank", "Plank", "Core", "bodyweight", ["abs"], ["obliques"], mode="fixed", log_as="seconds")
ex("side_plank", "Side plank", "Core", "bodyweight", ["obliques"], ["abs"], mode="fixed", log_as="seconds", uni=True)
ex("hollow_hold", "Hollow body hold", "Core", "bodyweight", ["abs"], [], ["obliques"], mode="fixed", log_as="seconds")
ex("crunch", "Crunch", "Core", "bodyweight", ["abs"], mode="bodyweight", bw=0.3, fatigue="low")
ex("cable_crunch", "Cable crunch", "Core", "cable", ["abs"])
ex("machine_crunch", "Crunch (machine)", "Core", "machine", ["abs"])
ex("decline_sit_up", "Decline sit-up", "Core", "bodyweight", ["abs"], [], ["obliques"], mode="bodyweight", bw=0.4)
ex("hanging_leg_raise", "Hanging leg raise", "Core", "bodyweight", ["abs"], [], ["forearms", "obliques"], mode="bodyweight", bw=0.35)
ex("hanging_knee_raise", "Hanging knee raise", "Core", "bodyweight", ["abs"], [], ["forearms"], mode="bodyweight", bw=0.25)
ex("captains_chair_raise", "Captain's chair leg raise", "Core", "bodyweight", ["abs"], mode="bodyweight", bw=0.3, fatigue="low")
ex("lying_leg_raise", "Lying leg raise", "Core", "bodyweight", ["abs"], mode="bodyweight", bw=0.25, fatigue="low")
ex("ab_wheel", "Ab wheel rollout", "Core", "bodyweight", ["abs"], ["lats"], ["obliques", "triceps"], mode="bodyweight", bw=0.6)
ex("dead_bug", "Dead bug", "Core", "bodyweight", ["abs"], mode="fixed", log_as="reps")
ex("bicycle_crunch", "Bicycle crunch", "Core", "bodyweight", ["obliques", "abs"], mode="fixed", log_as="reps")
ex("russian_twist", "Russian twist", "Core", "plate", ["obliques"], ["abs"])
ex("cable_woodchop", "Cable woodchop", "Core", "cable", ["obliques"], ["abs"], uni=True)
ex("pallof_press", "Pallof press", "Core", "cable", ["obliques"], ["abs"], uni=True)
ex("db_side_bend", "Side bend (dumbbell)", "Core", "dumbbell", ["obliques"], uni=True)

# ---------------- Full body ----------------
ex("power_clean", "Power clean", "Full body", "barbell", ["glutes", "quads"], ["traps", "hamstrings"], ["lower_back", "calves", "forearms"], fatigue="high", est=(DEAD, 0.55))
ex("kettlebell_swing", "Kettlebell swing", "Full body", "kettlebell", ["glutes", "hamstrings"], ["lower_back"], ["abs", "forearms"])
ex("farmers_walk", "Farmer's walk", "Full body", "dumbbell", ["forearms", "traps"], ["abs", "obliques"], ["quads", "glutes", "calves"], mode="fixed", log_as="seconds")
ex("sled_push", "Sled push", "Full body", "sled", ["quads", "glutes"], ["calves"], ["hamstrings", "abs"], mode="fixed", log_as="seconds", fatigue="high")


# ---------------- validation ----------------
def validate():
    slugs = [e["slug"] for e in E]
    assert len(slugs) == len(set(slugs)), "duplicate slugs"
    by_slug = {e["slug"]: e for e in E}
    for e in E:
        seen = set()
        for role, cap in ROLE_CAPS.items():
            ids = e[role]
            assert len(ids) <= cap, f"{e['slug']}: too many {role}"
            for m in ids:
                assert m in MUSCLES, f"{e['slug']}: unknown muscle {m}"
                assert m not in seen, f"{e['slug']}: {m} listed twice"
                seen.add(m)
        assert e["primary"], f"{e['slug']}: no primary"
        assert e["group"] in GROUPS, f"{e['slug']}: bad group"
        assert e["fatigue"] in FATIGUE
        if e["load_mode"] in ("bodyweight", "assisted"):
            assert e["bw_factor"] is not None, f"{e['slug']}: needs bw_factor"
        if e["load_mode"] == "fixed":
            assert e["log_as"] in ("seconds", "reps")
        est = e["pb_estimate"]
        if est:
            assert e["load_mode"] == "weight", f"{e['slug']}: estimates only for weighted lifts"
            src = by_slug.get(est["from"])
            assert src, f"{e['slug']}: estimate source {est['from']} missing"
            hops, cur = 0, e
            while cur["pb_estimate"]:
                cur = by_slug[cur["pb_estimate"]["from"]]
                hops += 1
                assert hops <= 3, f"{e['slug']}: library chains stop at 3 hops, leaving one for custom exercises"
    for m in MUSCLES:
        assert any(m in e["primary"] for e in E), f"{m} is never a primary"


def split(e):
    w = {}
    for role in ("primary", "secondary", "tertiary"):
        for m in e[role]:
            w[m] = ROLE_WEIGHTS[role]
    total = sum(w.values())
    raw = {m: 100 * v / total for m, v in w.items()}
    pct = {m: int(v) for m, v in raw.items()}
    # largest remainder so the split always sums to 100
    for m in sorted(raw, key=lambda k: raw[k] - pct[k], reverse=True)[:100 - sum(pct.values())]:
        pct[m] += 1
    return pct


def chain_text(e, by_slug):
    est = e["pb_estimate"]
    if est is None:
        if e["slug"] in (BENCH, SQUAT):
            return "anchor"
        return "first session" if e["load_mode"] != "fixed" else "not needed"
    return f"`{est['from']}` × {est['ratio']:.2f}"


def mode_text(e):
    if e["load_mode"] == "weight":
        t = "weight"
    elif e["load_mode"] == "bodyweight":
        t = f"BW × {e['bw_factor']:.2f}"
    elif e["load_mode"] == "assisted":
        t = f"BW × {e['bw_factor']:.2f} − assist"
    else:
        t = f"fixed ({'s' if e['log_as'] == 'seconds' else 'reps'})"
    if e["unilateral"]:
        t += " · uni"
    return t


def fmt(ids):
    return ", ".join(ids) if ids else "—"


def write_md(root):
    by_slug = {e["slug"]: e for e in E}
    out = []
    out.append("# Splitset — Exercise Library\n")
    out.append("Generated by `scripts/build_exercise_library.py`. Edit the script, never this file. "
               "Seed data: `data/exercise_library.json` (and `.csv`).\n")
    out.append(f"{len(E)} exercises across {len(MUSCLES)} muscles. Each exercise loads up to two **primary** muscles "
               "(weight 1.0), two **secondary** (0.4) and three **tertiary** (0.2). How those weights turn sets into "
               "load is `docs/load-model-spec.md` §6.\n")
    out.append("## How to read the tables\n")
    out.append("| Column | Meaning |\n|---|---|")
    out.append("| Primary · 1.0 | The muscle the exercise is for. It limits the set. Gets the full exercise load. |")
    out.append("| Secondary · 0.4 | Does real work but does not limit the set. Gets 40% of the exercise load. |")
    out.append("| Tertiary · 0.2 | Stabilises or assists. Fatigues, is not trained. Gets 20%. |")
    out.append("| Load split | Where one set's load lands on the body, as % of the total the exercise hands out. Show this in the exercise picker. |")
    out.append(f"| Fatigue | `high` × {FATIGUE['high']}, `standard` × {FATIGUE['standard']}, `low` × {FATIGUE['low']} on the exercise load. High = heavy free-weight compounds and big-stretch eccentrics; low = machines, cables, bands, calf raises, light core. |")
    out.append("| Mode | `weight`: logged weight × reps. `BW × f`: effective weight = bodyweight × f + added load. `− assist`: minus the machine's assistance. `fixed`: no usable weight; each working set costs a fixed amount (spec §4.3). `uni`: unilateral, one logged set covers both sides. |")
    out.append("| PB estimate | Where the starting PB comes from before this exercise has any history (spec §3.4): a related lift × ratio, `first session` (calibrated from the first workout), or `anchor` (a root lift others estimate from). |")
    out.append("")
    out.append("## Muscles\n")
    out.append("| ID | Name | Group | Figure view | Base recovery (h) |\n|---|---|---|---|---|")
    for mid, (g, name, views) in MUSCLES.items():
        out.append(f"| `{mid}` | {name} | {g} | {' + '.join(views)} | {base_hours(mid)} |")
    out.append("")
    out.append("`traps` covers the whole trapezius plus rhomboids (the upper back). `glutes` includes glute medius, so hip abduction lands there. "
               "`adductors` is the inner thigh, a big contributor to squats, lunges and sumo pulls.\n")
    for g in GROUPS:
        rows = [e for e in E if e["group"] == g]
        out.append(f"## {g} ({len(rows)})\n")
        out.append("| Exercise | Primary · 1.0 | Secondary · 0.4 | Tertiary · 0.2 | Load split (%) | Fatigue | Mode | PB estimate |")
        out.append("|---|---|---|---|---|---|---|---|")
        for e in rows:
            sp = split(e)
            sp_txt = " · ".join(f"{m} {v}" for m, v in sp.items())
            name = f"{e['name']} `{e['slug']}`"
            if e["note"]:
                name += f" — {e['note']}"
            out.append(f"| {name} | {fmt(e['primary'])} | {fmt(e['secondary'])} | {fmt(e['tertiary'])} | "
                       f"{sp_txt} | {e['fatigue']} | {mode_text(e)} | {chain_text(e, by_slug)} |")
        out.append("")
    out.append("## Reverse index: exercises per muscle\n")
    out.append("Which exercises load each muscle, by role. Feeds the \"train next\" suggestion and checks coverage.\n")
    out.append("| Muscle | Primary in | Secondary in | Tertiary in |\n|---|---|---|---|")
    for mid in MUSCLES:
        p = [e["slug"] for e in E if mid in e["primary"]]
        s = [e["slug"] for e in E if mid in e["secondary"]]
        t = [e["slug"] for e in E if mid in e["tertiary"]]
        out.append(f"| `{mid}` | {len(p)}: {', '.join(p)} | {len(s)}: {', '.join(s) or '—'} | {len(t)}: {', '.join(t) or '—'} |")
    out.append("")
    (root / "docs" / "exercise-library.md").write_text("\n".join(out), encoding="utf-8")


def write_csv(root):
    path = root / "data" / "exercise_library.csv"
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["slug", "name", "group", "equipment", "load_mode", "bw_factor", "unilateral", "log_as",
                    "fatigue", "primary", "secondary", "tertiary", "pb_estimate_from", "pb_estimate_ratio", "note"])
        for e in E:
            est = e["pb_estimate"] or {}
            w.writerow([e["slug"], e["name"], e["group"], e["equipment"], e["load_mode"],
                        "" if e["bw_factor"] is None else e["bw_factor"],
                        "true" if e["unilateral"] else "false", e["log_as"], e["fatigue"],
                        "|".join(e["primary"]), "|".join(e["secondary"]), "|".join(e["tertiary"]),
                        est.get("from", ""), est.get("ratio", ""), e["note"]])


def write_json(root):
    payload = {
        "version": "2.0",
        "_doc": "Exercises and muscles only. Weights, caps, fatigue factors and recovery hours live in data/recovery_constants.json.",
        "muscles": [
            {"id": mid, "group": g, "name": name, "views": views}
            for mid, (g, name, views) in MUSCLES.items()
        ],
        "exercises": [dict(e, load_split=split(e)) for e in E],
    }
    (root / "data" / "exercise_library.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")


if __name__ == "__main__":
    root = Path(__file__).resolve().parent.parent
    (root / "docs").mkdir(exist_ok=True)
    (root / "data").mkdir(exist_ok=True)
    validate()
    write_md(root)
    write_csv(root)
    write_json(root)
    counts = {g: sum(1 for e in E if e["group"] == g) for g in GROUPS}
    print(f"ok: {len(E)} exercises, {len(MUSCLES)} muscles {counts}")
