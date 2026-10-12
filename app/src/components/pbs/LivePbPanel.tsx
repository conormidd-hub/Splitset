import { Pressable, View } from 'react-native';

import type { LiftPb, PbPeriods } from '@/api/pbs';
import { T } from '@/components/ui/T';
import { bestOf, formatLoad, LOAD_PERCENTS, plateRound, type LiftMetric, type SessionBest } from '@/lib/pbs';
import type { Units } from '@/lib/units';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

import { PbTable } from './PbTable';
import { liftRows } from './rows';

/** Which metrics an exercise can have PBs in, by how it is measured. */
export function metricsFor(measure: string, bodyweight: boolean): LiftMetric[] {
  if (measure === 'weight_reps') return bodyweight ? ['1rm', '3rm', 'reps'] : ['1rm', '3rm'];
  if (measure === 'reps') return ['reps'];
  if (measure === 'duration') return ['time'];
  if (measure === 'weight_duration') return ['weight'];
  return [];
}

type Props = {
  stored: Map<string, PbPeriods<LiftPb>> | undefined;
  session: Partial<Record<LiftMetric, SessionBest>>;
  metrics: LiftMetric[];
  /** The rep range being lifted now, highlighted in the table. */
  focus: LiftMetric | null;
  units: Units;
  /** Put this weight (kg) on the next set to lift. */
  onLoad: (kg: number) => void;
};

/**
 * The PB sheet inside a workout: month, year and all-time bests with this session folded in,
 * and quick loads as a share of the 1RM. The base is this month's 1RM, falling back to this
 * year's and then all time when the lift hasn't been done this month.
 */
export function LivePbPanel({ stored, session, metrics, focus, units, onLoad }: Props) {
  const { palette } = useTheme();
  const rows = liftRows(stored, units, { session, highlight: focus, only: metrics });
  const s1 = session['1rm']?.value;
  const base = metrics.includes('1rm')
    ? ([
        ['this month', bestOf(stored?.get('1rm')?.month?.value, s1)],
        ['this year', bestOf(stored?.get('1rm')?.year?.value, s1)],
        ['all-time', bestOf(stored?.get('1rm')?.all?.value, s1)],
      ] as const).find(([, v]) => v != null)
    : undefined;

  return (
    <View style={{ backgroundColor: palette.surface2, borderRadius: radius.md, padding: space.md, gap: space.md, marginBottom: space.sm }}>
      <PbTable rows={rows} compact />
      {base ? (
        <View style={{ gap: space.sm }}>
          <T variant="small" tone="mut">
            Load from {base[0]} 1RM · <T variant="small" weight="700">{formatLoad(base[1], units)}</T>
          </T>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {LOAD_PERCENTS.map((pct) => {
              const kg = plateRound((base[1]! * pct) / 100, units);
              return (
                <Pressable
                  key={pct}
                  onPress={() => onLoad(kg)}
                  accessibilityRole="button"
                  accessibilityLabel={`${pct} percent, ${formatLoad(kg, units)}`}
                  style={({ pressed }) => ({
                    flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: radius.sm,
                    backgroundColor: pressed ? palette.accent : palette.surface, borderWidth: 1, borderColor: palette.accentLine,
                  })}>
                  <T variant="small" weight="800" tone="accent">{pct}%</T>
                  <T variant="tiny" tone="ink2" style={{ fontVariant: ['tabular-nums'] }}>{formatLoad(kg, units)}</T>
                </Pressable>
              );
            })}
          </View>
          <T variant="tiny" tone="mut">Tap a load to put it on the next set you haven&apos;t ticked.</T>
        </View>
      ) : metrics.includes('1rm') ? (
        <T variant="small" tone="mut">Tick a set with weight and reps to unlock % loads.</T>
      ) : null}
    </View>
  );
}
