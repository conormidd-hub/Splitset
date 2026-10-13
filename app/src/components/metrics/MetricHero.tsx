import { SymbolView } from 'expo-symbols';
import { View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Chip';
import { T } from '@/components/ui/T';
import { relativeDay } from '@/lib/dates';
import type { Level, MetricDef, Snapshot } from '@/lib/metrics';
import { INTERVALS_SETTINGS, openExternal } from '@/lib/openExternal';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';
import { LevelMeter } from './LevelMeter';

type Props = {
  def: MetricDef;
  snap: Snapshot;
  /** Overrides the snapshot's level; null hides it. */
  level?: Level | null;
  levelLabels?: readonly string[];
};

/** The top of a metric page: the number as big as it goes, with its unit, date and verdict. */
export function MetricHero({ def, snap, level: levelProp, levelLabels }: Props) {
  const { palette } = useTheme();
  const level = levelProp === undefined ? snap.level : levelProp;

  if (!def.available) {
    return (
      <View style={{ gap: space.sm, paddingVertical: space.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <SymbolView name={def.icon} tintColor={palette.mut} size={22} />
          <T variant="h2">{def.label}</T>
        </View>
        <T variant="h3" tone="mut">Not available through intervals.icu</T>
        <T tone="ink2">{def.unavailableReason}</T>
        <Button
          title="Open intervals.icu settings"
          variant="secondary"
          small
          onPress={() => openExternal(INTERVALS_SETTINGS)}
          style={{ alignSelf: 'flex-start' }}
        />
      </View>
    );
  }

  return (
    <View style={{ gap: space.xs, paddingVertical: space.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <SymbolView name={def.icon} tintColor={palette.accent} size={22} />
        <T variant="h2">{def.label}</T>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: space.xs, flexWrap: 'wrap' }}>
        <T variant="display" tone={snap.value == null && snap.text === '–' ? 'mut' : 'ink'} style={{ fontVariant: ['tabular-nums'] }}>{snap.text}</T>
        {snap.unit ? <T variant="h3" tone="mut">{snap.unit}</T> : null}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' }}>
        {snap.date ? <T variant="small" tone="mut">{relativeDay(snap.date)}</T> : null}
        {snap.sub ? <T variant="small" tone={snap.subTone} weight="600">{snap.sub}</T> : null}
      </View>
      {level ? (
        <View style={{ gap: space.sm, marginTop: space.xs, alignItems: 'flex-start' }}>
          <Badge label={level.label} tone={level.tone} />
          {level.of > 1 ? <LevelMeter index={level.index} of={level.of} tone={level.tone} labels={levelLabels} /> : null}
        </View>
      ) : null}
    </View>
  );
}
