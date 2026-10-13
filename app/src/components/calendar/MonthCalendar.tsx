import { router, type Href } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { format, parseISO } from 'date-fns';
import { Pressable, View } from 'react-native';

import { planTypeLabel, type PlanSession } from '@/api/plan';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Chip';
import { ListRow } from '@/components/ui/ListRow';
import { T } from '@/components/ui/T';
import { shortTime } from '@/lib/dates';
import { KIND_ICON, KIND_LABEL, monthGrid, planKind, type Session, type SessionKind } from '@/lib/streaks';
import { useTheme } from '@/theme/ThemeProvider';
import type { Palette } from '@/theme/tokens';
import { radius, space } from '@/theme/tokens';

type Props = {
  year: number;
  month0: number;
  /** What happened: every workout, by day. */
  byDay: Map<string, Session[]>;
  /** What was meant to happen: the plan's sessions, by day. */
  planByDay: Map<string, PlanSession[]>;
  today: string;
  selected: string | null;
  onSelect: (date: string | null) => void;
  /** Jump to this day in the Plan tab. */
  onOpenInPlan: (date: string) => void;
};

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
/** A day cell never grows past this, so a wide browser window gets a calendar, not a wall. */
const CELL_MAX = 46;
const GAP = 4;
const GRID_MAX = CELL_MAX * 7 + GAP * 6;

/** The colour a kind of session gets, the same as the plan calendar's left bars. */
export function kindColour(palette: Palette, kind: SessionKind): string {
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
  // a session ticked off without a synced activity still counts as done
  const doneByHand = real.filter((p) => p.status === 'done' && !p.activity_id && !done.some((s) => s.id === p.activity_id));
  const open = real.filter((p) => p.status === 'planned');
  const doneCount = done.length + doneByHand.length;
  if (doneCount) {
    const icon = done[0]?.kind ?? planKind(doneByHand[0].type) ?? 'other';
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

const STATUS_TONE = { planned: 'mut', done: 'pos', skipped: 'neg' } as const;

/**
 * One month of the same days the Plan tab shows week by week: a workout's icon on the day it
 * happened, a dashed outline where one is planned, a red dot where one was missed, "+2" when
 * there was more. Tap a day for the lot, and for the way into the plan.
 */
export function MonthCalendar({ year, month0, byDay, planByDay, today, selected, onSelect, onOpenInPlan }: Props) {
  const { palette } = useTheme();
  const weeks = monthGrid(year, month0);
  const title = format(new Date(year, month0, 1), 'MMMM yyyy');
  const days = weeks.flat().filter((c) => c.inMonth && c.date <= today);
  const active = days.filter((c) => byDay.has(c.date)).length;
  const monthKey = `${year}-${String(month0 + 1).padStart(2, '0')}`;
  const pickedDate = selected && selected.slice(0, 7) === monthKey ? selected : null;
  const pickedDone = pickedDate ? byDay.get(pickedDate) ?? [] : [];
  const pickedPlans = pickedDate ? (planByDay.get(pickedDate) ?? []).filter((p) => p.type !== 'rest') : [];

  return (
    <Card title={title} subtitle={days.length ? `${active} of ${days.length} days with a workout` : 'Nothing yet'}>
      <View style={{ width: '100%', maxWidth: GRID_MAX, alignSelf: 'center' }}>
        <View style={{ flexDirection: 'row', marginBottom: space.xs }}>
          {WEEKDAYS.map((d, i) => (
            <T key={i} variant="tiny" tone="mut" align="center" style={{ flex: 1 }}>{d}</T>
          ))}
        </View>
        <View style={{ gap: GAP }}>
          {weeks.map((week, wi) => (
            <View key={wi} style={{ flexDirection: 'row', gap: GAP }}>
              {week.map((cell) => {
                if (!cell.inMonth) return <View key={cell.date} style={{ flex: 1, aspectRatio: 1 }} />;
                const done = byDay.get(cell.date) ?? [];
                const plans = planByDay.get(cell.date) ?? [];
                const face = faceOf(cell.date, today, done, plans);
                const isToday = cell.date === today;
                const isSelected = cell.date === selected;
                const future = cell.date > today;
                const tappable = face.kind !== 'empty' || !future || isToday;
                const tint = face.kind === 'done' ? kindColour(palette, face.icon)
                  : face.kind === 'planned' ? palette.accent
                    : palette.mut;
                const label = [
                  format(parseISO(cell.date), 'EEEE d MMMM'),
                  done.length ? `${done.length} workout${done.length === 1 ? '' : 's'}` : null,
                  face.kind === 'planned' ? 'planned' : face.kind === 'missed' ? 'missed' : face.kind === 'skipped' ? 'skipped' : null,
                ].filter(Boolean).join(', ');
                return (
                  <Pressable
                    key={cell.date}
                    disabled={!tappable}
                    onPress={() => onSelect(isSelected ? null : cell.date)}
                    accessibilityRole="button"
                    accessibilityLabel={label}
                    style={({ pressed }) => ({
                      flex: 1, aspectRatio: 1, borderRadius: radius.sm,
                      backgroundColor: isSelected ? palette.accentSoft : face.kind === 'done' ? palette.surface2 : 'transparent',
                      borderWidth: isToday ? 1.5 : face.kind === 'planned' ? 1 : 0,
                      borderStyle: face.kind === 'planned' && !isToday ? 'dashed' : 'solid',
                      borderColor: isToday ? palette.accent : palette.accentLine,
                      alignItems: 'center', justifyContent: 'center',
                      opacity: pressed ? 0.7 : future && face.kind === 'empty' ? 0.4 : 1,
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
        </View>
      </View>

      {pickedDate ? (
        <View style={{ marginTop: space.md, gap: space.sm }}>
          <T variant="label" tone="mut">{format(parseISO(pickedDate), 'EEEE d MMMM')}</T>
          {!pickedDone.length && !pickedPlans.length ? (
            <T variant="small" tone="mut">{pickedDate < today ? 'A rest day.' : 'Nothing planned yet.'}</T>
          ) : null}
          {pickedDone.map((s, i) => (
            <ListRow
              key={s.id}
              first={i === 0}
              title={s.title}
              subtitle={`${KIND_LABEL[s.kind]} · ${shortTime(s.startedAt)}${s.detail ? ` · ${s.detail}` : ''}`}
              badge={<Badge label="done" tone="pos" />}
              onPress={() => router.push(s.href as Href)}
            />
          ))}
          {pickedPlans.map((p, i) => {
            const missed = p.status === 'planned' && p.date < today;
            return (
              <ListRow
                key={p.id}
                first={i === 0 && !pickedDone.length}
                title={p.title}
                subtitle={[planTypeLabel(p.type), p.subtype].filter(Boolean).join(' · ')}
                badge={<Badge label={missed ? 'missed' : p.status} tone={missed ? 'neg' : STATUS_TONE[p.status as keyof typeof STATUS_TONE] ?? 'mut'} />}
                onPress={() => router.push(`/plan/${p.id}`)}
              />
            );
          })}
          <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap', marginTop: space.xs }}>
            <Button title="Open this week in Plan" variant="secondary" small onPress={() => onOpenInPlan(pickedDate)} />
            <Button title="+ Add a session" variant="ghost" small onPress={() => router.push(`/plan/new?date=${pickedDate}`)} />
          </View>
        </View>
      ) : null}
    </Card>
  );
}
