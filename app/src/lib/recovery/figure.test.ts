/// <reference types="node" />

// Build phase 6's figure: both SVGs parse under the contract of spec §10, the embedded copy matches
// the files, silhouette never takes a level colour, and the painted figure is snapshotted as SVG
// files you can open in a browser and compare by eye with docs/recovery-map-preview.png:
//
//   F26 at Wednesday 20:00, front and back, light and dark
//   the F20 push day at 0, 24 and 48 h (chest High → Moderate → Low, as in F23), light
//
// A missing or changed snapshot fails. After a deliberate change, rewrite them with
//   UPDATE_SNAPSHOTS=1 npm test          (PowerShell: $env:UPDATE_SNAPSHOTS=1; npm test)
// and look at the new files before committing them.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { BODY_SVG } from './bodySvg.ts';
import {
  figureColours, figureOf, figureSvgText, legendRows, levelFill, listRows, musclesIn, paintFigure, parseSvg, referenceMarker,
  type FigureMap, type FigureTheme, type FigureView,
} from './figure.ts';
import { MUSCLE_IDS, type MuscleId } from './library.ts';
import { recoveryMapAt, type RecoveryMap } from './read.ts';
import { C, EXERCISES, fixture, loadWindow, MUSCLES, T0, type FixtureWorkout } from './testRows.ts';
import { libraryFromRows } from './workoutLoads.ts';

const VIEWS: FigureView[] = ['front', 'back'];
const asset = (view: FigureView) => readFileSync(new URL(`../../../../assets/body-${view}.svg`, import.meta.url), 'utf8');
const FIGURES = { front: figureOf(asset('front')), back: figureOf(asset('back')) };

const { lib, keyOf } = libraryFromRows(EXERCISES, MUSCLES);
const H0 = T0 / 3_600_000;
const mapAt = (workouts: FixtureWorkout[], pbs: unknown, h: number): RecoveryMap =>
  recoveryMapAt({ c: C, lib }, keyOf, loadWindow(workouts, pbs as never), H0 + h);

// page backgrounds behind the snapshots, for viewing only (the app's light and night surfaces)
const PAGE: Record<FigureTheme, string> = { light: '#ffffff', dark: '#1a1a19' };
const SNAPSHOTS = new URL('./__snapshots__/', import.meta.url);

function matchSnapshot(name: string, text: string) {
  const file = new URL(`${name}.svg`, SNAPSHOTS);
  if (process.env.UPDATE_SNAPSHOTS) {
    mkdirSync(SNAPSHOTS, { recursive: true });
    writeFileSync(file, text);
    return;
  }
  assert.ok(existsSync(file), `no snapshot ${name}.svg yet: run UPDATE_SNAPSHOTS=1 npm test, then look at it`);
  assert.equal(text, readFileSync(file, 'utf8'), `${name}.svg changed; if that is intended, run UPDATE_SNAPSHOTS=1 npm test`);
}

const snapshot = (name: string, view: FigureView, map: FigureMap, theme: FigureTheme) =>
  matchSnapshot(name, figureSvgText(FIGURES[view], paintFigure(FIGURES[view], map, theme, C), PAGE[theme]));

describe('the SVG figure', () => {
  test('all 17 muscle IDs appear across the two views', () => {
    const shown = new Set(VIEWS.flatMap((v) => musclesIn(FIGURES[v])));
    assert.deepEqual([...shown].sort(), [...MUSCLE_IDS].sort());
  });

  test('no element id repeats, within a view or across the two', () => {
    const ids = VIEWS.flatMap((v) => {
      const all: string[] = [];
      const walk = (n: ReturnType<typeof parseSvg>) => n.children.forEach((c) => { if (c.attrs.id) all.push(c.attrs.id); walk(c); });
      const svg = parseSvg(asset(v));
      if (svg.attrs.id) all.push(svg.attrs.id);
      walk(svg);
      return all;
    });
    assert.equal(new Set(ids).size, ids.length, `repeated: ${ids.filter((id, i) => ids.indexOf(id) !== i).join(', ')}`);
    for (const v of VIEWS) for (const s of FIGURES[v].shapes) if (s.id) assert.ok(s.id.startsWith(`${v}-`), s.id);
  });

  test('every region has a muscle and a side; silhouette shapes have neither', () => {
    for (const v of VIEWS) {
      const regions = FIGURES[v].shapes.filter((s) => s.muscle);
      const silhouette = FIGURES[v].shapes.filter((s) => s.silhouette);
      assert.ok(regions.length > 0 && silhouette.length > 0, v);
      for (const s of regions) assert.ok(['left', 'right', 'both'].includes(s.side!), s.key);   // both: one shape across the midline
      for (const s of silhouette) assert.equal(s.muscle, null, s.key);
    }
    assert.deepEqual(musclesIn(FIGURES.front), ['chest', 'traps', 'front_delts', 'side_delts', 'biceps', 'forearms', 'abs', 'obliques', 'quads', 'adductors', 'calves']);
  });

  test('the app\'s embedded copy is the SVG files, byte for byte', () => {
    for (const v of VIEWS) assert.equal(BODY_SVG[v], asset(v), `${v}: run npm run gen:body-figure`);
  });

  test('a figure that breaks the contract is refused', () => {
    const wrap = (inner: string) => `<svg viewBox="0 0 10 10">${inner}</svg>`;
    assert.throws(() => figureOf(wrap('<path data-muscle="pecs" data-side="left" d="M0 0"/>')), /unknown muscle/);
    assert.throws(() => figureOf(wrap('<path data-muscle="chest" d="M0 0"/>')), /data-side/);
    assert.throws(() => figureOf(wrap('<path data-muscle="chest" data-side="left" data-role="silhouette" d="M0 0"/>')), /silhouette/);
    assert.throws(() => figureOf(wrap('<g transform="scale(2)"><path d="M0 0"/></g>')), /transform/);
    assert.throws(() => figureOf(wrap('<use href="#x"/>')), /unexpected <use>/);
    assert.throws(() => parseSvg('<svg><g></svg>'), /does not close/);
  });
});

describe('painting', () => {
  const extreme = Object.fromEntries(MUSCLE_IDS.map((id) => [id, { level: 5, label: 'Extreme', fill: C.levels[5].fill!, fill_dark: C.levels[5].fill_dark! }])) as FigureMap;

  test('silhouette only ever takes silhouette_fill(_dark), even with every muscle at Extreme', () => {
    for (const theme of ['light', 'dark'] as const) {
      for (const v of VIEWS) {
        const painted = paintFigure(FIGURES[v], extreme, theme, C);
        FIGURES[v].shapes.forEach((s, i) => {
          if (s.silhouette) assert.equal(painted[i].attrs.fill, figureColours(C, theme).silhouette, s.key);
          if (s.muscle) {
            assert.equal(painted[i].attrs.fill, theme === 'dark' ? C.levels[5].fill_dark : C.levels[5].fill, s.key);
            assert.equal(painted[i].attrs.stroke, theme === 'dark' ? C.region_stroke_dark : C.region_stroke, s.key);
          }
        });
      }
    }
  });

  test('regions at level 0, or with no map yet, take the ready colour; geometry is untouched', () => {
    for (const theme of ['light', 'dark'] as const) {
      const painted = paintFigure(FIGURES.back, null, theme, C);
      FIGURES.back.shapes.forEach((s, i) => {
        if (s.muscle) assert.equal(painted[i].attrs.fill, theme === 'dark' ? C.ready_fill_dark : C.ready_fill);
        assert.equal(painted[i].attrs.d, s.attrs.d);
      });
    }
    assert.equal(levelFill(C, 0, 'light'), C.ready_fill);
    assert.equal(levelFill(C, 4, 'dark'), C.levels[4].fill_dark);
  });
});

describe('snapshots', () => {
  const f26 = fixture('F26');
  const f26Map = mapAt(f26.inputs.workouts as FixtureWorkout[], f26.inputs.history, 68);

  for (const theme of ['light', 'dark'] as const) {
    for (const v of VIEWS) {
      test(`F26 at Wednesday 20:00, ${v}, ${theme}`, () => snapshot(`f26-${v}-${theme}`, v, f26Map, theme));
    }
  }

  test('F26: the regions take the preview image\'s colours', () => {
    const want: Partial<Record<MuscleId, number>> = { hamstrings: 4, quads: 3, glutes: 3, biceps: 3, traps: 3, chest: 1, lats: 2, front_delts: 0 };
    for (const [id, level] of Object.entries(want) as [MuscleId, number][]) assert.equal(f26Map[id].fill, levelFill(C, level, 'light'), id);
  });

  const f20 = fixture('F20');
  const push: FixtureWorkout[] = [{ start: -1, end: 0, exercises: f20.inputs.exercises as FixtureWorkout['exercises'] }];
  const chest = { 0: 'High', 24: 'Moderate', 48: 'Low' } as const;   // F23
  for (const h of [0, 24, 48] as const) {
    test(`F20 push day at ${h} h: chest ${chest[h]}`, () => {
      const map = mapAt(push, f20.inputs.history, h);
      assert.equal(map.chest.label, chest[h]);
      for (const v of VIEWS) snapshot(`f20-${h}h-${v}-light`, v, map, 'light');
    });
  }
});

describe('legend, list and tap detail', () => {
  test('the legend is the six levels of the constants, with F ranges and advice', () => {
    const rows = legendRows(C, 'light', 'recovery');
    assert.deepEqual(rows.map((r) => [r.label, r.range]), [
      ['Ready', 'F < 0.25'], ['Low', '0.25 – 0.75'], ['Moderate', '0.75 – 1.5'],
      ['High', '1.5 – 2.5'], ['Very high', '2.5 – 4.0'], ['Extreme', '≥ 4.0'],
    ]);
    assert.equal(rows[2].advice, 'Can train; expect slightly lower performance');
    assert.equal(rows[0].fill, C.ready_fill);
    assert.equal(legendRows(C, 'dark', 'session')[0].range, 'L < 0.25');
    assert.equal(legendRows(C, 'dark', 'session')[0].fill, C.ready_fill_dark);
  });

  test('the list is every muscle, highest first, Ready at the bottom', () => {
    const f26 = fixture('F26');
    const rows = listRows(mapAt(f26.inputs.workouts as FixtureWorkout[], f26.inputs.history, 68), 'recovery');
    assert.equal(rows.length, 17);
    assert.deepEqual(rows.slice(0, 5).map((r) => r.muscle), ['hamstrings', 'quads', 'glutes', 'biceps', 'traps']);
    assert.deepEqual(rows.slice(0, 2).map((r) => [r.value.toFixed(2), r.label, r.trainable, r.ready]),
      [['2.56', 'Very high', '1.0 days', '2.2 days'], ['2.43', 'High', '22 h', '2.2 days']]);
    const firstReady = rows.findIndex((r) => r.level === 0);
    assert.ok(rows.slice(firstReady).every((r) => r.level === 0));
  });

  test('provisional references are marked', () => {
    assert.deepEqual(['monthly', 'lapsed', 'estimated', 'calibration', 'not needed'].map(referenceMarker),
      [null, null, 'estimated', 'calibrating', null]);
  });
});
