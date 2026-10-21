import { addDays, format, parseISO } from 'date-fns';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { Animated, Pressable, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector, ScrollView } from 'react-native-gesture-handler';

import { isRun, type ActivityListRow } from '@/api/activities';
import { useActivitiesBetween, useMovePlanSession, usePlanRange, useWorkoutActivityIds, type PlanSession } from '@/api/plan';
import { usePlanPush } from '@/api/sync';
import { ActivityCard, SessionCard, watchState } from '@/components/plan/CalendarCards';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Chip';
import { ErrorBanner, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { isoDate, weekStartIso } from '@/lib/dates';
import { ICONS } from '@/lib/icons';
import { formatDistance, type Units } from '@/lib/units';
import { useTheme } from '@/theme/ThemeProvider';
import { heat, radius, space } from '@/theme/tokens';

export const WEEKS_AHEAD = 8;
const LABEL_W = 46;       // the day column
const EDGE = 64;          // drag this close to the top or bottom and the list scrolls
const SCROLL_STEP = 14;   // px per tick while it does

type Day = { sessions: PlanSession[]; extras: ActivityListRow[] };
type Drag = { session: PlanSession };

type Props = {
  /** The day in focus: the list opens on its week and flashes it. */
  cursor: string;
  /** Bumped to scroll to the cursor again even when it has not changed (the Today button). */
  jump: number;
  today: string;
  units: Units;
  pushOn: boolean;
  /** Week start → that week's number in the current streak. */
  streakNo: Map<string, number>;
  /** A week's dates were tapped: show that month. */
  onOpenMonth: (weekStart: string) => void;
  /** A day's date was tapped: open that day. */
  onPickDay: (iso: string) => void;
};

/**
 * The plan week by week: seven days each, rest days included, with what was planned, what was
 * done and what was done unplanned. Hold a planned session and drag it to another day to move
 * it; the next sync moves it on the watch too.
 */
export function WeekView({ cursor, jump, today, units, pushOn, streakNo, onOpenMonth, onPickDay }: Props) {
  const thisWeek = weekStartIso(parseISO(today));
  const [weeksBack, setWeeksBack] = useState(4);
  const from = isoDate(addDays(parseISO(thisWeek), -7 * weeksBack));
  const to = isoDate(addDays(parseISO(thisWeek), 7 * (WEEKS_AHEAD + 1) - 1));

  const polling = usePlanPush((st) => st.polling);
  const plan = usePlanRange(from, to, {
    pollWhile: (rows) => polling && rows.some((s) => { const w = watchState(s, pushOn, today); return w === 'sending' || w === 'removing'; }),
  });
  const actuals = useActivitiesBetween(from, to);
  const viaWorkouts = useWorkoutActivityIds(from, to);
  const move = useMovePlanSession();

  const weeks = Array.from({ length: weeksBack + WEEKS_AHEAD + 1 }, (_, i) => isoDate(addDays(parseISO(from), 7 * i)));
  const { byDay, activityById } = useMemo(() => {
    // an activity shows once: under the session it fulfilled, or the app workout that logged it
    const linked = new Set([...(plan.data ?? []).map((s) => s.activity_id).filter(Boolean), ...(viaWorkouts.data ?? [])]);
    const days = new Map<string, Day>();
    const day = (d: string) => days.get(d) ?? days.set(d, { sessions: [], extras: [] }).get(d)!;
    for (const s of plan.data ?? []) day(s.date).sessions.push(s);
    for (const a of actuals.data ?? []) if (!linked.has(a.id)) day(a.start_time_local.slice(0, 10)).extras.push(a);
    return { byDay: days, activityById: new Map((actuals.data ?? []).map((a) => [a.id, a])) };
  }, [plan.data, actuals.data, viaWorkouts.data]);

  // ---------------------------------------------------------------- layout, for drop targets
  // Positions are measured when they're needed, never kept from onLayout: on the web onLayout
  // only fires when a view changes size, so a week pushed down by the weeks above it loading
  // would keep its old position.
  const scrollRef = useRef<ScrollView>(null);
  const wrapRef = useRef<View>(null);
  const view = useRef({ top: 0, height: 0, scrollY: 0, contentH: 0 });
  const weekEls = useRef(new Map<string, View>());                    // week start -> its card
  const rowEls = useRef(new Map<string, View>());                     // date -> its row
  // date -> the row's place in the window, and the list's scroll offset when it was measured
  const rowBox = useRef(new Map<string, { top: number; h: number; scrollY: number }>());
  const opened = useRef(false);

  const measureView = () => wrapRef.current?.measureInWindow((_x, y, _w, h) => { view.current.top = y; view.current.height = h; });
  const measureRows = () => {
    rowBox.current = new Map();
    for (const [d, el] of rowEls.current) {
      el.measureInWindow((_x, top, _w, h) => rowBox.current.set(d, { top, h, scrollY: view.current.scrollY }));
    }
  };
  // undefined until the rows have been measured
  const dayAt = (absoluteY: number): string | null | undefined => {
    if (!rowBox.current.size) return undefined;
    for (const [d, r] of rowBox.current) {
      const top = r.top - (view.current.scrollY - r.scrollY);
      if (absoluteY >= top && absoluteY < top + r.h) return d;
    }
    return null;
  };
  const scrollToWeek = (start: string, animated: boolean) => {
    const week = weekEls.current.get(start);
    wrapRef.current?.measureInWindow((_x, top) => week?.measureInWindow((_x2, y) => {
      scrollRef.current?.scrollTo({ y: Math.max(0, view.current.scrollY + y - top - space.sm), animated });
    }));
  };

  // ---------------------------------------------------------------- drag and drop
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [ghostTop] = useState(() => new Animated.Value(0));
  const pointer = useRef(0);
  const grab = useRef(0);
  const autoScroll = useRef<ReturnType<typeof setInterval> | null>(null);
  const suppressTap = useRef(false);

  // open on the cursor's week once the sessions are in; later jumps (Today, a day picked in
  // another view) open enough weeks, scroll there and flash the day. All of it a tick later,
  // off the effect itself, so the state changes never cascade
  const loaded = !!plan.data && !!actuals.data;
  const jumpTo = useEffectEvent((date: string) => {
    const wk = weekStartIso(parseISO(date));
    let back = 0;
    for (let w = thisWeek; w > wk; w = isoDate(addDays(parseISO(w), -7))) back++;
    const more = back > weeksBack;
    if (more) setWeeksBack(back + 1);
    const firstTime = !opened.current;
    opened.current = true;
    if (!firstTime || date !== today) {
      setHover(date);
      setTimeout(() => setHover((h) => (h === date ? null : h)), 1800);
    }
    setTimeout(() => scrollToWeek(wk, !firstTime), more ? 300 : firstTime ? 0 : 60);
  });
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => jumpTo(cursor), 0);
    return () => clearTimeout(t);
  }, [loaded, cursor, jump]);

  const stopAutoScroll = () => {
    if (autoScroll.current) clearInterval(autoScroll.current);
    autoScroll.current = null;
  };
  const onDragStart = (session: PlanSession, grabY: number, absoluteY: number) => {
    measureView();
    measureRows();
    suppressTap.current = true;
    pointer.current = absoluteY;
    grab.current = grabY;
    ghostTop.setValue(absoluteY - view.current.top - grabY);
    setDrag({ session });
    setHover(session.date);
  };
  const onDragMove = (absoluteY: number) => {
    pointer.current = absoluteY;
    ghostTop.setValue(absoluteY - view.current.top - grab.current);
    const d = dayAt(absoluteY);
    if (d !== undefined) setHover((prev) => (prev === d ? prev : d));
    const rel = absoluteY - view.current.top;
    const dir = rel < EDGE ? -1 : rel > view.current.height - EDGE ? 1 : 0;
    if (dir && !autoScroll.current) {
      autoScroll.current = setInterval(() => {
        const v = view.current;
        const max = Math.max(0, v.contentH - v.height);
        const next = Math.min(max, Math.max(0, v.scrollY + dir * SCROLL_STEP));
        if (next === v.scrollY) return;
        v.scrollY = next;
        scrollRef.current?.scrollTo({ y: next, animated: false });
        const d2 = dayAt(pointer.current);
        if (d2 !== undefined) setHover((prev) => (prev === d2 ? prev : d2));
      }, 16);
    } else if (!dir) {
      stopAutoScroll();
    }
  };
  const onDragEnd = (session: PlanSession, absoluteY: number, dropped: boolean) => {
    stopAutoScroll();
    const target = dropped ? dayAt(absoluteY) : null;
    if (target && target !== session.date) {
      const last = byDay.get(target)?.sessions.reduce((m, s) => Math.max(m, s.position), -1) ?? -1;
      move.mutate({ id: session.id, date: target, position: last + 1 });
    }
    setDrag(null);
    setHover(null);
    setTimeout(() => { suppressTap.current = false; }, 250);
  };

  const runKm = (start: string) => {
    let done = 0;
    let planned = 0;
    for (let i = 0; i < 7; i++) {
      const d = byDay.get(isoDate(addDays(parseISO(start), i)));
      for (const a of d?.extras ?? []) if (isRun(a.type)) done += a.distance_m ?? 0;
      for (const s of d?.sessions ?? []) {
        if (s.type === 'run') planned += s.target_distance_m ?? 0;
        const a = s.activity_id ? activityById.get(s.activity_id) : undefined;
        if (a && isRun(a.type)) done += a.distance_m ?? 0;
      }
    }
    return { done, planned };
  };

  return (
    <View ref={wrapRef} style={{ flex: 1 }} onLayout={(e: LayoutChangeEvent) => { view.current.height = e.nativeEvent.layout.height; measureView(); }}>
      {plan.error ? <View style={{ paddingHorizontal: space.lg }}><ErrorBanner message={errorMessage(plan.error)} /></View> : null}
      <ScrollView
        ref={scrollRef}
        scrollEnabled={!drag}
        scrollEventThrottle={16}
        onScroll={(e) => { view.current.scrollY = e.nativeEvent.contentOffset.y; }}
        onContentSizeChange={(_w, h) => { view.current.contentH = h; }}
        contentContainerStyle={{ padding: space.lg, paddingTop: space.sm, gap: space.sm, paddingBottom: space.xxl * 2 }}>
        <Button title="Show earlier weeks" variant="ghost" small onPress={() => setWeeksBack((n) => n + 8)} />
        {weeks.map((start) => (
          <WeekCard
            key={start}
            start={start}
            today={today}
            isThisWeek={start === thisWeek}
            byDay={byDay}
            activityById={activityById}
            units={units}
            km={runKm(start)}
            streakNo={streakNo.get(start)}
            hover={hover}
            pushOn={pushOn}
            dragging={drag?.session.id ?? null}
            suppressTap={suppressTap}
            weekRef={(el) => { if (el) weekEls.current.set(start, el); else weekEls.current.delete(start); }}
            rowRef={(d, el) => { if (el) rowEls.current.set(d, el); else rowEls.current.delete(d); }}
            onOpenMonth={onOpenMonth}
            onPickDay={onPickDay}
            onDragStart={onDragStart}
            onDragMove={onDragMove}
            onDragEnd={onDragEnd}
          />
        ))}
        <T variant="small" tone="mut" align="center">Hold a planned session and drag it to another day. Tap a date for the day, the week&apos;s dates for the month.</T>
      </ScrollView>

      {drag ? (
        <Animated.View
          style={{
            position: 'absolute', top: ghostTop, left: space.lg + LABEL_W + 1, right: space.lg + space.sm + 1,
            pointerEvents: 'none', transform: [{ scale: 1.03 }], boxShadow: '0 6px 16px rgba(0, 0, 0, 0.25)', borderRadius: radius.md,
          }}>
          <SessionCard session={drag.session} units={units} past={false} />
        </Animated.View>
      ) : null}
    </View>
  );
}

type WeekProps = {
  start: string;
  today: string;
  isThisWeek: boolean;
  byDay: Map<string, Day>;
  activityById: Map<string, ActivityListRow>;
  units: Units;
  km: { done: number; planned: number };
  /** This week's number in the current streak, when it is part of it. */
  streakNo?: number;
  hover: string | null;
  pushOn: boolean;
  dragging: string | null;
  suppressTap: React.RefObject<boolean>;
  weekRef: (el: View | null) => void;
  rowRef: (day: string, el: View | null) => void;
  onOpenMonth: (weekStart: string) => void;
  onPickDay: (iso: string) => void;
  onDragStart: (s: PlanSession, grab: number, absoluteY: number) => void;
  onDragMove: (absoluteY: number) => void;
  onDragEnd: (s: PlanSession, absoluteY: number, dropped: boolean) => void;
};

function WeekCard({ start, today, isThisWeek, byDay, activityById, units, km, streakNo, hover, pushOn, dragging, suppressTap, weekRef, rowRef, onOpenMonth, onPickDay, ...drag }: WeekProps) {
  const { palette } = useTheme();
  const days = Array.from({ length: 7 }, (_, i) => isoDate(addDays(parseISO(start), i)));
  const a = parseISO(days[0]);
  const b = parseISO(days[6]);
  return (
    <View
      ref={weekRef}
      style={{
        backgroundColor: palette.surface, borderRadius: radius.lg, overflow: 'hidden',
        borderWidth: isThisWeek ? 2 : 1, borderColor: isThisWeek ? palette.accent : palette.hair,
      }}>
      <View style={{ paddingHorizontal: space.md, paddingTop: space.md, paddingBottom: space.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Pressable
            onPress={() => onOpenMonth(start)}
            accessibilityRole="button"
            accessibilityLabel={`${format(a, 'd MMM')} to ${format(b, 'd MMM')}, open the month`}
            style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
            <T variant="h3">{format(a, 'd MMM')} – {format(b, 'd MMM')}</T>
          </Pressable>
          {streakNo ? <StreakWeek n={streakNo} /> : null}
          {isThisWeek ? <Badge label="THIS WEEK" tone="accent" /> : null}
        </View>
        <T variant="small" tone="mut">
          Total: <T variant="small" weight="700">{formatDistance(km.done, units, 1)}</T>
          {km.planned ? ` of ${formatDistance(km.planned, units, 0)} planned` : ''}
        </T>
      </View>
      {days.map((d) => {
        const info = byDay.get(d);
        const isToday = d === today;
        const past = d < today;
        const empty = !info?.sessions.length && !info?.extras.length;
        return (
          <View
            key={d}
            ref={(el) => rowRef(d, el)}
            style={{ flexDirection: 'row', minHeight: 48, borderTopWidth: 1, borderTopColor: palette.hair, backgroundColor: hover === d ? palette.accentSoft : 'transparent' }}>
            <Pressable
              onPress={() => onPickDay(d)}
              accessibilityRole="button"
              accessibilityLabel={`${format(parseISO(d), 'EEEE d MMMM')}, open the day`}
              style={({ pressed }) => ({ width: LABEL_W, alignItems: 'center', justifyContent: 'center', paddingVertical: 6, opacity: pressed ? 0.6 : 1 })}>
              <T variant="label" tone={isToday ? 'accent' : 'mut'}>{format(parseISO(d), 'EEE')}</T>
              <T variant="h3" tone={isToday ? 'accent' : empty ? 'mut' : 'ink'}>{format(parseISO(d), 'd')}</T>
            </Pressable>
            <View style={{ flex: 1, paddingVertical: 6, paddingRight: space.sm, gap: 6, justifyContent: 'center' }}>
              {empty ? (
                <Pressable onPress={() => router.push(`/plan/new?date=${d}`)} accessibilityLabel={`Add a session on ${format(parseISO(d), 'EEEE d MMMM')}`}>
                  <T tone="mut">{hover === d && dragging ? 'Drop here' : 'Rest day'}</T>
                </Pressable>
              ) : null}
              {info?.sessions.map((s) => (
                <DraggableSession key={s.id} session={s} enabled={s.status === 'planned'} suppressTap={suppressTap} {...drag}>
                  <SessionCard
                    session={s}
                    linked={s.activity_id ? activityById.get(s.activity_id) : undefined}
                    units={units}
                    past={past}
                    dimmed={dragging === s.id}
                    watch={watchState(s, pushOn, today)}
                  />
                </DraggableSession>
              ))}
              {info?.extras.map((x) => (
                <Pressable key={x.id} onPress={() => router.push(`/run/${x.id}`, { withAnchor: true })}>
                  <ActivityCard activity={x} units={units} />
                </Pressable>
              ))}
            </View>
          </View>
        );
      })}
    </View>
  );
}

/** The week's place in the streak: a small flame and its number, counting up week by week. */
function StreakWeek({ n }: { n: number }) {
  const { palette } = useTheme();
  return (
    <View
      accessibilityLabel={`Streak week ${n}`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 2, backgroundColor: palette.surface2, borderRadius: radius.pill, paddingHorizontal: 6, paddingVertical: 2 }}>
      <SymbolView name={ICONS.flame} tintColor={heat.ember} size={12} />
      <T variant="tiny" weight="800" style={{ color: heat.ember, fontVariant: ['tabular-nums'] }}>{n}</T>
    </View>
  );
}

function DraggableSession({ session, enabled, suppressTap, onDragStart, onDragMove, onDragEnd, children }: {
  session: PlanSession;
  enabled: boolean;
  suppressTap: React.RefObject<boolean>;
  onDragStart: WeekProps['onDragStart'];
  onDragMove: WeekProps['onDragMove'];
  onDragEnd: WeekProps['onDragEnd'];
  children: React.ReactNode;
}) {
  // a long press picks the card up; plain taps fall through to the Pressable and open it
  const pan = Gesture.Pan()
    .enabled(enabled)
    .activateAfterLongPress(300)
    .runOnJS(true)
    .onStart((e) => onDragStart(session, e.y, e.absoluteY))
    .onUpdate((e) => onDragMove(e.absoluteY))
    .onEnd((e, success) => onDragEnd(session, e.absoluteY, success));
  return (
    <GestureDetector gesture={pan}>
      <Pressable
        onPress={() => { if (!suppressTap.current) router.push(`/plan/${session.id}`); }}
        accessibilityHint={enabled ? 'Hold and drag to move to another day' : undefined}>
        {children}
      </Pressable>
    </GestureDetector>
  );
}
