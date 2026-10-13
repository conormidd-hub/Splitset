import { addDays, format, parseISO } from 'date-fns';
import { router, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { Animated, Pressable, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector, ScrollView } from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';

import { isRun, type ActivityListRow } from '@/api/activities';
import { useActivitiesBetween, useMovePlanSession, usePlanRange, useWorkoutActivityIds, type PlanSession } from '@/api/plan';
import { useUnits } from '@/api/profile';
import { useConnection } from '@/api/connections';
import { useTrainingSessions } from '@/api/streaks';
import { usePlanPush } from '@/api/sync';
import { StreakButton } from '@/components/home/StreakButton';
import { ActivityCard, SessionCard, watchState } from '@/components/plan/CalendarCards';
import { SyncNowBar } from '@/components/sync/SyncNowBar';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Chip';
import { ErrorBanner, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { isoDate, todayIso, weekStartIso } from '@/lib/dates';
import { ICONS } from '@/lib/icons';
import { sessionsFrom, streakWeeks, weekStreak } from '@/lib/streaks';
import { formatDistance, type Units } from '@/lib/units';
import { useTheme } from '@/theme/ThemeProvider';
import { heat, radius, space } from '@/theme/tokens';

const WEEKS_AHEAD = 8;
const LABEL_W = 52;       // the day column
const EDGE = 64;          // drag this close to the top or bottom and the list scrolls
const SCROLL_STEP = 14;   // px per tick while it does

type Day = { sessions: PlanSession[]; extras: ActivityListRow[] };
type Drag = { session: PlanSession };

/**
 * The plan as a calendar: week after week of seven days, rest days included, with what was
 * planned, what was done and what was done unplanned. Hold a planned session and drag it to
 * another day to move it; the next sync moves it on the watch too.
 */
export default function PlanCalendar() {
  const { palette } = useTheme();
  const units = useUnits();
  const today = todayIso();
  const thisWeek = weekStartIso();
  const [weeksBack, setWeeksBack] = useState(4);
  const from = isoDate(addDays(parseISO(thisWeek), -7 * weeksBack));
  const to = isoDate(addDays(parseISO(thisWeek), 7 * (WEEKS_AHEAD + 1) - 1));

  const connection = useConnection();
  const pushOn = !!connection.data?.push_plan && connection.data.status === 'active';
  const polling = usePlanPush((st) => st.polling);
  const plan = usePlanRange(from, to, {
    pollWhile: (rows) => polling && rows.some((s) => { const w = watchState(s, pushOn, today); return w === 'sending' || w === 'removing'; }),
  });
  const actuals = useActivitiesBetween(from, to);
  const viaWorkouts = useWorkoutActivityIds(from, to);
  const move = useMovePlanSession();

  // the streak runs through these weeks: a flame and its number on every week card that is part of it
  const training = useTrainingSessions();
  const { streak, streakNo } = useMemo(() => {
    const sessions = sessionsFrom(training.data?.activities ?? [], training.data?.workouts ?? [], units);
    return {
      streak: weekStreak(sessions, today, training.data?.oldest),
      streakNo: new Map(streakWeeks(sessions, today).map((w, i) => [w, i + 1])),
    };
  }, [training.data, units, today]);

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
  const scrolledToToday = useRef(false);

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
  const scrollToThisWeek = (animated: boolean) => scrollToWeek(thisWeek, animated);
  // open on this week once it and the weeks above it have their sessions
  const loaded = !!plan.data && !!actuals.data;
  const openOnThisWeek = useEffectEvent(() => scrollToThisWeek(false));
  useEffect(() => {
    if (!loaded || scrolledToToday.current) return;
    scrolledToToday.current = true;
    setTimeout(openOnThisWeek, 0);
  }, [loaded]);

  // ---------------------------------------------------------------- drag and drop
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [ghostTop] = useState(() => new Animated.Value(0));
  const pointer = useRef(0);
  const grab = useRef(0);
  const autoScroll = useRef<ReturnType<typeof setInterval> | null>(null);
  const suppressTap = useRef(false);

  // the month view sends people here with ?date=: open enough weeks, scroll to that one, flash the
  // day. It all happens a tick later, off the effect itself, so the state changes never cascade
  const params = useLocalSearchParams<{ date?: string }>();
  const jumpTo = useEffectEvent((date: string) => {
    const wk = weekStartIso(parseISO(date));
    let back = 0;
    for (let w = thisWeek; w > wk; w = isoDate(addDays(parseISO(w), -7))) back++;
    const more = back > weeksBack;
    if (more) setWeeksBack(back + 1);
    scrolledToToday.current = true;
    setHover(date);
    setTimeout(() => scrollToWeek(wk, true), more ? 300 : 60);
    setTimeout(() => setHover((h) => (h === date ? null : h)), 1800);
  });
  useEffect(() => {
    const date = params.date;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const t = setTimeout(() => jumpTo(date), 0);
    return () => clearTimeout(t);
  }, [params.date]);

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
    <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1, backgroundColor: palette.bg }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.sm, gap: space.sm }}>
        <View style={{ flex: 1 }}>
          <T variant="label" tone="mut">Plan</T>
          <T variant="display">Calendar</T>
        </View>
        {training.isSuccess ? <StreakButton streak={streak} compact /> : null}
        <Button title="Today" variant="secondary" small onPress={() => scrollToThisWeek(true)} />
        <Button title="+ Add" small onPress={() => router.push(`/plan/new?date=${today}`)} />
      </View>
      <View style={{ paddingHorizontal: space.lg, paddingBottom: space.xs }}>
        <SyncNowBar />
      </View>
      {plan.error ? <View style={{ paddingHorizontal: space.lg }}><ErrorBanner message={errorMessage(plan.error)} /></View> : null}

      <View ref={wrapRef} style={{ flex: 1 }} onLayout={(e: LayoutChangeEvent) => { view.current.height = e.nativeEvent.layout.height; measureView(); }}>
        <ScrollView
          ref={scrollRef}
          scrollEnabled={!drag}
          scrollEventThrottle={16}
          onScroll={(e) => { view.current.scrollY = e.nativeEvent.contentOffset.y; }}
          onContentSizeChange={(_w, h) => { view.current.contentH = h; }}
          contentContainerStyle={{ padding: space.lg, paddingTop: space.sm, gap: space.md, paddingBottom: space.xxl * 2 }}>
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
              onDragStart={onDragStart}
              onDragMove={onDragMove}
              onDragEnd={onDragEnd}
            />
          ))}
          <T variant="small" tone="mut" align="center">Hold a planned session and drag it to another day.</T>
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
    </SafeAreaView>
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
  onDragStart: (s: PlanSession, grab: number, absoluteY: number) => void;
  onDragMove: (absoluteY: number) => void;
  onDragEnd: (s: PlanSession, absoluteY: number, dropped: boolean) => void;
};

function WeekCard({ start, today, isThisWeek, byDay, activityById, units, km, streakNo, hover, pushOn, dragging, suppressTap, weekRef, rowRef, ...drag }: WeekProps) {
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
      <View style={{ padding: space.lg, paddingBottom: space.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Pressable
            onPress={() => router.push({ pathname: '/calendar', params: { month: start.slice(0, 7), date: start } })}
            accessibilityRole="button"
            accessibilityLabel={`${format(a, 'd MMM')} to ${format(b, 'd MMM')}, open the month view`}
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
            style={{ flexDirection: 'row', minHeight: 54, borderTopWidth: 1, borderTopColor: palette.hair, backgroundColor: hover === d ? palette.accentSoft : 'transparent' }}>
            <View style={{ width: LABEL_W, alignItems: 'center', justifyContent: 'center', paddingVertical: space.sm }}>
              <T variant="label" tone={isToday ? 'accent' : 'mut'}>{format(parseISO(d), 'EEE')}</T>
              <T variant="h3" tone={isToday ? 'accent' : empty ? 'mut' : 'ink'}>{format(parseISO(d), 'd')}</T>
            </View>
            <View style={{ flex: 1, paddingVertical: space.sm, paddingRight: space.sm, gap: 6, justifyContent: 'center' }}>
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
                <Pressable key={x.id} onPress={() => router.push(`/run/${x.id}`)}>
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

/** The week's place in the streak: a small green flame and its number, counting up week by week. */
function StreakWeek({ n }: { n: number }) {
  const { palette } = useTheme();
  return (
    <View
      accessibilityLabel={`Streak week ${n}`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 2, backgroundColor: palette.surface2, borderRadius: radius.pill, paddingHorizontal: 6, paddingVertical: 2 }}>
      <SymbolView name={ICONS.flame} tintColor={heat.flame} size={12} />
      <T variant="tiny" weight="800" style={{ color: heat.flame, fontVariant: ['tabular-nums'] }}>{n}</T>
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
