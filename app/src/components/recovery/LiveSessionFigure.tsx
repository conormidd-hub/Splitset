import { memo, useState } from 'react';
import { Pressable, View } from 'react-native';

import { FigurePair } from './FigurePair';
import { SessionMuscleRows } from './RecoveryExtras';
import { useLiveSession, useMuscleNames } from '@/api/recovery';
import { T } from '@/components/ui/T';
import { MUSCLE_IDS } from '@/lib/recovery/library';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

const FIGURE_WIDTH = 46;
/** The opened figure: the workout summary's size, big enough to tap a muscle on. */
const OPEN_WIDTH = 110;
const NAMED = 3;

/**
 * The live workout's small session figure (build phase 7): this workout's ticked sets, scored on
 * the fly, so it fills in as sets are completed. At 46 pt a muscle is too small to tap, so the
 * whole card is the target: it opens a larger figure, where tapping a muscle shows its load and
 * when it will be trainable and ready after this session, and a row per loaded muscle.
 *
 * Memoised, with no props: the workout screen re-renders every second for its clocks, and this
 * only needs to when the workout, the queries or the hour change.
 */
export const LiveSessionFigure = memo(function LiveSessionFigure() {
  const live = useLiveSession();
  const names = useMuscleNames();
  const { palette } = useTheme();
  const [open, setOpen] = useState(false);
  if (!live) return null;
  const s = live.session;
  // muscles above Ready, heaviest first; a sliver of load on a muscle reads as nothing yet
  const loaded = MUSCLE_IDS.filter((id) => s[id].level > 0).sort((a, b) => s[b].L - s[a].L);
  const summary = loaded.length
    ? loaded.slice(0, NAMED).map((id) => `${names(id)} ${s[id].label.toLowerCase()}`).join(' · ')
      + (loaded.length > NAMED ? ` · +${loaded.length - NAMED} more` : '')
    : MUSCLE_IDS.some((id) => s[id].L > 0) ? 'Light so far: nothing above Ready yet.' : 'Fills in as you tick sets.';

  return (
    <View style={{ backgroundColor: palette.surface, borderRadius: radius.md, borderWidth: 1, borderColor: palette.hair }}>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`This session: ${summary}`}
        accessibilityHint={open ? 'Hides the muscles' : "Shows each muscle's load, and when it is trainable and ready"}
        style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.sm, minHeight: 44, opacity: pressed ? 0.7 : 1 })}>
        <FigurePair map={s} mode="session" figureWidth={FIGURE_WIDTH} nameOf={names} />
        <View style={{ flex: 1, gap: 2 }}>
          <T variant="label" tone="mut">This session</T>
          <T variant="small" tone={loaded.length ? 'ink2' : 'mut'}>{summary}</T>
        </View>
        <T tone="mut" accessible={false} importantForAccessibility="no" style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}>›</T>
      </Pressable>
      {/* outside the Pressable, so a tap on a muscle opens its sheet without closing the card */}
      {open ? (
        <View style={{ gap: space.md, paddingHorizontal: space.md, paddingBottom: space.md }}>
          <FigurePair map={s} mode="session" figureWidth={OPEN_WIDTH} nameOf={names} detail labels />
          <SessionMuscleRows session={s} nameOf={names} />
        </View>
      ) : null}
    </View>
  );
});
