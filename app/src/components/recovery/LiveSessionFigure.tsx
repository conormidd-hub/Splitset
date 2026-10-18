import { View } from 'react-native';

import { FigurePair } from './FigurePair';
import { useLiveSession, useMuscleNames } from '@/api/recovery';
import { T } from '@/components/ui/T';
import { MUSCLE_IDS } from '@/lib/recovery/library';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

const FIGURE_WIDTH = 46;
const NAMED = 3;

/**
 * The live workout's small session figure (build phase 7): this workout's ticked sets, scored on
 * the fly, so it fills in as sets are completed. Tapping a muscle shows its load and when it
 * will be trainable and ready after this session.
 */
export function LiveSessionFigure() {
  const live = useLiveSession();
  const names = useMuscleNames();
  const { palette } = useTheme();
  if (!live) return null;
  const s = live.session;
  // muscles above Ready, heaviest first; a sliver of load on a muscle reads as nothing yet
  const loaded = MUSCLE_IDS.filter((id) => s[id].level > 0).sort((a, b) => s[b].L - s[a].L);

  return (
    <View
      style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, backgroundColor: palette.surface, borderRadius: radius.md,
        borderWidth: 1, borderColor: palette.hair, padding: space.sm }}>
      <FigurePair map={s} mode="session" figureWidth={FIGURE_WIDTH} nameOf={names} detail />
      <View style={{ flex: 1, gap: 2 }}>
        <T variant="label" tone="mut">This session</T>
        {loaded.length ? (
          <T variant="small" tone="ink2">
            {loaded.slice(0, NAMED).map((id) => `${names(id)} ${s[id].label.toLowerCase()}`).join(' · ')}
            {loaded.length > NAMED ? ` · +${loaded.length - NAMED} more` : ''}
          </T>
        ) : (
          <T variant="small" tone="mut">{MUSCLE_IDS.some((id) => s[id].L > 0) ? 'Light so far: nothing above Ready yet.' : 'Fills in as you tick sets.'}</T>
        )}
      </View>
    </View>
  );
}
