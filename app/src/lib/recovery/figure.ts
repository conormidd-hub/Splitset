// Build phase 6: the body figure as data. assets/body-front.svg and assets/body-back.svg (copied
// unchanged into bodySvg.ts) are parsed into their shapes, and painted from a recovery or session
// map under the figure contract of spec §10:
//
// - a region is a shape with data-muscle (one of the 17 IDs) and data-side; it takes its level's
//   fill or fill_dark (the ready colour at level 0) and region_stroke(_dark) as its outline;
// - a shape with data-role="silhouette" only ever takes silhouette_fill(_dark);
// - anything else keeps its own attributes.
//
// Pure, so the tests paint exactly what src/components/recovery/BodyMap.tsx draws, and write it
// back out as SVG snapshots. Every colour comes from the thresholds (recovery_constants.json).

import { fmtHours } from './engine.ts';
import { isMuscleId, MUSCLE_IDS, type MuscleId, type Role } from './library.ts';
import type { Thresholds } from './thresholds.ts';

export type FigureView = 'front' | 'back';
export type FigureTheme = 'light' | 'dark';
export type MapMode = 'recovery' | 'session';

// ---------------------------------------------------------------- parsing

export interface SvgNode {
  tag: string;
  attrs: Record<string, string>;
  children: SvgNode[];
  text: string;
}

const TOKEN = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>|([^<]+)|(<)/g;
const ATTR = /([\w:.-]+)\s*=\s*"([^"]*)"/g;

const unescape = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Parses the subset of XML an SVG figure uses: elements, double-quoted attributes, text,
 *  comments and declarations. Anything else throws, rather than drawing half a figure. */
export function parseSvg(text: string): SvgNode {
  const root: SvgNode = { tag: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  for (const m of text.matchAll(TOKEN)) {
    const [, close, tag, attrText, selfClose, chars, stray] = m;
    if (stray) throw new Error(`cannot parse the SVG at offset ${m.index}`);
    if (chars != null) {
      if (chars.trim()) stack[stack.length - 1].text += unescape(chars.trim());
      continue;
    }
    if (!tag) continue;   // a comment or declaration
    if (close) {
      const open = stack.pop();
      if (!open || open.tag !== tag) throw new Error(`</${tag}> does not close <${open?.tag}>`);
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const [, k, v] of (attrText ?? '').matchAll(ATTR)) attrs[k] = unescape(v);
    const node: SvgNode = { tag, attrs, children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  if (stack.length !== 1) throw new Error(`<${stack[stack.length - 1].tag}> is never closed`);
  const [svg] = root.children;
  if (!svg || svg.tag !== 'svg' || root.children.length !== 1) throw new Error('expected one <svg> element');
  return svg;
}

// ---------------------------------------------------------------- the figure

const SHAPES = ['path', 'ellipse', 'circle', 'rect', 'polygon'] as const;
export type ShapeKind = (typeof SHAPES)[number];
const CONTAINERS = new Set(['g']);
const IGNORED = new Set(['title', 'desc']);

export interface Shape {
  kind: ShapeKind;
  /** The element id, else its position: unique within the view. */
  key: string;
  id: string | null;
  muscle: MuscleId | null;
  side: string | null;
  silhouette: boolean;
  /** The element's own attributes. */
  attrs: Readonly<Record<string, string>>;
}

export interface Figure {
  viewBox: readonly [number, number, number, number];
  title: string;
  shapes: readonly Shape[];
}

/** The figure in an SVG: its shapes in drawing order. Throws on anything the contract doesn't
 *  allow: transforms, an unknown element, a region with an unknown muscle ID or no side, or a
 *  shape that is both a region and silhouette. */
export function figureOf(text: string): Figure {
  const svg = parseSvg(text);
  const viewBox = (svg.attrs.viewBox ?? '').trim().split(/[\s,]+/).map(Number);
  if (viewBox.length !== 4 || viewBox.some((n) => !Number.isFinite(n))) throw new Error('the SVG needs a viewBox');
  let title = '';
  const shapes: Shape[] = [];
  const walk = (node: SvgNode) => {
    for (const el of node.children) {
      if (el.attrs.transform) throw new Error(`transforms are not supported (${el.tag}${el.attrs.id ? ` #${el.attrs.id}` : ''})`);
      if (IGNORED.has(el.tag)) {
        if (el.tag === 'title' && !title) title = el.text;
        continue;
      }
      if (CONTAINERS.has(el.tag)) {
        walk(el);
        continue;
      }
      if (!(SHAPES as readonly string[]).includes(el.tag)) throw new Error(`unexpected <${el.tag}> in the figure`);
      const muscle = el.attrs['data-muscle'] ?? null;
      const silhouette = el.attrs['data-role'] === 'silhouette';
      const id = el.attrs.id ?? null;
      const where = id ?? `${el.tag} ${shapes.length}`;
      if (muscle != null && !isMuscleId(muscle)) throw new Error(`${where}: unknown muscle "${muscle}"`);
      if (muscle != null && silhouette) throw new Error(`${where}: a region cannot be silhouette`);
      if (muscle != null && !el.attrs['data-side']) throw new Error(`${where}: a region needs data-side`);
      shapes.push({
        kind: el.tag as ShapeKind, key: id ?? `${el.tag}-${shapes.length}`, id, muscle: muscle as MuscleId | null,
        side: el.attrs['data-side'] ?? null, silhouette, attrs: el.attrs,
      });
    }
  };
  walk(svg);
  return { viewBox: viewBox as unknown as Figure['viewBox'], title, shapes };
}

/** The muscles a view shows. */
export function musclesIn(figure: Figure): MuscleId[] {
  const seen = new Set(figure.shapes.map((s) => s.muscle).filter((m): m is MuscleId => m != null));
  return MUSCLE_IDS.filter((id) => seen.has(id));
}

// ---------------------------------------------------------------- painting

/** What a region needs from a recovery_map or session_map entry. */
export interface RegionState {
  level: number;
  label: string;
  fill: string;
  fill_dark: string;
}
export type FigureMap = Readonly<Record<MuscleId, RegionState>>;

export interface FigureColours {
  silhouette: string;
  stroke: string;
  ready: string;
}

export function figureColours(c: Thresholds, theme: FigureTheme): FigureColours {
  return theme === 'dark'
    ? { silhouette: c.silhouette_fill_dark, stroke: c.region_stroke_dark, ready: c.ready_fill_dark }
    : { silhouette: c.silhouette_fill, stroke: c.region_stroke, ready: c.ready_fill };
}

/** A level's fill in a theme; level 0 (and a level with no fill) takes the ready colour. */
export function levelFill(c: Thresholds, level: number, theme: FigureTheme): string {
  const band = c.levels[level];
  return (theme === 'dark' ? band?.fill_dark : band?.fill) || figureColours(c, theme).ready;
}

export interface PaintedShape {
  kind: ShapeKind;
  key: string;
  muscle: MuscleId | null;
  /** The shape's attributes with fill and stroke as the contract sets them. */
  attrs: Record<string, string>;
}

/** The figure's shapes, painted from `map` (null: every region Ready). */
export function paintFigure(figure: Figure, map: FigureMap | null, theme: FigureTheme, c: Thresholds): PaintedShape[] {
  const colours = figureColours(c, theme);
  return figure.shapes.map((s) => {
    const attrs = { ...s.attrs };
    if (s.silhouette) attrs.fill = colours.silhouette;
    else if (s.muscle) {
      const state = map?.[s.muscle];
      attrs.fill = state ? (theme === 'dark' ? state.fill_dark : state.fill) || colours.ready : colours.ready;
      attrs.stroke = colours.stroke;
    }
    return { kind: s.kind, key: s.key, muscle: s.muscle, attrs };
  });
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** The painted figure as SVG text: the snapshot tests' output, which opens in any browser. */
export function figureSvgText(figure: Figure, painted: readonly PaintedShape[], background?: string): string {
  const [x, y, w, h] = figure.viewBox;
  const lines = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${figure.viewBox.join(' ')}" width="${w}" height="${h}">`];
  if (background) lines.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${background}"/>`);
  for (const p of painted) {
    const attrs = Object.entries(p.attrs).map(([k, v]) => `${k}="${escape(v)}"`).join(' ');
    lines.push(`<${p.kind} ${attrs}/>`);
  }
  lines.push('</svg>', '');
  return lines.join('\n');
}

// ---------------------------------------------------------------- legend, list and tap detail

export interface LegendRow {
  level: number;
  label: string;
  /** "F < 0.25", "0.25 – 0.75", … "≥ 4.0"; L instead of F on the session view. */
  range: string;
  advice: string;
  fill: string;
}

const bound = (x: number) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

/** The six levels, from the thresholds' `levels`. */
export function legendRows(c: Thresholds, theme: FigureTheme, mode: MapMode): LegendRow[] {
  const symbol = mode === 'session' ? 'L' : 'F';
  return c.levels.map((band, i) => {
    const next = c.levels[i + 1];
    const range = i === 0 ? `${symbol} < ${bound(next.min)}` : next ? `${bound(band.min)} – ${bound(next.min)}` : `≥ ${bound(band.min)}`;
    return { level: band.level, label: band.label, range, advice: band.advice, fill: levelFill(c, band.level, theme) };
  });
}

/** What the list view needs from a map entry, on either view. */
export interface ListState extends RegionState {
  F?: number;
  L?: number;
  trainable_in_h?: number | null;
  ready_in_h?: number | null;
  trainable_after_h?: number;
  ready_after_h?: number;
}

export interface ListRow {
  muscle: MuscleId;
  level: number;
  label: string;
  /** F on the recovery view, L on the session view. */
  value: number;
  trainable: string;
  ready: string;
}

/** Every muscle, highest level first, then highest F (or L), then spec §2 order. */
export function listRows(map: Readonly<Record<MuscleId, ListState>>, mode: MapMode): ListRow[] {
  return MUSCLE_IDS.map((muscle) => {
    const s = map[muscle];
    const session = mode === 'session';
    return {
      muscle, level: s.level, label: s.label, value: (session ? s.L : s.F) ?? 0,
      trainable: fmtHours(session ? s.trainable_after_h : s.trainable_in_h),
      ready: fmtHours(session ? s.ready_after_h : s.ready_in_h),
    };
  }).sort((a, b) => b.level - a.level || b.value - a.value || MUSCLE_IDS.indexOf(a.muscle) - MUSCLE_IDS.indexOf(b.muscle));
}

/** A list row's numbers as one phrase, "F 2.56 · trainable in 1.0 days · ready in 2.2 days" (after,
 *  on the session view); a time that has come reads "trainable now", with no "in". */
export function listLine(r: ListRow, mode: MapMode, sep = ' · '): string {
  const session = mode === 'session';
  const when = (word: string, t: string) => (t === 'now' || t === '—' ? `${word} ${t}` : `${word} ${session ? 'after' : 'in'} ${t}`);
  return [`${session ? 'L' : 'F'} ${r.value.toFixed(2)}`, when('trainable', r.trainable), when('ready', r.ready)].join(sep);
}

/** The list's four number columns take 302 pt; below this width there would be no room left for
 *  a name like "Traps & upper back", so each row puts its numbers on a second line instead. */
export const LIST_COMPACT_BELOW = 460;

/** Whether the list view, `width` pt wide, uses its two-line rows (every phone). */
export function listCompact(width: number): boolean {
  return width < LIST_COMPACT_BELOW;
}

/** The role badge of the tap detail. */
export const ROLE_BADGE: Record<Role, string> = { primary: 'P', secondary: 'S', tertiary: 'T' };

/** The marker for a contribution whose reference is provisional (spec §10), or null. */
export function referenceMarker(pbSource: string): 'estimated' | 'calibrating' | null {
  return pbSource === 'estimated' ? 'estimated' : pbSource === 'calibration' ? 'calibrating' : null;
}

/** A muscle ID as words, until the muscles table's names have loaded. */
export function muscleFallbackName(id: string): string {
  const words = id.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
