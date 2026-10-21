import { router, type Href } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useState, type ReactNode } from 'react';
import { Animated, Easing, Pressable, View } from 'react-native';

import { typeLabel } from '@/api/activities';
import type { HistoryItem } from '@/api/history';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Chip';
import { T } from '@/components/ui/T';
import { relativeDay, shortTime } from '@/lib/dates';
import type { Sport } from '@/lib/history';
import { ICONS, type IconName } from '@/lib/icons';
import {
  KM_PER_MILE, formatDistance, formatDuration, formatDurationShort, formatPace, formatWeight, secPerKm, type Units,
} from '@/lib/units';
import type { ActiveWorkout } from '@/stores/activeWorkout';
import { useLayoutPrefs } from '@/stores/layoutPrefs';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

export const SPORT_ICON: Record<Sport, IconName> = {
  run: ICONS.run,
  ride: ICONS.ride,
  lift: ICONS.lift,
  swim: ICONS.swim,
  // the walk glyph is a runner on Android; the hiker reads as walking everywhere
  walk: ICONS.hike,
  hike: ICONS.hike,
  other: ICONS.cardio,
};

/** "28.4 km/h" or "17.6 mph" for a ride. */
function formatSpeed(metres: number | null, seconds: number | null, units: Units): string | undefined {
  if (!metres || !seconds) return undefined;
  const kmh = metres / 1000 / (seconds / 3600);
  return units === 'imperial' ? `${(kmh / KM_PER_MILE).toFixed(1)} mph` : `${kmh.toFixed(1)} km/h`;
}

type Line = { title: string; type: string; subtitle: string; value?: string; valueSub?: string; href: Href };

/** What a row says about one feed item: runs and rides by distance and pace (or speed), lifts by volume and time. */
function lineOf(item: HistoryItem, units: Units): Line {
  const when = `${relativeDay(item.when)} · ${shortTime(item.when)}`;
  if (item.kind === 'workout') {
    const w = item.workout;
    const volume = w.volume_kg ? formatWeight(w.volume_kg, units, 0) : undefined;
    return {
      title: w.name ?? 'Workout',
      type: 'Lift',
      subtitle: w.sets_completed ? `${when} · ${w.sets_completed} set${w.sets_completed === 1 ? '' : 's'}` : when,
      value: volume ?? (w.duration_s != null ? formatDurationShort(w.duration_s) : undefined),
      valueSub: volume && w.duration_s != null ? formatDurationShort(w.duration_s) : undefined,
      href: `/workout/${item.id}`,
    };
  }
  const a = item.activity;
  const seconds = a.moving_time_s ?? a.elapsed_time_s;
  const type = typeLabel(a.type);
  const base: Line = { title: a.name ?? type, type, subtitle: when, href: `/run/${item.id}` };
  if (!a.distance_m) return { ...base, value: seconds != null ? formatDuration(seconds) : undefined };
  return {
    ...base,
    value: formatDistance(a.distance_m, units),
    valueSub: item.sport === 'run' ? formatPace(secPerKm(a.distance_m, a.moving_time_s), units)
      : item.sport === 'ride' ? formatSpeed(a.distance_m, a.moving_time_s, units)
      : seconds != null ? formatDuration(seconds) : undefined,
  };
}

type RowProps = {
  icon: IconName;
  title: string;
  subtitle: string;
  badge?: ReactNode;
  value?: string;
  valueSub?: string;
  first?: boolean;
  /** False while the row is folded away, so a keyboard cannot tab into it. */
  focusable?: boolean;
  onPress: () => void;
};

/** One line of the feed: the sport's icon, the name and when, and the headline number on the right. */
function FeedRowView({ icon, title, subtitle, badge, value, valueSub, first, focusable, onPress }: RowProps) {
  const { palette } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      focusable={focusable}
      // react-native-web's Pressable ignores focusable, so the tab order is set directly as well
      tabIndex={focusable === false ? -1 : undefined}
      accessibilityRole="button"
      accessibilityLabel={[title, subtitle, value, valueSub].filter(Boolean).join(', ')}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
      <View
        style={{
          flexDirection: 'row', alignItems: 'center', gap: space.md,
          paddingVertical: space.md, borderTopWidth: first ? 0 : 1, borderTopColor: palette.hair,
        }}>
        <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: palette.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
          <SymbolView name={icon} tintColor={palette.accent} size={18} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <T variant="h3" numberOfLines={1} style={{ flexShrink: 1 }}>{title}</T>
            {badge}
          </View>
          <T variant="small" tone="mut" numberOfLines={1}>{subtitle}</T>
        </View>
        {value ? (
          <View style={{ alignItems: 'flex-end' }}>
            <T variant="h3" style={{ fontVariant: ['tabular-nums'] }}>{value}</T>
            {valueSub ? <T variant="small" tone="mut" numberOfLines={1}>{valueSub}</T> : null}
          </View>
        ) : null}
        <T tone="mut">›</T>
      </View>
    </Pressable>
  );
}

/**
 * One activity or gym workout as a row that opens it. `showType` adds the type as a badge (Today's
 * card); otherwise only types the icon cannot tell apart (yoga, rowing) say their name, after the date.
 */
export function FeedRow({ item, units, first, showType, focusable }: {
  item: HistoryItem; units: Units; first?: boolean; showType?: boolean; focusable?: boolean;
}) {
  const line = lineOf(item, units);
  return (
    <FeedRowView
      icon={SPORT_ICON[item.sport]}
      title={line.title}
      subtitle={!showType && item.sport === 'other' && line.title !== line.type ? `${line.subtitle} · ${line.type}` : line.subtitle}
      badge={showType ? <Badge label={line.type} /> : undefined}
      value={line.value}
      valueSub={line.valueSub}
      first={first}
      focusable={focusable}
      onPress={() => router.push(line.href, { withAnchor: true })}
    />
  );
}

/** Folds its content away to nothing and back, by height, so the card grows like a drop-down. */
function DropDown({ open, children }: { open: boolean; children: ReactNode }) {
  const [t] = useState(() => new Animated.Value(open ? 1 : 0));
  const [height, setHeight] = useState(0);
  useEffect(() => {
    // height is a layout prop, so this runs on the JS side everywhere
    Animated.timing(t, { toValue: open ? 1 : 0, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
  }, [open, t]);
  return (
    <Animated.View
      pointerEvents={open ? 'auto' : 'none'}
      aria-hidden={!open}
      style={{
        overflow: 'hidden',
        opacity: t,
        // until the content has been measured it takes its own height when open
        height: height ? t.interpolate({ inputRange: [0, 1], outputRange: [0, height] }) : open ? undefined : 0,
      }}>
      <View onLayout={(e) => setHeight(e.nativeEvent.layout.height)}>{children}</View>
    </Animated.View>
  );
}

type Props = {
  /** The newest few things done, newest first (useLatestActivities). */
  items: readonly HistoryItem[];
  /** A workout being logged right now: it sits on top, marked live. */
  active: ActiveWorkout | null;
  units: Units;
  loading?: boolean;
  /** The feed failed to load: say so, rather than claiming there is nothing yet. */
  failed?: boolean;
};

/**
 * Today's Latest activity card: the newest run, ride or gym workout, with a chevron in its header
 * that drops open the last three and a way through to every activity on the History screen. The
 * card remembers on this device whether it was left open.
 */
export function LatestActivities({ items, active, units, loading, failed }: Props) {
  const { palette } = useTheme();
  const open = useLayoutPrefs((s) => s.latestExpanded);
  const setOpen = useLayoutPrefs((s) => s.setLatestExpanded);
  const [newest, ...rest] = items;

  if (!newest && !active) {
    if (loading) return null;
    if (failed) {
      return (
        <Card title="Latest activity">
          <T tone="mut">{"Couldn't load your latest activity. Pull down to try again."}</T>
        </Card>
      );
    }
    return (
      <Card title="Latest activity">
        <View style={{ gap: space.md }}>
          <T tone="mut">Nothing yet. Runs and rides arrive with each sync, and workouts you log in Lift show here too.</T>
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Button title="Start a workout" variant="secondary" small onPress={() => router.push('/lift')} />
            <Button title="History" variant="ghost" small onPress={() => router.push('/history')} />
          </View>
        </View>
      </Card>
    );
  }

  return (
    <Card>
      <Pressable
        onPress={() => setOpen(!open)}
        accessibilityRole="button"
        accessibilityLabel="Latest activity"
        accessibilityState={{ expanded: open }}
        // the web reads aria-expanded, not accessibilityState
        aria-expanded={open}
        accessibilityHint={open ? 'Shows only the newest' : 'Shows the last three'}
        hitSlop={6}
        style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 28, marginBottom: space.sm, opacity: pressed ? 0.7 : 1 })}>
        <T variant="h3" style={{ flex: 1 }}>Latest activity</T>
        <SymbolView name={open ? ICONS.collapse : ICONS.expand} tintColor={palette.mut} size={18} />
      </Pressable>

      {active ? (
        <FeedRowView
          first
          icon={ICONS.lift}
          title="Workout in progress"
          subtitle={`${active.name} · started ${shortTime(active.startedAt)} · ${active.exercises.length} exercise${active.exercises.length === 1 ? '' : 's'}`}
          badge={<Badge label="live" tone="accent" />}
          onPress={() => router.push('/lift/workout', { withAnchor: true })}
        />
      ) : null}
      {newest ? <FeedRow item={newest} units={units} first={!active} showType /> : null}

      <DropDown open={open}>
        {rest.map((item) => <FeedRow key={item.key} item={item} units={units} showType focusable={open} />)}
        <Pressable
          onPress={() => router.push('/history')}
          focusable={open}
          tabIndex={open ? 0 : -1}
          accessibilityRole="button"
          accessibilityLabel="More: all activities"
          accessibilityHint="Opens your full history"
          style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingTop: space.md, borderTopWidth: 1, borderTopColor: palette.hair }}>
            <SymbolView name={ICONS.history} tintColor={palette.accent} size={18} />
            <T weight="600" tone="accent" style={{ flex: 1 }}>More</T>
            <T variant="small" tone="mut">All activities</T>
            <T tone="accent">›</T>
          </View>
        </Pressable>
      </DropDown>
    </Card>
  );
}
