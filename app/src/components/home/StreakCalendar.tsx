import { router, type Href } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { format, parseISO } from 'date-fns';
import { Pressable, View } from 'react-native';

import { Card } from '@/components/ui/Card';
import { ListRow } from '@/components/ui/ListRow';
import { T } from '@/components/ui/T';
import { shortTime } from '@/lib/dates';
import { KIND_ICON, KIND_LABEL, monthGrid, type Session, type SessionKind } from '@/lib/streaks';
import { useTheme } from '@/theme/ThemeProvider';
import type { Palette } from '@/theme/tokens';
import { radius, space } from '@/theme/tokens';

type Props = {
  year: number;
  month0: number;
  byDay: Map<string, Session[]>;
  today: string;
  selected: string | null;
  onSelect: (date: string | null) => void;
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

/**
 * One month, Strava style: seven columns, a workout's icon on the day it happened, "+2" when
 * there were more. Tap a day for its sessions.
 */
export function StreakCalendar({ year, month0, byDay, today, selected, onSelect }: Props) {
  const { palette } = useTheme();
  const weeks = monthGrid(year, month0);
  const title = format(new Date(year, month0, 1), 'MMMM yyyy');
  const days = weeks.flat().filter((c) => c.inMonth && c.date <= today);
  const active = days.filter((c) => byDay.has(c.date)).length;
  const picked = selected && selected.slice(0, 7) === `${year}-${String(month0 + 1).padStart(2, '0')}` ? byDay.get(selected) ?? [] : [];

  return (
    <Card title={title} subtitle={days.length ? `${active} of ${days.length} days with a workout` : undefined}>
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
              const sessions = cell.inMonth ? byDay.get(cell.date) ?? [] : [];
              const first = sessions[0];
              const isToday = cell.date === today;
              const isSelected = cell.date === selected;
              const future = cell.date > today;
              if (!cell.inMonth) return <View key={cell.date} style={{ flex: 1, aspectRatio: 1 }} />;
              return (
                <Pressable
                  key={cell.date}
                  disabled={!first}
                  onPress={() => onSelect(isSelected ? null : cell.date)}
                  accessibilityRole={first ? 'button' : undefined}
                  accessibilityLabel={`${format(parseISO(cell.date), 'EEEE d MMMM')}${first ? `, ${sessions.length} workout${sessions.length === 1 ? '' : 's'}` : ''}`}
                  style={({ pressed }) => ({
                    flex: 1, aspectRatio: 1, borderRadius: radius.sm,
                    backgroundColor: isSelected ? palette.accentSoft : first ? palette.surface2 : 'transparent',
                    borderWidth: isToday ? 1.5 : 0, borderColor: palette.accent,
                    alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.7 : future ? 0.4 : 1,
                  })}>
                  <T variant="tiny" tone={isToday ? 'accent' : first ? 'ink2' : 'mut'} weight={isToday ? '800' : undefined} style={{ position: 'absolute', top: 2, left: 4 }}>
                    {parseInt(cell.date.slice(8, 10), 10)}
                  </T>
                  {first ? <SymbolView name={KIND_ICON[first.kind]} tintColor={kindColour(palette, first.kind)} size={16} style={{ marginTop: 6 }} /> : null}
                  {sessions.length > 1 ? (
                    <View style={{ position: 'absolute', right: 2, bottom: 2, backgroundColor: palette.accent, borderRadius: radius.pill, paddingHorizontal: 4, minWidth: 16, alignItems: 'center' }}>
                      <T variant="tiny" tone="onAccent" weight="800">+{sessions.length - 1}</T>
                    </View>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        ))}
      </View>
      </View>
      {picked.length ? (
        <View style={{ marginTop: space.sm }}>
          <T variant="label" tone="mut" style={{ marginBottom: space.xs }}>{format(parseISO(selected!), 'EEEE d MMMM')}</T>
          {picked.map((s, i) => (
            <ListRow
              key={s.id}
              first={i === 0}
              title={s.title}
              subtitle={`${KIND_LABEL[s.kind]} · ${shortTime(s.startedAt)}${s.detail ? ` · ${s.detail}` : ''}`}
              onPress={() => router.push(s.href as Href)}
            />
          ))}
        </View>
      ) : null}
    </Card>
  );
}
