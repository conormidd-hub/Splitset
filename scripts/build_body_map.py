#!/usr/bin/env python3
"""Generates the body-map figure used by the Muscle Recovery Map.

Writes assets/body-front.svg and assets/body-back.svg. Each muscle region is a
<path> with data-muscle="<muscle id>" and data-side="left|right" (viewer's side);
the app colours a region by setting its fill attribute. Silhouette shapes carry
data-role="silhouette" and switch fill with the theme; region strokes carry the
page background colour and switch with it too. Element ids are prefixed with the
view ("front-", "back-") so both files can be inlined on one page.
Shapes are stylised, not anatomical: a starter asset that satisfies the region
contract in docs/load-model-spec.md §10 and docs/build-phases.md Phase 6.

Shapes are drawn for the viewer's left half and mirrored; all coordinates are
absolute (no transforms) so any SVG renderer, including native ones, can load them.

Run from the repo root:  python3 scripts/build_body_map.py
"""
from pathlib import Path

W, H = 200, 460
CX = 100
SILHOUETTE = "#EEF0F3"
READY = "#D9DDE3"
STROKE = "#FFFFFF"


def smooth(points, closed=True, t=1.0):
    """Catmull-Rom through the points, as cubic Bezier path data."""
    p = points
    n = len(p)
    d = [f"M{p[0][0]:.1f},{p[0][1]:.1f}"]
    rng = range(n) if closed else range(n - 1)
    for i in rng:
        p0 = p[(i - 1) % n] if closed or i > 0 else p[i]
        p1 = p[i]
        p2 = p[(i + 1) % n]
        p3 = p[(i + 2) % n] if closed or i + 2 < n else p2
        c1 = (p1[0] + (p2[0] - p0[0]) * t / 6, p1[1] + (p2[1] - p0[1]) * t / 6)
        c2 = (p2[0] - (p3[0] - p1[0]) * t / 6, p2[1] - (p3[1] - p1[1]) * t / 6)
        d.append(f"C{c1[0]:.1f},{c1[1]:.1f} {c2[0]:.1f},{c2[1]:.1f} {p2[0]:.1f},{p2[1]:.1f}")
    if closed:
        d.append("Z")
    return " ".join(d)


def mirror(points):
    return [(2 * CX - x, y) for x, y in reversed(points)]


def rounded_rect(x0, y0, x1, y1, r):
    return (f"M{x0 + r:.1f},{y0:.1f} H{x1 - r:.1f} Q{x1:.1f},{y0:.1f} {x1:.1f},{y0 + r:.1f} "
            f"V{y1 - r:.1f} Q{x1:.1f},{y1:.1f} {x1 - r:.1f},{y1:.1f} H{x0 + r:.1f} "
            f"Q{x0:.1f},{y1:.1f} {x0:.1f},{y1 - r:.1f} V{y0 + r:.1f} Q{x0:.1f},{y0:.1f} {x0 + r:.1f},{y0:.1f} Z")


# ---------------- silhouette (viewer's left half) ----------------
TORSO = [(100, 70), (89, 72), (76, 77), (62, 82), (57, 92), (60, 112), (65, 124), (67, 146),
         (71, 168), (73, 190), (71, 206), (67, 220), (64.5, 236), (72, 246), (100, 248)]
ARM = [(60, 84), (50, 86), (44, 96), (42, 112), (41, 138), (38, 162), (36, 182), (32, 204), (31, 228),
       (33, 252), (31, 266), (32, 284), (38, 296), (45, 293), (47, 280), (46, 262), (48, 248), (51, 226),
       (54, 204), (56, 184), (58, 166), (60, 146), (61, 128), (63, 112), (63, 96)]
LEG = [(68, 226), (64, 244), (63.5, 262), (63, 278), (67, 306), (71, 330), (69, 350), (68, 372), (72, 396),
       (78, 418), (75, 432), (78, 446), (96, 447), (97, 434), (94, 420), (93, 404), (95, 376),
       (95, 350), (94, 334), (96, 304), (98.6, 276), (99.2, 250), (100, 240)]
NECK = [(90, 50), (90, 74), (110, 74), (110, 50)]


def silhouette():
    sil = f'data-role="silhouette" fill="{SILHOUETTE}"'
    paths = [
        f'<ellipse {sil} cx="{CX}" cy="32" rx="20" ry="25"/>',
        f'<path {sil} d="{smooth(NECK)}"/>',
        f'<path {sil} d="{smooth(TORSO + mirror(TORSO))}"/>',
    ]
    for pts in (ARM, mirror(ARM), LEG, mirror(LEG)):
        paths.append(f'<path {sil} d="{smooth(pts)}"/>')
    return paths


# ---------------- muscle regions (viewer's left half) ----------------
FRONT = {
    "traps": [(90, 62), (89.5, 73), (78, 77), (66, 81), (74, 75), (84, 68)],
    "front_delts": [(65, 85), (58, 87), (53, 96), (53, 110), (57, 121), (62, 114), (65, 101)],
    "side_delts": [(56, 85), (49, 89), (44.5, 99), (44.5, 112), (49, 121), (52, 109), (52, 95)],
    "chest": [(98.4, 86), (86, 83), (70, 86), (66, 96), (65.5, 111), (68, 124), (77, 132), (88, 135), (98.4, 133)],
    "biceps": [(58, 125), (51, 128), (46.5, 141), (45.5, 158), (48, 173), (54, 175), (57.5, 160), (59, 142)],
    "forearms": [(51, 184), (43, 190), (37.5, 206), (37, 228), (40.5, 250), (45.5, 250), (49, 228), (52.5, 206), (54.5, 192)],
    "obliques": [(85, 140), (75, 139), (70.5, 150), (72, 172), (74.5, 192), (78, 208), (85, 222), (87.5, 210), (86.5, 186), (86.5, 162)],
    "quads": [(72, 240), (67, 254), (66, 278), (69, 302), (74.5, 322), (82, 328), (90, 322), (92, 302), (90, 274), (86, 252), (80, 242)],
    "adductors": [(98.4, 248), (92, 251), (89, 262), (90.5, 284), (95, 300), (97.6, 290), (98.4, 268)],
    "calves": [(72.5, 344), (70, 360), (71, 382), (75.5, 400), (79.5, 398), (80, 378), (79, 357), (76.5, 344)],
    "calves_inner": [(91.5, 344), (94, 360), (93, 382), (88.5, 400), (84.5, 398), (84.5, 378), (86, 357), (88, 344)],
}
ABS_SEGMENTS = [(140, 159), (162, 181), (184, 203)]

BACK = {
    "traps": [(99.4, 60), (92, 63), (84, 71), (72, 79), (61, 85), (71, 91), (82, 101), (89, 118), (95, 138), (99.4, 152)],
    "rear_delts": [(61, 88), (54, 89), (48.5, 97), (48, 110), (52, 120), (57, 115), (62, 104), (66, 94)],
    "side_delts": [(51, 87), (46, 92), (43.5, 103), (44.5, 115), (47, 118), (47.5, 105), (49, 95)],
    "lats": [(67, 98), (63.5, 112), (65, 136), (69, 162), (76, 184), (86, 197), (90, 186), (89, 164), (86, 144), (81, 122), (75, 104)],
    "lower_back": [(99.4, 156), (94, 154), (90.5, 168), (90, 192), (91.5, 214), (96, 225), (99.4, 225)],
    "triceps": [(57.5, 122), (50, 125), (45.5, 137), (44.5, 155), (46.5, 172), (52.5, 177), (57, 166), (59, 145)],
    "forearms": [(51, 184), (43, 190), (37.5, 206), (37, 228), (40.5, 250), (45.5, 250), (49, 228), (52.5, 206), (54.5, 192)],
    "glutes": [(99.4, 229), (90, 228), (78, 230), (69, 239), (66, 256), (70, 271), (82, 279), (94, 277), (99.4, 269)],
    "hamstrings": [(70, 283), (67, 300), (68.5, 318), (74, 330), (84, 333), (90.5, 322), (92, 302), (90, 285), (80, 282)],
    "adductors": [(98.4, 280), (95, 283), (93.5, 297), (95.5, 310), (98.2, 304)],
    "calves": [(72.5, 342), (69, 358), (70, 380), (75.5, 397), (82, 396), (83.5, 374), (82.5, 352), (78.5, 341)],
    "calves_inner": [(86.5, 341), (91.5, 346), (94.5, 362), (93, 384), (88, 397), (85.5, 376), (85.5, 352)],
}


def region(muscle, pts, side, rid, view):
    d = smooth(pts)
    rid = f"{view}-{rid}"
    return f'<path id="{rid}" data-muscle="{muscle}" data-side="{side}" fill="{READY}" stroke="{STROKE}" stroke-width="1.2" stroke-linejoin="round" d="{d}"/>'


def muscles(defs, view):
    out = []
    for key, pts in defs.items():
        muscle = key.replace("_inner", "")
        suffix = "-inner" if key.endswith("_inner") else ""
        out.append(region(muscle, pts, "left", f"{muscle}{suffix}-left", view))
        out.append(region(muscle, mirror(pts), "right", f"{muscle}{suffix}-right", view))
    if view == "front":
        for n, (y0, y1) in enumerate(ABS_SEGMENTS, 1):
            for side, (x0, x1) in (("left", (88.6, 98.6)), ("right", (101.4, 111.4))):
                out.append(f'<path id="front-abs-{n}-{side}" data-muscle="abs" data-side="{side}" fill="{READY}" '
                           f'stroke="{STROKE}" stroke-width="1.2" d="{rounded_rect(x0, y0, x1, y1, 3)}"/>')
        lower = [(98.6, 206), (89.4, 206), (89.6, 218), (93, 230), (98.6, 238)]
        out.append(region("abs", lower, "left", "abs-4-left", view))
        out.append(region("abs", mirror(lower), "right", "abs-4-right", view))
    return out


def svg(view):
    defs = FRONT if view == "front" else BACK
    label = "Front" if view == "front" else "Back"
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" '
             f'role="img" aria-labelledby="title-{view}">',
             f'<title id="title-{view}">Body map, {label.lower()} view</title>',
             f'<g id="{view}-silhouette">', *silhouette(), '</g>',
             f'<g id="{view}-muscles">', *muscles(defs, view), '</g>',
             '</svg>']
    return "\n".join(parts) + "\n"


if __name__ == "__main__":
    root = Path(__file__).resolve().parent.parent
    (root / "assets").mkdir(exist_ok=True)
    for view in ("front", "back"):
        (root / "assets" / f"body-{view}.svg").write_text(svg(view), encoding="utf-8")
    print("ok: assets/body-front.svg, assets/body-back.svg")
