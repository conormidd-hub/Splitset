import { addDays, format, parseISO } from 'date-fns';
import { SymbolView } from 'expo-symbols';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, View, type LayoutChangeEvent, type ViewStyle } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withSequence, withTiming } from 'react-native-reanimated';

import { usePlanRange, type PlanSession } from '@/api/plan';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { T } from '@/components/ui/T';
import { isoDate, weekStartIso } from '@/lib/dates';
import { ICONS } from '@/lib/icons';
import { KIND_ICON, monthGrid, planKind, type Session, type SessionKind, type Streak } from '@/lib/streaks';
import { useTheme } from '@/theme/ThemeProvider';
import type { Palette } from '@/theme/tokens';
import { heat, radius, space } from '@/theme/tokens';

type Props = {
  /** The day in focus; the month shown is its month. */
  cursor: string;
  today: string;
  /** What happened, by day. */
  byDay: Map<string, Session[]>;
  streak: Streak;
  /** Week start → that week's number in the current streak. */
  streakNo: Map<string, number>;
  /** The plan shows eight weeks ahead; the month view goes no further. */
  weeksAhead: number;
  earliest: string;
  onCursor: (iso: string) => void;
  /** A day was tapped: open it. */
  onPickDay: (iso: string) => void;
};

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const GUTTER = 34;
const GAP = 4;
const CELL_MAX = 44;
const HEAD_H = 18;
const FOOT_H = 44;

type Month = { year: number; month0: number };
const monthOf = (iso: string): Month => ({ year: parseInt(iso.slice(0, 4), 10), month0: parseInt(iso.slice(5, 7), 10) - 1 });
const monthKey = (m: Month) => `${m.year}-${String(m.month0 + 1).padStart(2, '0')}`;
const shiftMonth = (iso: string, by: number) => isoDate(new Date(parseInt(iso.slice(0, 4), 10), parseInt(iso.slice(5, 7), 10) - 1 + by, 1));

/** The colour a kind of session gets, the same as the week view's left bars. */
function kindColour(palette: Palette, kind: SessionKind): string {
  switch (kind) {
    case 'run': return palette.accent;
    case 'lift': return palette.amber;
    case 'ride': return palette.blue;
    case 'swim': return palette.aqua;
    case 'walk': return palette.aqua2;
    default: return palette.ink2;
  }
}

/** What a day's cell shows, worked out from what was done and what was planned. */
type DayFace =
  | { kind: 'done'; icon: SessionKind; extra: number }
  | { kind: 'planned'; icon: SessionKind; extra: number }
  | { kind: 'missed'; icon: SessionKind }
  | { kind: 'skipped'; icon: SessionKind }
  | { kind: 'empty' };

function faceOf(date: string, today: string, done: Session[], plans: PlanSession[]): DayFace {
  const real = plans.filter((p) => p.type !== 'rest');
  // a session ticked off by hand, with no synced activity behind it, still counts as done
  const byHand = real.filter((p) => p.status === 'done' && !p.activity_id);
  const open = real.filter((p) => p.status === 'planned');
  const doneCount = done.length + byHand.length;
  if (doneCount) {
    const icon = done[0]?.kind ?? planKind(byHand[0].type) ?? 'other';
    return { kind: 'done', icon, extra: doneCount - 1 + (date >= today ? open.length : 0) };
  }
  if (open.length) {
    const icon = planKind(open[0].type) ?? 'other';
    return date < today ? { kind: 'missed', icon } : { kind: 'planned', icon, extra: open.length - 1 };
  }
  const skipped = real.find((p) => p.status === 'skipped');
  if (skipped) return { kind: 'skipped', icon: planKind(skipped.type) ?? 'other' };
  return { kind: 'empty' };
}

/**
 * The month: the same days the week view shows, seven across, a workout's icon on the day it
 * happened, a dashed outline where one is planned, a red dot where one was missed. Down the
 * left, the streak: a red flame and its number on every week that is part of it, joined by a
 * path that runs down the gutter and into the counter. Tap a day to open it.
 */
export function MonthView({ cursor, today, byDay, streak, streakNo, weeksAhead, earliest, onCursor, onPickDay }: Props) {
  const { palette } = useTheme();
  const month = monthOf(cursor);
  const key = monthKey(month);
  const weeks = useMemo(() => monthGrid(month.year, month.month0), [month.year, month.month0]);
  const from = weeks[0][0].date;
  const to = weeks[weeks.length - 1][6].date;
  const plan = usePlanRange(from, to);
  const planByDay = useMemo(() => {
    const m = new Map<string, PlanSession[]>();
    for (const p of plan.data ?? []) m.set(p.date, [...(m.get(p.date) ?? []), p]);
    return m;
  }, [plan.data]);

  const thisWeek = weekStartIso(parseISO(today));
  const latestKey = monthKey(monthOf(isoDate(addDays(parseISO(thisWeek), 7 * weeksAhead))));
  const canPrev = key > monthKey(monthOf(earliest));
  const canNext = key < latestKey;
  const isCurrent = key === monthKey(monthOf(today));

  // ---------------------------------------------------------------- the streak down the gutter
  // which rows are in the streak, in order, and whether the chain runs on past either edge
  const rows = weeks.map((w) => ({ start: w[0].date, no: streakNo.get(w[0].date) ?? null }));
  const chainRows = rows.map((r, i) => (r.no ? i : -1)).filter((i) => i >= 0);
  const first = chainRows.length ? chainRows[0] : -1;
  const last = chainRows.length ? chainRows[chainRows.length - 1] : -1;
  const lastNo = last >= 0 ? rows[last].no ?? 0 : 0;
  const endsHere = last >= 0 && lastNo === streak.weeks;      // the newest streak week is on this page
  const fromAbove = first >= 0 && (rows[first].no ?? 0) > 1;  // older weeks lie in earlier months
  const days = weeks.flat().filter((c) => c.inMonth && c.date <= today);
  const active = days.filter((c) => byDay.has(c.date)).length;

  const [width, setWidth] = useState(0);
  const cellW = width > 0 ? Math.min(CELL_MAX, Math.floor((width - GUTTER - GAP * 6) / 7)) : 0;
  const rowH = cellW;
  const rowCentre = (i: number) => HEAD_H + i * (rowH + GAP) + rowH / 2;
  const gridH = HEAD_H + weeks.length * (rowH + GAP) - GAP;
  const footCentre = gridH + FOOT_H / 2;
  // the path: from the first streak row (or the top edge) down to the last (or the bottom edge),
  // then along the footer to the counter when the chain ends on this page
  const pathTop = first < 0 ? 0 : fromAbove ? 0 : rowCentre(first);
  const pathBottom = last < 0 ? 0 : endsHere ? footCentre : gridH + 8;
  const pathLen = Math.max(0, pathBottom - pathTop);

  return (
    <View style={{ gap: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Arrow dir="prev" enabled={canPrev} onPress={() => onCursor(shiftMonth(cursor, -1))} />
        <T variant="h2" align="center" style={{ flex: 1 }}>{format(new Date(month.year, month.month0, 1), 'MMMM yyyy')}</T>
        <Arrow dir="next" enabled={canNext} onPress={() => onCursor(shiftMonth(cursor, 1))} />
        {!isCurrent ? <Button title="This month" variant="ghost" small onPress={() => onCursor(today)} /> : null}
      </View>

      <Card subtitle={days.length ? `${active} of ${days.length} days with a workout` : undefined}>
        <View onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)} style={{ height: cellW > 0 ? gridH + FOOT_H : undefined }}>
          {cellW > 0 ? (
            <>
              <StreakPath key={`${key}:${chainRows.join(',')}:${endsHere}`} top={pathTop} length={pathLen} endsHere={endsHere} fromAbove={fromAbove} gutter={GUTTER} footCentre={footCentre} width={width} />

              <View style={{ position: 'absolute', left: GUTTER, top: 0, right: 0, flexDirection: 'row', height: HEAD_H }}>
                {WEEKDAYS.map((d, i) => (
                  <T key={i} variant="tiny" tone="mut" align="center" style={{ width: cellW, marginRight: i < 6 ? GAP : 0 }}>{d}</T>
                ))}
              </View>

              {/* keyed by month too, so a week shared by two months replays its flame with the path */}
              {weeks.map((week, wi) => (
                <View key={`${key}:${week[0].date}`} style={{ position: 'absolute', left: 0, right: 0, top: HEAD_H + wi * (rowH + GAP), height: rowH, flexDirection: 'row' }}>
                  <View style={{ width: GUTTER, alignItems: 'center', justifyContent: 'center' }}>
                    {rows[wi].no ? <GutterFlame n={rows[wi].no as number} order={chainRows.indexOf(wi)} of={chainRows.length} /> : null}
                  </View>
                  {week.map((cell, ci) => {
                    if (!cell.inMonth) return <View key={cell.date} style={{ width: cellW, marginRight: ci < 6 ? GAP : 0 }} />;
                    const done = byDay.get(cell.date) ?? [];
                    const plans = planByDay.get(cell.date) ?? [];
                    const face = faceOf(cell.date, today, done, plans);
                    const isToday = cell.date === today;
                    const isCursor = cell.date === cursor;
                    const future = cell.date > today;
                    const tint = face.kind === 'done' ? kindColour(palette, face.icon) : face.kind === 'planned' ? palette.accent : palette.mut;
                    const label = [
                      format(parseISO(cell.date), 'EEEE d MMMM'),
                      done.length ? `${done.length} workout${done.length === 1 ? '' : 's'}` : null,
                      face.kind === 'planned' ? 'planned' : face.kind === 'missed' ? 'missed' : face.kind === 'skipped' ? 'skipped' : null,
                    ].filter(Boolean).join(', ');
                    return (
                      <Pressable
                        key={cell.date}
                        onPress={() => onPickDay(cell.date)}
                        accessibilityRole="button"
                        accessibilityLabel={label}
                        accessibilityHint="Opens the day"
                        style={({ pressed }) => ({
                          width: cellW, height: rowH, marginRight: ci < 6 ? GAP : 0, borderRadius: radius.sm,
                          backgroundColor: isCursor && !isToday ? palette.accentSoft : face.kind === 'done' ? palette.surface2 : 'transparent',
                          borderWidth: isToday ? 1.5 : face.kind === 'planned' ? 1 : 0,
                          borderStyle: face.kind === 'planned' && !isToday ? 'dashed' : 'solid',
                          borderColor: isToday ? palette.accent : palette.accentLine,
                          alignItems: 'center', justifyContent: 'center',
                          opacity: pressed ? 0.7 : future && face.kind === 'empty' ? 0.45 : 1,
                        })}>
                        <T variant="tiny" tone={isToday ? 'accent' : face.kind === 'done' ? 'ink2' : 'mut'} weight={isToday ? '800' : undefined} style={{ position: 'absolute', top: 2, left: 4 }}>
                          {parseInt(cell.date.slice(8, 10), 10)}
                        </T>
                        {face.kind !== 'empty' ? (
                          <SymbolView
                            name={KIND_ICON[face.icon]}
                            tintColor={tint}
                            size={16}
                            style={{ marginTop: 6, opacity: face.kind === 'skipped' ? 0.35 : face.kind === 'missed' ? 0.6 : 1 }}
                          />
                        ) : null}
                        {(face.kind === 'done' || face.kind === 'planned') && face.extra > 0 ? (
                          <View style={{ position: 'absolute', right: 2, bottom: 2, backgroundColor: face.kind === 'done' ? palette.accent : palette.surface3, borderRadius: radius.pill, paddingHorizontal: 4, minWidth: 16, alignItems: 'center' }}>
                            <T variant="tiny" tone={face.kind === 'done' ? 'onAccent' : 'ink2'} weight="800">+{face.extra}</T>
                          </View>
                        ) : null}
                        {face.kind === 'missed' ? (
                          <View style={{ position: 'absolute', left: 4, bottom: 4, width: 6, height: 6, borderRadius: 3, backgroundColor: palette.neg }} />
                        ) : null}
                      </Pressable>
                    );
                  })}
                </View>
              ))}

              <View style={{ position: 'absolute', left: 0, right: 0, top: gridH, height: FOOT_H, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' }}>
                {endsHere ? (
                  <StreakCounter key={key} streak={streak} />
                ) : last >= 0 ? (
                  <Pressable onPress={() => onCursor(shiftMonth(cursor, 1))} disabled={!canNext} accessibilityRole="button" accessibilityLabel="The streak continues next month">
                    <T variant="tiny" tone="mut">streak continues ›</T>
                  </Pressable>
                ) : null}
              </View>
            </>
          ) : null}
        </View>
      </Card>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md }}>
        <Key swatch={{ backgroundColor: palette.surface2 }} label="done" />
        <Key swatch={{ borderWidth: 1, borderStyle: 'dashed', borderColor: palette.accentLine }} label="planned" />
        <Key swatch={{ backgroundColor: palette.neg }} dot label="missed" />
        <Key swatch={{ borderWidth: 1.5, borderColor: palette.accent }} label="today" />
        <Key swatch={{ backgroundColor: heat.ember }} dot label="streak week" />
      </View>
    </View>
  );
}

/**
 * The line that joins the streak's weeks: drawn top to bottom when the month opens, then along
 * the footer into the counter. A soft glow under a thin line, nothing more.
 */
function StreakPath({ top, length, endsHere, fromAbove, gutter, footCentre, width }: { top: number; length: number; endsHere: boolean; fromAbove: boolean; gutter: number; footCentre: number; width: number }) {
  const reduced = useReducedMotion();
  const p = useSharedValue(0);
  useEffect(() => {
    if (reduced) {
      p.set(1);
      return;
    }
    p.set(0);
    p.set(withTiming(1, { duration: 900, easing: Easing.out(Easing.cubic) }));
  }, [p, reduced]);
  const vertical = useAnimatedStyle(() => ({ transform: [{ scaleY: Math.min(1, p.get() / 0.7) }] }));
  const horizontal = useAnimatedStyle(() => ({ transform: [{ scaleX: Math.max(0, Math.min(1, (p.get() - 0.7) / 0.3)) }] }));
  if (length <= 0) return null;
  const x = gutter / 2;
  // the horizontal run stops short of the counter, which sits at the right edge of the footer
  const acrossW = Math.max(0, width - x - 150);
  return (
    <>
      <Animated.View style={[{ position: 'absolute', left: x - 3, top, width: 6, height: length, borderRadius: 3, backgroundColor: heat.ember, opacity: 0.12, transformOrigin: 'top' }, vertical]} />
      <Animated.View style={[{ position: 'absolute', left: x - 1, top, width: 2, height: length, borderRadius: 1, backgroundColor: heat.ember, opacity: fromAbove ? 0.55 : 0.7, transformOrigin: 'top' }, vertical]} />
      {endsHere ? (
        <>
          <Animated.View style={[{ position: 'absolute', left: x, top: footCentre - 3, width: acrossW, height: 6, borderRadius: 3, backgroundColor: heat.ember, opacity: 0.12, transformOrigin: 'left' }, horizontal]} />
          <Animated.View style={[{ position: 'absolute', left: x, top: footCentre - 1, width: acrossW, height: 2, borderRadius: 1, backgroundColor: heat.ember, opacity: 0.7, transformOrigin: 'left' }, horizontal]} />
        </>
      ) : null}
    </>
  );
}

/** A week's flame in the gutter: it appears as the path reaches it, then breathes, barely. */
function GutterFlame({ n, order, of }: { n: number; order: number; of: number }) {
  const reduced = useReducedMotion();
  const pulse = useSharedValue(1);
  const show = useSharedValue(0);
  useEffect(() => {
    if (reduced) {
      show.set(1);
      pulse.set(1);
      return;
    }
    // the path takes 630 ms to run the gutter; each flame lights as it passes
    show.set(0);
    const delay = 80 + (of > 1 ? (order / (of - 1)) * 550 : 0);
    show.set(withSequence(withTiming(0, { duration: delay }), withTiming(1, { duration: 220 })));
    pulse.set(withRepeat(withSequence(withTiming(1.1, { duration: 1100 + order * 90, easing: Easing.inOut(Easing.quad) }), withTiming(0.96, { duration: 1100 + order * 90, easing: Easing.inOut(Easing.quad) })), -1, true));
  }, [reduced, order, of, pulse, show]);
  const style = useAnimatedStyle(() => ({ opacity: show.get(), transform: [{ scale: pulse.get() }] }));
  return (
    <Animated.View style={[{ alignItems: 'center', justifyContent: 'center', gap: 0 }, style]} accessibilityLabel={`Streak week ${n}`}>
      <SymbolView name={ICONS.flame} tintColor={heat.ember} size={16} />
      <T variant="tiny" weight="800" style={{ color: heat.ember, fontVariant: ['tabular-nums'], marginTop: -2 }}>{n}</T>
    </Animated.View>
  );
}

/** Where the path ends: the whole streak in one pill. */
function StreakCounter({ streak }: { streak: Streak }) {
  const { palette } = useTheme();
  const reduced = useReducedMotion();
  const show = useSharedValue(0);
  useEffect(() => {
    if (reduced) {
      show.set(1);
      return;
    }
    show.set(0);
    show.set(withSequence(withTiming(0, { duration: 650 }), withTiming(1, { duration: 260, easing: Easing.out(Easing.quad) })));
  }, [reduced, show]);
  const style = useAnimatedStyle(() => ({ opacity: show.get(), transform: [{ scale: 0.92 + 0.08 * show.get() }] }));
  return (
    <Animated.View style={[{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: palette.surface2, borderColor: heat.ember, borderWidth: 1.5, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 6 }, style]}>
      <SymbolView name={ICONS.flame} tintColor={heat.ember} size={18} />
      <T variant="h3" weight="800" style={{ color: heat.ember, fontVariant: ['tabular-nums'] }}>{streak.weeks}{streak.capped ? '+' : ''}</T>
      <T variant="small" tone="ink2">week{streak.weeks === 1 && !streak.capped ? '' : 's'}</T>
    </Animated.View>
  );
}

function Arrow({ dir, enabled, onPress }: { dir: 'prev' | 'next'; enabled: boolean; onPress: () => void }) {
  const { palette } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={!enabled}
      accessibilityRole="button"
      accessibilityLabel={dir === 'prev' ? 'Previous month' : 'Next month'}
      style={({ pressed }) => ({ width: 36, height: 36, borderRadius: 18, backgroundColor: palette.surface2, alignItems: 'center', justifyContent: 'center', opacity: !enabled ? 0.3 : pressed ? 0.7 : 1 })}>
      <T variant="h2" tone="ink2">{dir === 'prev' ? '‹' : '›'}</T>
    </Pressable>
  );
}

function Key({ swatch, dot, label }: { swatch: ViewStyle; dot?: boolean; label: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <View style={[dot ? { width: 8, height: 8, borderRadius: 4 } : { width: 14, height: 14, borderRadius: 4 }, swatch]} />
      <T variant="tiny" tone="mut">{label}</T>
    </View>
  );
}
