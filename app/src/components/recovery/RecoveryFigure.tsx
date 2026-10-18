import { useState } from 'react';
import { View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

import { BodyMap } from './BodyMap';
import { Legend } from './Legend';
import { MuscleList } from './MuscleList';
import { MuscleSheet } from './MuscleSheet';
import { useRecomputeStatus } from '@/api/workoutLoads';
import type { RecoveryMap, SessionMap } from '@/api/recovery';
import { Segmented } from '@/components/ui/Chip';
import { T } from '@/components/ui/T';
import { DEFAULT_THRESHOLDS } from '@/lib/recovery/constants';
import type { FigureTheme, FigureView, ListState, MapMode } from '@/lib/recovery/figure';
import type { MuscleId } from '@/lib/recovery/library';
import type { Thresholds } from '@/lib/recovery/thresholds';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

/** Wide enough for front and back side by side. */
const SIDE_BY_SIDE = 640;
const MAX_FIGURE = 260;
const SWIPE = 40;

type Props = {
  map: RecoveryMap | SessionMap | null;
  mode: MapMode;
  nameOf: (id: MuscleId) => string;
  thresholds?: Thresholds;
  /** IANA zone for dates in the tap detail. */
  timeZone?: string | null;
};

/**
 * The body map with everything around it (build phase 6): front and back side by side when
 * there's room, otherwise one at a time with a Front/Back toggle and a swipe; a Figure/List
 * toggle, so the text equivalent is always one tap away; the legend; the tap-detail sheet; and
 * "Updating…" while the recompute rule rewrites the cache. Light or dark follows the theme.
 */
export function RecoveryFigure({ map, mode, nameOf, thresholds = DEFAULT_THRESHOLDS, timeZone }: Props) {
  const { name } = useTheme();
  const theme: FigureTheme = name === 'night' ? 'dark' : 'light';
  const updating = useRecomputeStatus((s) => s.running > 0);
  const [width, setWidth] = useState(0);
  const [view, setView] = useState<FigureView>('front');
  const [display, setDisplay] = useState<'figure' | 'list'>('figure');
  const [selected, setSelected] = useState<MuscleId | null>(null);

  const both = width >= SIDE_BY_SIDE;
  const figureWidth = Math.min(MAX_FIGURE, both ? (width - space.lg) / 2 : width * 0.62);
  const swipe = Gesture.Pan()
    .runOnJS(true)
    .activeOffsetX([-20, 20])
    .failOffsetY([-15, 15])
    .onEnd((e) => {
      if (e.translationX <= -SWIPE) setView('back');
      else if (e.translationX >= SWIPE) setView('front');
    });

  const figure = (v: FigureView) => (
    <View key={v} style={{ alignItems: 'center', gap: space.xs }}>
      <BodyMap map={map} view={v} mode={mode} theme={theme} thresholds={thresholds} width={figureWidth} onSelect={setSelected} nameOf={nameOf} />
      <T variant="label" tone="mut">{v === 'front' ? 'Front' : 'Back'}</T>
    </View>
  );

  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={{ gap: space.md }}>
      <Segmented
        options={[{ value: 'figure', label: 'Figure' }, { value: 'list', label: 'List' }]}
        value={display}
        onChange={setDisplay}
      />
      {updating ? <T variant="small" tone="mut" align="center">Updating…</T> : null}
      {width === 0 ? null : display === 'list' ? (
        map ? <MuscleList map={map as Record<MuscleId, ListState>} mode={mode} theme={theme} nameOf={nameOf} onSelect={setSelected} /> : null
      ) : both ? (
        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: space.lg }}>{figure('front')}{figure('back')}</View>
      ) : (
        <View style={{ gap: space.sm }}>
          <Segmented options={[{ value: 'front', label: 'Front' }, { value: 'back', label: 'Back' }]} value={view} onChange={setView} />
          <GestureDetector gesture={swipe}>
            <View style={{ alignItems: 'center' }}>{figure(view)}</View>
          </GestureDetector>
        </View>
      )}
      <Legend theme={theme} mode={mode} thresholds={thresholds} />
      <MuscleSheet
        muscle={selected}
        name={selected ? nameOf(selected) : ''}
        theme={theme}
        state={selected && map ? map[selected] : null}
        timeZone={timeZone}
        onClose={() => setSelected(null)}
      />
    </View>
  );
}
