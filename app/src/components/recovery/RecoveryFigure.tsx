import { useEffect, useState, type ReactNode } from 'react';
import { Animated, Platform, Pressable, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

import { BodyMap } from './BodyMap';
import { Legend } from './Legend';
import { MuscleList } from './MuscleList';
import { MuscleSheet } from './MuscleSheet';
import { catchUpActivities, useRecomputeStatus } from '@/api/workoutLoads';
import type { RecoveryMap, SessionMap } from '@/api/recovery';
import { Segmented } from '@/components/ui/Chip';
import { T } from '@/components/ui/T';
import { DEFAULT_THRESHOLDS } from '@/lib/recovery/constants';
import { listCompact, type FigureTheme, type FigureView, type ListState, type MapMode } from '@/lib/recovery/figure';
import type { MuscleId } from '@/lib/recovery/library';
import type { Thresholds } from '@/lib/recovery/thresholds';
import { useUserId } from '@/lib/session';
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
  /** The map being left (the history slider): drawn under `map` while `map` fades in over it. */
  previous?: RecoveryMap | SessionMap | null;
  /** Changes whenever `map` is a new day, to restart the fade. */
  fadeKey?: string | number;
  /** The fade has finished; the caller drops `previous`. */
  onFaded?: () => void;
  /** What the map shows, for screen readers (e.g. "fatigue on Tue 13 Oct"); BodyMap's default otherwise. */
  context?: string;
};

/** Crossfade length for the history slider (build phase 9). */
const FADE_MS = 250;

/** Fades its child in from transparent when it mounts; a new key remounts it. */
function FadeIn({ children, onDone }: { children: ReactNode; onDone?: () => void }) {
  const [opacity] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.timing(opacity, { toValue: 1, duration: FADE_MS, useNativeDriver: Platform.OS !== 'web' })
      .start(({ finished }) => { if (finished) onDone?.(); });
  }, [opacity, onDone]);
  return <Animated.View style={{ opacity }}>{children}</Animated.View>;
}

/**
 * The body map with everything around it (build phase 6): front and back side by side when
 * there's room, otherwise one at a time with a Front/Back toggle and a swipe; a Figure/List
 * toggle, so the text equivalent is always one tap away; the legend; the tap-detail sheet;
 * "Updating…" while the recompute rule rewrites the cache, and its error, or the activity
 * catch-up's, with "Try again" if the last one failed.
 * Light or dark follows the theme.
 */
export function RecoveryFigure({ map, mode, nameOf, thresholds = DEFAULT_THRESHOLDS, timeZone, previous, fadeKey, onFaded, context }: Props) {
  const { name } = useTheme();
  const theme: FigureTheme = name === 'night' ? 'dark' : 'light';
  const updating = useRecomputeStatus((s) => s.running > 0);
  const failed = useRecomputeStatus((s) => s.lastError);
  const catchUpFailed = useRecomputeStatus((s) => s.catchUpError);
  const uid = useUserId();
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
      <View>
        {previous ? (
          // the day being left is only there for the fade; screen readers get the new one alone
          <View style={{ position: 'absolute', top: 0, left: 0 }} pointerEvents="none" aria-hidden>
            <BodyMap map={previous} view={v} mode={mode} theme={theme} thresholds={thresholds} width={figureWidth} nameOf={nameOf} />
          </View>
        ) : null}
        {fadeKey != null && previous ? (
          <FadeIn key={fadeKey} onDone={onFaded}>
            <BodyMap map={map} view={v} mode={mode} theme={theme} thresholds={thresholds} width={figureWidth} onSelect={setSelected} nameOf={nameOf} context={context} />
          </FadeIn>
        ) : (
          <BodyMap map={map} view={v} mode={mode} theme={theme} thresholds={thresholds} width={figureWidth} onSelect={setSelected} nameOf={nameOf} context={context} />
        )}
      </View>
      <T variant="label" tone="mut">{v === 'front' ? 'Front' : 'Back'}</T>
    </View>
  );

  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={{ gap: space.md }}>
      <Segmented
        options={[{ value: 'figure', label: 'Figure' }, { value: 'list', label: 'List' }]}
        value={display}
        onChange={setDisplay}
        label="Show as"
      />
      {updating ? <T variant="small" tone="mut" align="center">Updating…</T> : null}
      {!updating && (failed || catchUpFailed) ? (
        <View style={{ alignItems: 'center', gap: 2 }}>
          <T variant="small" tone="neg" align="center">
            {failed ? `Couldn't update the recovery map: ${failed}` : `Couldn't add your runs and rides: ${catchUpFailed}`}
          </T>
          {/* a forced catch-up also redoes a recompute that failed */}
          <Pressable onPress={() => { if (uid) void catchUpActivities(uid, true); }} accessibilityRole="button" hitSlop={10}>
            <T variant="small" tone="accent" weight="600">Try again</T>
          </Pressable>
        </View>
      ) : null}
      {width === 0 ? null : display === 'list' ? (
        map ? <MuscleList map={map as Record<MuscleId, ListState>} mode={mode} theme={theme} nameOf={nameOf} onSelect={setSelected} compact={listCompact(width)} /> : null
      ) : both ? (
        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: space.lg }}>{figure('front')}{figure('back')}</View>
      ) : (
        <View style={{ gap: space.sm }}>
          <Segmented options={[{ value: 'front', label: 'Front' }, { value: 'back', label: 'Back' }]} value={view} onChange={setView} label="Body side" />
          {/* pan-y so a vertical swipe on the figure still scrolls the page in a phone browser */}
          <GestureDetector gesture={swipe} touchAction="pan-y">
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
