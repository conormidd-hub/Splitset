import { memo, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';

import { KeyButton, KeyStrip } from './FigureKey';
import { FigurePair } from './FigurePair';
import { SessionMuscleRows } from './RecoveryExtras';
import { useLiveSession, useMuscleNames, useRecoveryMap } from '@/api/recovery';
import { Segmented } from '@/components/ui/Chip';
import { T } from '@/components/ui/T';
import { MUSCLE_IDS, type MuscleId } from '@/lib/recovery/library';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

const FIGURE_WIDTH = 46;
/** The opened figure: the workout summary's size, big enough to tap a muscle on. */
const OPEN_WIDTH = 110;
const NAMED = 3;

type LiveView = 'body' | 'session';

/**
 * The live workout's figure (build phase 7), in two views. Body (the default) is the recovery map
 * as it stands right now with this session folded in: every muscle coloured by what it is carrying,
 * and the muscles this session has loaded wearing a glowing outline, so today's work stands out
 * from Tuesday's. This session is the session map alone: only this workout's load, nothing else.
 * At 46 pt a muscle is too small to tap, so the whole card is the target: it opens a larger
 * figure with the Body / This session switch, where tapping a muscle shows its detail (and, on
 * Body, what this session did to it), and a row per loaded muscle.
 *
 * Memoised, with no props: the workout screen re-renders every second for its clocks, and this
 * only needs to when the workout, the queries or the minute change.
 */
export const LiveSessionFigure = memo(function LiveSessionFigure() {
  const live = useLiveSession();
  const body = useRecoveryMap();
  const before = useRecoveryMap(undefined, { live: false });
  const names = useMuscleNames();
  const { palette } = useTheme();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<LiveView>('body');
  const s = live?.session ?? null;
  // muscles above Ready, heaviest first; a sliver of load on a muscle reads as nothing yet
  const loaded = useMemo(() => (s ? MUSCLE_IDS.filter((id) => s[id].level > 0).sort((a, b) => s[b].L - s[a].L) : []), [s]);
  const glow = useMemo(() => new Set<MuscleId>(loaded), [loaded]);
  if (!live || !s) return null;
  const summary = loaded.length
    ? loaded.slice(0, NAMED).map((id) => `${names(id)} ${s[id].label.toLowerCase()}`).join(' · ')
      + (loaded.length > NAMED ? ` · +${loaded.length - NAMED} more` : '')
    : MUSCLE_IDS.some((id) => s[id].L > 0) ? 'Light so far: nothing above Ready yet.' : 'Fills in as you tick sets.';

  // Body until the recovery map has loaded, then whichever is picked
  const showBody = view === 'body' && !!body.data;
  const map = showBody ? body.data : s;
  const mode = showBody ? 'recovery' : 'session';
  const title = showBody ? 'Body now · this session glows' : 'This session';

  return (
    <View style={{ backgroundColor: palette.surface, borderRadius: radius.md, borderWidth: 1, borderColor: palette.hair }}>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${title}: ${summary}`}
        accessibilityHint={open ? 'Hides the muscles' : "Shows each muscle's load, and when it is trainable and ready"}
        style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.sm, minHeight: 44, opacity: pressed ? 0.7 : 1 })}>
        <FigurePair map={map} mode={mode} figureWidth={FIGURE_WIDTH} nameOf={names} glow={showBody ? glow : undefined} />
        <View style={{ flex: 1, gap: 2 }}>
          <T variant="label" tone="mut">{title}</T>
          <T variant="small" tone={loaded.length ? 'ink2' : 'mut'}>{summary}</T>
        </View>
        <KeyButton mode={mode} glow={showBody} size={26} />
        <T tone="mut" accessible={false} importantForAccessibility="no" style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}>›</T>
      </Pressable>
      {/* outside the Pressable, so a tap on a muscle opens its sheet without closing the card */}
      {open ? (
        <View style={{ gap: space.md, paddingHorizontal: space.md, paddingBottom: space.md }}>
          <Segmented<LiveView>
            options={[{ value: 'body', label: 'Body' }, { value: 'session', label: 'This session' }]}
            value={view}
            onChange={setView}
            label="Show"
          />
          <FigurePair map={map} mode={mode} figureWidth={OPEN_WIDTH} nameOf={names} detail labels glow={showBody ? glow : undefined} before={showBody ? before.data : null} />
          <T variant="small" tone="mut">
            {showBody
              ? 'Every muscle as it stands now, this session included. A glowing outline marks what this session has loaded; tap one for before and after.'
              : "Only this workout's load. Tap a muscle for when it is trainable and ready again."}
          </T>
          <KeyStrip mode={mode} glow={showBody} />
          <SessionMuscleRows session={s} nameOf={names} />
        </View>
      ) : null}
    </View>
  );
});
