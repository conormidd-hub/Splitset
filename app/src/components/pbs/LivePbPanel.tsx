import { Pressable, View } from 'react-native';

import type { LiftPb, PbPeriods } from '@/api/pbs';
import { T } from '@/components/ui/T';
import { bestOf, bodyweightRelative, formatLoad, LOAD_PERCENTS, quickLoad, type LiftMetric, type SessionBest } from '@/lib/pbs';
import type { Units } from '@/lib/units';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

import { PbTable } from './PbTable';
import { liftRows } from './rows';

type Props = {
  stored: Map<string, PbPeriods<LiftPb>> | undefined;
  session: Partial<Record<LiftMetric, SessionBest>>;
  metrics: LiftMetric[];
  /** The rep range being lifted now, highlighted in the table. */
  focus: LiftMetric | null;
  units: Units;
  /** Put this weight (kg) on the next set to lift. */
  onLoad: (kg: number) => void;
  /** The best manual entry's e1RM, which counts as the all-time 1RM, as on the card (notes 17.4). */
  manualBest?: number | null;
  /** What the weight field means (load_mode), with the bodyweight factor and the bodyweight the
   *  set e1RMs use: a bodyweight or assisted lift's quick loads are added load or assistance. */
  loadMode?: string | null;
  bwFactor?: number | null;
  bodyweightKg?: number | null;
};

/**
 * The PB sheet inside a workout: month, year and all-time bests with this session folded in,
 * and quick loads as a share of the 1RM. The base is this month's 1RM, falling back to this
 * year's and then all time (manual entries included) when the lift hasn't been done this month.
 */
export function LivePbPanel({ stored, session, metrics, focus, units, onLoad, manualBest, loadMode, bwFactor, bodyweightKg }: Props) {
  const { palette } = useTheme();
  const rows = liftRows(stored, units, { session, highlight: focus, only: metrics, manualAll: { '1rm': manualBest }, loadMode });
  const s1 = session['1rm']?.value;
  const base = metrics.includes('1rm')
    ? ([
        ['this month', bestOf(stored?.get('1rm')?.month?.value, s1)],
        ['this year', bestOf(stored?.get('1rm')?.year?.value, s1)],
        ['all-time', bestOf(stored?.get('1rm')?.all?.value, manualBest, s1)],
      ] as const).find(([, v]) => v != null)
    : undefined;
  const loads = base
    ? LOAD_PERCENTS.flatMap((pct) => {
        const kg = quickLoad((base[1]! * pct) / 100, units, loadMode, bwFactor, bodyweightKg);
        return kg == null ? [] : [{ pct, kg }];
      })
    : [];
  const relative = bodyweightRelative(loadMode);
  const assisted = loadMode === 'assisted';
  const loadText = (kg: number) => (loadMode === 'bodyweight' ? (kg ? `+${formatLoad(kg, units)}` : 'BW') : formatLoad(kg, units));

  return (
    <View style={{ backgroundColor: palette.surface2, borderRadius: radius.md, padding: space.md, gap: space.md, marginBottom: space.sm }}>
      <PbTable rows={rows} compact />
      {base ? (
        <View style={{ gap: space.sm }}>
          <T variant="small" tone="mut">
            {assisted ? 'Assistance' : relative ? 'Added load' : 'Load'} from {base[0]} 1RM{relative ? ' (incl. bodyweight)' : ''} · <T variant="small" weight="700">{formatLoad(base[1], units)}</T>
          </T>
          {loads.length ? (
            <>
              <View style={{ flexDirection: 'row', gap: 6 }}>
                {loads.map(({ pct, kg }) => (
                  <Pressable
                    key={pct}
                    onPress={() => onLoad(kg)}
                    accessibilityRole="button"
                    accessibilityLabel={`${pct} percent, ${formatLoad(kg, units)}${assisted ? ' assistance' : relative ? ' added' : ''}`}
                    style={({ pressed }) => ({
                      flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: radius.sm,
                      backgroundColor: pressed ? palette.accent : palette.surface, borderWidth: 1, borderColor: palette.accentLine,
                    })}>
                    <T variant="small" weight="800" tone="accent">{pct}%</T>
                    <T variant="tiny" tone="ink2" style={{ fontVariant: ['tabular-nums'] }}>{loadText(kg)}</T>
                  </Pressable>
                ))}
              </View>
              <T variant="tiny" tone="mut">Tap a load to put it on the next set you haven&apos;t ticked.</T>
            </>
          ) : (
            <T variant="small" tone="mut">
              {assisted ? 'Every share of this 1RM is more than your bodyweight: no assistance needed.' : 'Every share of this 1RM is under your bodyweight alone: add reps rather than load.'}
            </T>
          )}
        </View>
      ) : metrics.includes('1rm') ? (
        <T variant="small" tone="mut">Tick a set with weight and reps to unlock % loads.</T>
      ) : null}
    </View>
  );
}
