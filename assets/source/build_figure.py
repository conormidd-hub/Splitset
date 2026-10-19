#!/usr/bin/env python3
"""Builds assets/body-front.svg and assets/body-back.svg from Conor's coral artwork
(assets/source/split-set-coral-light.svg, the master shape; the dark file only gave colours).

    python assets/source/build_figure.py

The artwork is a traced drawing grouped by colour (one state of the F26 week), not by muscle.
This script re-groups it under the figure contract of spec §10:

- every muscle shape becomes a <path> with data-muscle (one of the 17 IDs) and data-side
  (viewer's left or right; "both" for the one abs shape that spans the midline);
- head, neck, hands, shins, knees and hips become data-role="silhouette";
- the traced base outline and the slivers the tracer left in the gaps are dropped, so the gaps
  between shapes show the page behind the figure, as in the artwork;
- front and back become two files, each with its own 561 × 1290 viewBox and the body centred
  in it (shapes moved sideways, not transformed), ids prefixed front- / back-, and no legend
  or text. data-side is the side of the body's midline the shape is on.

SHAPES maps each shape, by its position in the source file, to what it is. It refuses to run if
the source changes, because positions would then mean something else.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
SOURCE = HERE / "split-set-coral-light.svg"
SOURCE_SHA256 = "01e40c0ed94e4ae74ca5c599b79477f8a1cf85ef45f0438dc959eb00daf826f2"   # of the text with LF line endings
ASSETS = HERE.parent
VIEW_W, VIEW_H = 561, 1290
STROKE = 'stroke-width="1.9" stroke-linejoin="round"'

S, X = "silhouette", None   # X: dropped (the base outline and slivers)

# shape index → muscle, "silhouette" or dropped. Front: x < 561, back: x ≥ 561.
SHAPES: dict[int, str | None] = {
    # base outlines (the gap colour) and slivers
    0: X, 1: X, 55: X, 56: X, 57: X, 58: X, 59: X, 60: X, 61: X, 62: X, 63: X, 64: X, 65: X, 66: X, 67: X, 68: X,
    # ---- front
    4: S, 9: S, 5: S, 6: S, 11: S, 7: S, 43: S, 44: S, 39: S,
    35: "traps", 34: "traps",
    24: "front_delts", 21: "front_delts",
    25: "side_delts", 27: "side_delts",
    54: "chest", 53: "chest",
    110: "biceps", 109: "biceps", 114: "biceps", 115: "biceps",
    36: "forearms", 16: "forearms", 33: "forearms", 46: "forearms", 37: "forearms", 17: "forearms", 45: "forearms",
    2: "abs",
    40: "obliques", 38: "obliques", 49: "obliques", 18: "obliques",
    106: "quads", 108: "quads", 111: "quads", 104: "quads", 107: "quads", 112: "quads",
    93: "adductors", 91: "adductors", 94: "adductors", 92: "adductors",
    98: "calves", 73: "calves", 82: "calves", 99: "calves", 81: "calves", 74: "calves", 97: "calves", 100: "calves",
    # ---- back
    3: S, 12: S, 13: S, 14: S, 15: S, 8: S, 10: S, 41: S, 42: S, 52: S,
    113: "traps", 116: "traps", 102: "traps", 101: "traps",
    23: "side_delts", 22: "side_delts",
    83: "rear_delts", 84: "rear_delts", 86: "rear_delts", 87: "rear_delts",
    69: "lats", 70: "lats",
    75: "lower_back", 76: "lower_back",
    30: "obliques", 32: "obliques",
    79: "triceps", 80: "triceps", 95: "triceps", 96: "triceps",
    29: "forearms", 28: "forearms", 19: "forearms", 47: "forearms", 31: "forearms", 26: "forearms", 20: "forearms", 48: "forearms",
    50: "glutes", 51: "glutes", 103: "glutes", 105: "glutes",
    119: "hamstrings", 121: "hamstrings", 117: "hamstrings", 124: "hamstrings",
    118: "hamstrings", 123: "hamstrings", 122: "hamstrings", 120: "hamstrings",
    89: "adductors", 90: "adductors",
    78: "calves", 71: "calves", 88: "calves", 72: "calves", 77: "calves", 85: "calves",
}
MIDLINE = {2}   # spans both sides


def shapes(text: str) -> list[list[tuple[int, int]]]:
    """Every <path> polygon in document order (the artwork uses only M, L and Z)."""
    out = []
    for d in re.findall(r'<path\b[^>]*\sd="([^"]*)"', text):
        if re.search(r"[^MLZ\d\s.,-]", d):
            raise SystemExit("the source uses path commands other than M, L and Z")
        nums = [round(float(n)) for n in re.findall(r"-?\d+(?:\.\d+)?", d)]
        out.append(list(zip(nums[0::2], nums[1::2])))
    return out


def centroid(pts: list[tuple[int, int]]) -> tuple[float, float]:
    a = cx = cy = 0.0
    for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1]):
        c = x1 * y2 - x2 * y1
        a += c
        cx += (x1 + x2) * c
        cy += (y1 + y2) * c
    return cx / (3 * a), cy / (3 * a)


def build() -> None:
    text = SOURCE.read_text(encoding="utf-8").replace("\r\n", "\n")
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    if digest != SOURCE_SHA256:
        raise SystemExit(f"{SOURCE.name} has changed (sha256 {digest}); re-map SHAPES before building")
    polys = shapes(text)
    if sorted(SHAPES) != list(range(len(polys))):
        missing = sorted(set(range(len(polys))) - set(SHAPES))
        raise SystemExit(f"SHAPES must name all {len(polys)} shapes; missing {missing}")

    # which view each kept shape is in, and how far to move each view so its body is centred
    kept = [(i, pts, "front" if centroid(pts)[0] < VIEW_W else "back") for i, pts in enumerate(polys) if SHAPES[i] is not None]
    shift: dict[str, int] = {}
    for view in ("front", "back"):
        xs = [x for _, pts, v in kept if v == view for x, _ in pts]
        shift[view] = round((min(xs) + max(xs)) / 2 - VIEW_W / 2)

    views: dict[str, dict[str, list[str]]] = {"front": {"silhouette": [], "muscles": []}, "back": {"silhouette": [], "muscles": []}}
    counts: dict[str, int] = {}
    for i, pts, view in kept:
        what = SHAPES[i]
        local = [(x - shift[view], y) for x, y in pts]
        if min(x for x, _ in local) < 0 or max(x for x, _ in local) > VIEW_W:
            raise SystemExit(f"shape {i} falls outside the {view} view")
        d = "M " + " L ".join(f"{x} {y}" for x, y in local) + " Z"
        side = "both" if i in MIDLINE else ("left" if centroid(local)[0] < VIEW_W / 2 else "right")
        if what == S:
            key = f"{view}-silhouette"
            counts[key] = counts.get(key, 0) + 1
            views[view]["silhouette"].append(f'<path id="{key}-{counts[key]}" data-role="silhouette" fill="#D9DDE3" d="{d}"/>')
        else:
            key = f"{view}-{what}-{side}"
            counts[key] = counts.get(key, 0) + 1
            views[view]["muscles"].append(
                f'<path id="{key}-{counts[key]}" data-muscle="{what}" data-side="{side}" fill="#D9DDE3" stroke="#FFFFFF" {STROKE} d="{d}"/>')

    for view, parts in views.items():
        title = f"Body map, {view} view"
        svg = "\n".join([
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {VIEW_W} {VIEW_H}" width="{VIEW_W}" height="{VIEW_H}" role="img" aria-labelledby="title-{view}">',
            f'<title id="title-{view}">{title}</title>',
            f'<g id="{view}-silhouette">', *parts["silhouette"], "</g>",
            f'<g id="{view}-muscles">', *parts["muscles"], "</g>",
            "</svg>", "",
        ])
        (ASSETS / f"body-{view}.svg").write_text(svg, encoding="utf-8", newline="\n")
        print(f"wrote assets/body-{view}.svg: {len(parts['muscles'])} muscle shapes, {len(parts['silhouette'])} silhouette shapes")


if __name__ == "__main__":
    build()
