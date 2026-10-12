import { View } from 'react-native';

import { isRun, typeLabel, type ActivityListRow } from '@/api/activities';
import { planTypeLabel, type PlanSession } from '@/api/plan';
import { Badge } from '@/components/ui/Chip';
import { T } from '@/components/ui/T';
import { formatDistance, formatDuration, formatDurationShort, type Units } from '@/lib/units';
import { useTheme } from '@/theme/ThemeProvider';
import type { Palette } from '@/theme/tokens';
import { radius, space } from '@/theme/tokens';

/** The colour bar down a card's left edge: what kind of session it is. */
export function typeColour(palette: Palette, type: string | null | undefined): string {
  const t = (type ?? '').toLowerCase();
  if (t === 'run' || t.endsWith('run')) return palette.accent;
  if (t === 'strength' || t === 'weighttraining' || t === 'workout') return palette.amber;
  if (t.includes('ride')) return palette.blue;
  if (t === 'walk' || t === 'hike') return palette.aqua;
  return palette.mut;
}

/** "8.1 km · 48:39", or just the time for sessions without a distance. */
function doneLine(a: ActivityListRow, units: Units): string {
  return a.distance_m ? `${formatDistance(a.distance_m, units)} · ${formatDuration(a.moving_time_s)}` : formatDuration(a.moving_time_s);
}

function Shell({ colour, done, children, right, dimmed }: { colour: string; done: boolean; children: React.ReactNode; right?: React.ReactNode; dimmed?: boolean }) {
  const { palette } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row', alignItems: 'center', borderRadius: radius.md, overflow: 'hidden',
        backgroundColor: done ? palette.surface2 : palette.surface, borderWidth: 1, borderColor: palette.hair,
        opacity: dimmed ? 0.35 : 1, userSelect: 'none',
      }}>
      <View style={{ width: 4, alignSelf: 'stretch', backgroundColor: colour }} />
      <View style={{ flex: 1, paddingVertical: space.sm, paddingHorizontal: space.md }}>{children}</View>
      {right ? <View style={{ paddingRight: space.md, flexDirection: 'row', alignItems: 'center', gap: 6 }}>{right}</View> : null}
    </View>
  );
}

function Tick() {
  const { palette } = useTheme();
  return (
    <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: palette.accent, alignItems: 'center', justifyContent: 'center' }}>
      <T variant="tiny" weight="800" tone="onAccent">✓</T>
    </View>
  );
}

export function SessionCard({ session: s, linked, units, past, dimmed }: {
  session: PlanSession;
  /** The activity that fulfilled it, when there is one. */
  linked?: ActivityListRow;
  units: Units;
  past: boolean;
  dimmed?: boolean;
}) {
  const { palette } = useTheme();
  const done = s.status === 'done';
  const skipped = s.status === 'skipped';
  const missed = s.status === 'planned' && past;
  const target = [
    planTypeLabel(s.type),
    s.subtype,
    s.target_distance_m ? formatDistance(s.target_distance_m, units, 1) : null,
    s.target_seconds ? formatDurationShort(s.target_seconds) : null,
  ].filter(Boolean).join(' · ');
  return (
    <Shell
      colour={typeColour(palette, s.type)}
      done={done}
      dimmed={dimmed}
      right={
        <>
          {s.external_event_id && s.status === 'planned' && !past ? <T variant="small" accessibilityLabel="on your watch">⌚</T> : null}
          {done ? <Tick /> : null}
          {skipped ? <Badge label="skipped" /> : null}
          {missed ? <Badge label="missed" tone="neg" /> : null}
        </>
      }>
      <T weight="700" numberOfLines={1} style={skipped ? { textDecorationLine: 'line-through', color: palette.mut } : undefined}>{s.title}</T>
      <T variant="small" tone="mut" numberOfLines={1}>{done && linked ? doneLine(linked, units) : target}</T>
    </Shell>
  );
}

export function ActivityCard({ activity: a, units }: { activity: ActivityListRow; units: Units }) {
  const { palette } = useTheme();
  return (
    <Shell colour={typeColour(palette, a.type)} done right={<Tick />}>
      <T weight="700" numberOfLines={1}>{a.name ?? typeLabel(a.type)}</T>
      <T variant="small" tone="mut" numberOfLines={1}>
        {isRun(a.type) || a.distance_m ? doneLine(a, units) : `${typeLabel(a.type)} · ${formatDurationShort(a.moving_time_s)}`}
      </T>
    </Shell>
  );
}
