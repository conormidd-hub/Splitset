import { useState } from 'react';
import { View } from 'react-native';

import { BodyMap } from './BodyMap';
import { MuscleSheet } from './MuscleSheet';
import { useThresholds, type RecoveryMuscle, type SessionMapMuscle } from '@/api/recovery';
import { T } from '@/components/ui/T';
import type { FigureMap, FigureTheme, MapMode } from '@/lib/recovery/figure';
import type { MuscleId } from '@/lib/recovery/library';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

type Props = {
  /** A recovery or session map (tapping opens the Phase 6 sheet), or any figure map (no sheet). */
  map: FigureMap | null;
  mode: MapMode;
  /** Width of each of the two figures. */
  figureWidth: number;
  nameOf: (id: MuscleId) => string;
  /** Open the tap-detail sheet on a tap. Off for figures that are not a recovery or session map. */
  detail?: boolean;
  /** "Front" and "Back" under the figures. */
  labels?: boolean;
  timeZone?: string | null;
};

/**
 * Front and back side by side at a fixed size, with no toggles (build phase 7): the Today card,
 * the live workout, the workout summary and an exercise's muscles. The Recovery screen uses the
 * full RecoveryFigure instead.
 */
export function FigurePair({ map, mode, figureWidth, nameOf, detail = false, labels = false, timeZone }: Props) {
  const { name } = useTheme();
  const c = useThresholds();
  const theme: FigureTheme = name === 'night' ? 'dark' : 'light';
  const [selected, setSelected] = useState<MuscleId | null>(null);
  const onSelect = detail ? setSelected : undefined;

  return (
    <View style={{ flexDirection: 'row', justifyContent: 'center', gap: space.md }}>
      {(['front', 'back'] as const).map((view) => (
        <View key={view} style={{ alignItems: 'center', gap: 2 }}>
          <BodyMap map={map} view={view} mode={mode} theme={theme} thresholds={c} width={figureWidth} onSelect={onSelect} nameOf={nameOf} />
          {labels ? <T variant="tiny" tone="mut">{view === 'front' ? 'Front' : 'Back'}</T> : null}
        </View>
      ))}
      {detail ? (
        <MuscleSheet
          muscle={selected}
          name={selected ? nameOf(selected) : ''}
          theme={theme}
          state={selected && map ? (map[selected] as RecoveryMuscle | SessionMapMuscle) : null}
          timeZone={timeZone}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </View>
  );
}
