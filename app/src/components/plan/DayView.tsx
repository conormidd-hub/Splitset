import { addDays, format, parseISO } from 'date-fns';
import { router, type Href } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Pressable, View } from 'react-native';

import { isRun, typeLabel } from '@/api/activities';
import { planTypeLabel, useActivitiesBetween, usePlanRange, useSetPlanStatus, type PlanSession } from '@/api/plan';
import { typeColour, watchState } from '@/components/plan/CalendarCards';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Chip';
import { ListRow } from '@/components/ui/ListRow';
import { T } from '@/components/ui/T';
import { isoDate, relativeDay, shortTime, weekStartIso } from '@/lib/dates';
import { KIND_ICON, type Session } from '@/lib/streaks';
import { formatDistance, formatDuration, formatDurationShort, formatElevation, formatPace, secPerKm, type Units } from '@/lib/units';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

type Props = {
  cursor: string;
  today: string;
  units: Units;
  pushOn: boolean;
  /** What happened, by day (for the week strip's dots and the gym workouts logged here). */
  byDay: Map<string, Session[]>;
  onCursor: (iso: string) => void;
};

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * One day in full: every planned session with its target, notes and what it was linked to,
 * every activity the watch recorded, every gym workout logged here, and the quick ways to
 * tick one off, skip it, or add one. A strip of the week above it for moving day to day.
 */
export function DayView({ cursor, today, units, pushOn, byDay, onCursor }: Props) {
  const { palette } = useTheme();
  const weekStart = weekStartIso(parseISO(cursor));
  const week = Array.from({ length: 7 }, (_, i) => isoDate(addDays(parseISO(weekStart), i)));
  const plan = usePlanRange(weekStart, week[6]);
  const actuals = useActivitiesBetween(cursor, cursor);
  const setStatus = useSetPlanStatus();

  const sessions = (plan.data ?? []).filter((p) => p.date === cursor);
  const linkedIds = new Set(sessions.map((s) => s.activity_id).filter(Boolean));
  const activities = (actuals.data ?? []).filter((a) => a.start_time_local.slice(0, 10) === cursor);
  const unplanned = activities.filter((a) => !linkedIds.has(a.id));
  const gym = (byDay.get(cursor) ?? []).filter((s) => s.href.startsWith('/lift/'));
  const nothing = !sessions.length && !unplanned.length && !gym.length;
  const isToday = cursor === today;

  return (
    <View style={{ gap: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Arrow dir="prev" onPress={() => onCursor(isoDate(addDays(parseISO(cursor), -1)))} />
        <View style={{ flex: 1, alignItems: 'center' }}>
          <T variant="h2">{format(parseISO(cursor), 'EEEE d MMMM')}</T>
          <T variant="small" tone={isToday ? 'accent' : 'mut'}>{relativeDay(cursor)}</T>
        </View>
        <Arrow dir="next" onPress={() => onCursor(isoDate(addDays(parseISO(cursor), 1)))} />
        {!isToday ? <Button title="Today" variant="ghost" small onPress={() => onCursor(today)} /> : null}
      </View>

      <View style={{ flexDirection: 'row', gap: 4 }}>
        {week.map((d, i) => {
          const on = d === cursor;
          const done = (byDay.get(d) ?? []).length > 0;
          const planned = (plan.data ?? []).some((p) => p.date === d && p.status === 'planned' && p.type !== 'rest');
          return (
            <Pressable
              key={d}
              onPress={() => onCursor(d)}
              accessibilityRole="button"
              accessibilityLabel={`${DAYS[i]} ${parseInt(d.slice(8, 10), 10)}${done ? ', workout' : planned ? ', planned' : ''}`}
              accessibilityState={{ selected: on }}
              style={({ pressed }) => ({
                flex: 1, alignItems: 'center', paddingVertical: 6, borderRadius: radius.sm,
                backgroundColor: on ? palette.accentSoft : 'transparent', borderWidth: d === today ? 1 : 0, borderColor: palette.accent,
                opacity: pressed ? 0.7 : 1,
              })}>
              <T variant="tiny" tone={on ? 'accent' : 'mut'}>{DAYS[i][0]}</T>
              <T variant="h3" tone={on ? 'accent' : d > today ? 'mut' : 'ink'} style={{ fontVariant: ['tabular-nums'] }}>{parseInt(d.slice(8, 10), 10)}</T>
              <View style={{ width: 6, height: 6, borderRadius: 3, marginTop: 2, backgroundColor: done ? palette.accent : 'transparent', borderWidth: !done && planned ? 1 : 0, borderColor: palette.accentLine }} />
            </Pressable>
          );
        })}
      </View>

      {sessions.map((s) => {
        const linked = s.activity_id ? activities.find((a) => a.id === s.activity_id) : undefined;
        const missed = s.status === 'planned' && s.date < today;
        const watch = watchState(s, pushOn, today);
        const steps = Array.isArray(s.steps) ? s.steps.length : 0;
        return (
          <Card key={s.id} onPress={() => router.push(`/plan/${s.id}`)}>
            <View style={{ flexDirection: 'row', gap: space.md }}>
              <View style={{ width: 4, borderRadius: 2, backgroundColor: typeColour(palette, s.type) }} />
              <View style={{ flex: 1, gap: space.sm }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' }}>
                  <T variant="h2" style={{ flexShrink: 1, textDecorationLine: s.status === 'skipped' ? 'line-through' : 'none' }}>{s.title}</T>
                  <Badge label={missed ? 'missed' : s.status} tone={missed ? 'neg' : s.status === 'done' ? 'pos' : s.status === 'skipped' ? 'neg' : 'mut'} />
                  {watch === 'on' ? <T variant="small" accessibilityLabel="on your watch">⌚</T> : null}
                  {watch === 'sending' || watch === 'removing' ? <T variant="tiny" tone="mut">⌚ {watch === 'sending' ? 'sending…' : 'removing…'}</T> : null}
                </View>
                <T variant="small" tone="mut">
                  {[planTypeLabel(s.type), s.subtype].filter(Boolean).join(' · ')}
                  {s.target_distance_m ? ` · target ${formatDistance(s.target_distance_m, units, 1)}` : ''}
                  {s.target_seconds ? ` · target ${formatDurationShort(s.target_seconds)}` : ''}
                  {steps ? ` · ${steps} step${steps === 1 ? '' : 's'}` : ''}
                </T>
                {s.notes ? <T tone="ink2">{s.notes}</T> : null}
                {linked ? (
                  <Pressable onPress={() => router.push(`/run/${linked.id}`)} accessibilityRole="button" accessibilityLabel={`Open ${linked.name ?? typeLabel(linked.type)}`}>
                    <View style={{ backgroundColor: palette.surface2, borderRadius: radius.md, padding: space.md, gap: 2 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                        <SymbolView name={isRun(linked.type) ? KIND_ICON.run : KIND_ICON.other} tintColor={palette.pos} size={16} />
                        <T variant="h3" numberOfLines={1} style={{ flex: 1 }}>{linked.name ?? typeLabel(linked.type)}</T>
                        <T variant="small" tone="mut">{shortTime(linked.start_time_local)}</T>
                      </View>
                      <T variant="small" tone="ink2">{activityLine(linked, units)}</T>
                    </View>
                  </Pressable>
                ) : null}
                {s.status === 'planned' ? (
                  <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
                    <Button title="Mark done" variant="secondary" small loading={setStatus.isPending && setStatus.variables?.id === s.id} onPress={() => setStatus.mutate({ id: s.id, status: 'done' })} />
                    <Button title="Skip" variant="ghost" small onPress={() => setStatus.mutate({ id: s.id, status: 'skipped' })} />
                  </View>
                ) : s.status === 'skipped' ? (
                  <Button title="Put it back" variant="ghost" small style={{ alignSelf: 'flex-start' }} onPress={() => setStatus.mutate({ id: s.id, status: 'planned' })} />
                ) : null}
              </View>
            </View>
          </Card>
        );
      })}

      {unplanned.length ? (
        <Card title={sessions.length ? 'Also recorded' : 'Recorded'} subtitle="From your watch">
          {unplanned.map((a, i) => (
            <ListRow
              key={a.id}
              first={i === 0}
              title={a.name ?? typeLabel(a.type)}
              subtitle={`${typeLabel(a.type)} · ${shortTime(a.start_time_local)} · ${activityLine(a, units)}`}
              onPress={() => router.push(`/run/${a.id}`)}
            />
          ))}
        </Card>
      ) : null}

      {gym.length ? (
        <Card title="Gym" subtitle="Logged in the Lift tab">
          {gym.map((g, i) => (
            <ListRow key={g.id} first={i === 0} title={g.title} subtitle={`${shortTime(g.startedAt)}${g.detail ? ` · ${g.detail}` : ''}`} onPress={() => router.push(g.href as Href)} />
          ))}
        </Card>
      ) : null}

      {nothing && plan.isSuccess ? (
        <Card>
          <T tone="mut">{cursor < today ? 'A rest day: nothing planned, nothing recorded.' : 'Nothing planned yet.'}</T>
        </Card>
      ) : null}

      <Button title="+ Add a session on this day" variant="secondary" onPress={() => router.push(`/plan/new?date=${cursor}`)} />
    </View>
  );
}

/** "8.1 km · 48:39 · 5:59 /km · 148 bpm · 120 m" for a recorded activity. */
function activityLine(a: { distance_m: number | null; moving_time_s: number | null; avg_hr: number | null; elev_gain_m: number | null; type: string }, units: Units): string {
  return [
    a.distance_m ? formatDistance(a.distance_m, units) : null,
    formatDuration(a.moving_time_s),
    a.distance_m && isRun(a.type) ? formatPace(secPerKm(a.distance_m, a.moving_time_s), units) : null,
    a.avg_hr ? `${a.avg_hr} bpm` : null,
    a.elev_gain_m ? formatElevation(a.elev_gain_m, units) : null,
  ].filter(Boolean).join(' · ');
}

function Arrow({ dir, onPress }: { dir: 'prev' | 'next'; onPress: () => void }) {
  const { palette } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={dir === 'prev' ? 'Previous day' : 'Next day'}
      style={({ pressed }) => ({ width: 36, height: 36, borderRadius: 18, backgroundColor: palette.surface2, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.7 : 1 })}>
      <T variant="h2" tone="ink2">{dir === 'prev' ? '‹' : '›'}</T>
    </Pressable>
  );
}

// PlanSession is referenced for the type of the sessions this view lists
export type DayPlan = PlanSession;
