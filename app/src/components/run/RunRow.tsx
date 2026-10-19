import { memo, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import { Badge } from '@/components/ui/Chip';
import { Button } from '@/components/ui/Button';
import { T } from '@/components/ui/T';
import { relativeDay, shortTime } from '@/lib/dates';
import { formatDistance, formatDuration, formatElevation, formatPace, secPerKm, type Units } from '@/lib/units';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

/** The few columns a history row needs, whichever query it came from. */
export type RunSummary = {
  id: string;
  name: string | null;
  start_time_local: string;
  distance_m: number | null;
  moving_time_s: number | null;
  avg_hr: number | null;
  elev_gain_m: number | null;
};

type Props = {
  run: RunSummary;
  units: Units;
  first?: boolean;
  /** Expanded rows show the key numbers on one line and the door to the full stats. */
  expanded: boolean;
  /** True when the run has a trace on the map (the badge says so while expanded). */
  onMap: boolean;
  onToggle: () => void;
  onOpen: () => void;
  /** Drawn before the name: the run's route shape. */
  leading?: ReactNode;
};

/** One run in the history: a compact line that expands to its headline stats when tapped. */
export const RunRow = memo(function RunRow({ run, units, first, expanded, onMap, onToggle, onOpen, leading }: Props) {
  const { palette } = useTheme();
  const pace = secPerKm(run.distance_m, run.moving_time_s);
  const name = run.name ?? 'Run';
  const when = `${relativeDay(run.start_time_local)} · ${shortTime(run.start_time_local)}`;
  // pace already sits on the collapsed line, so the expanded line adds time, heart rate and climb
  const stats = [
    run.moving_time_s != null ? formatDuration(run.moving_time_s) : null,
    run.avg_hr != null ? `${run.avg_hr} bpm` : null,
    run.elev_gain_m != null ? `+${formatElevation(run.elev_gain_m, units)} climb` : null,
  ].filter(Boolean);

  return (
    <View style={{ paddingHorizontal: space.lg, backgroundColor: expanded ? palette.accentSoft : palette.surface }}>
      <View style={{ borderTopWidth: first ? 0 : 1, borderTopColor: palette.hair }}>
        <Pressable
          onPress={onToggle}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel={`${name}, ${when}, ${formatDistance(run.distance_m, units)}`}
          accessibilityHint={expanded ? 'Hides the key stats' : 'Shows the key stats'}
          style={({ pressed }) => ({
            flexDirection: 'row', alignItems: 'center', gap: space.md,
            paddingTop: space.md, paddingBottom: expanded ? space.sm : space.md, opacity: pressed ? 0.8 : 1,
          })}>
          {leading}
          <View style={{ flex: 1, gap: 2 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
              <T variant="h3" numberOfLines={1} style={{ flexShrink: 1 }}>{name}</T>
              {expanded && onMap ? <Badge label="On the map" tone="accent" /> : null}
            </View>
            <T variant="small" tone="mut" numberOfLines={1}>{when}</T>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <T variant="h3" style={{ fontVariant: ['tabular-nums'] }}>{formatDistance(run.distance_m, units)}</T>
            {pace ? <T variant="small" tone="mut">{formatPace(pace, units)}</T> : null}
          </View>
          <T tone="mut" accessible={false} importantForAccessibility="no" style={{ transform: [{ rotate: expanded ? '90deg' : '0deg' }] }}>›</T>
        </Pressable>
        {/* beside the row's button, not inside it: a button can't hold another */}
        {expanded ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingBottom: space.md }}>
            <T variant="small" tone="ink2" numberOfLines={1} style={{ flex: 1, fontVariant: ['tabular-nums'] }}>{stats.join(' · ')}</T>
            <Button title="Full stats" small onPress={onOpen} />
          </View>
        ) : null}
      </View>
    </View>
  );
});
