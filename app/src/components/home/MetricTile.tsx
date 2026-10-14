import { SymbolView } from 'expo-symbols';
import { Pressable, View } from 'react-native';

import { Sparkline } from '@/components/charts/Sparkline';
import { T } from '@/components/ui/T';
import { ICONS } from '@/lib/icons';
import { METRICS, type Snapshot } from '@/lib/metrics';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

/** Every At a glance tile is this tall, so the grid is geometry rather than measurement. */
export const TILE_HEIGHT = 104;

type Props = {
  snapshot: Snapshot;
  /** Edit mode: a minus where the icon was, a grip on the right, a dashed border. */
  editing?: boolean;
  /** The tile being dragged stays in the grid as a faint placeholder. */
  lifted?: boolean;
  onRemove?: () => void;
};

/** Tiles whose value is a word (a status, an activity name) rather than a number. */
const WORDY = new Set<Snapshot['id']>(['training_status', 'hrv_status', 'last_activity']);

/**
 * One At a glance card, Garmin Connect style: what it is, the latest number with its unit, how
 * it compares, and the last week's shape in the corner. The tap and the drag live in the grid
 * around it, so this stays a plain view.
 */
export function MetricTile({ snapshot: s, editing = false, lifted = false, onRemove }: Props) {
  const { palette } = useTheme();
  const def = METRICS[s.id];
  const wordy = WORDY.has(s.id);
  const spark = s.spark.filter((p) => p.y != null).slice(-7);
  const showSpark = spark.length >= 3;

  return (
    <View
      style={{
        height: TILE_HEIGHT, backgroundColor: palette.surface, borderRadius: radius.md, overflow: 'hidden',
        borderWidth: 1, borderColor: editing ? palette.accentLine : palette.hair, borderStyle: editing ? 'dashed' : 'solid',
        paddingHorizontal: space.md, paddingTop: space.sm + 2, paddingBottom: space.md,
        opacity: lifted ? 0.25 : 1,
      }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 22 }}>
        {editing ? (
          <Pressable
            onPress={onRemove}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Remove ${def.label}`}
            style={({ pressed }) => ({
              width: 22, height: 22, borderRadius: 11, backgroundColor: palette.neg,
              alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.7 : 1,
            })}>
            <SymbolView name={ICONS.minus} tintColor={palette.onAccent} size={14} />
          </Pressable>
        ) : (
          <SymbolView name={def.icon} tintColor={palette.mut} size={16} />
        )}
        <T variant="label" tone="mut" numberOfLines={1} style={{ flexShrink: 1 }}>{def.short}</T>
        {editing ? (
          <View style={{ marginLeft: 'auto' }}>
            <SymbolView name={ICONS.grip} tintColor={palette.mut} size={18} />
          </View>
        ) : null}
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4, marginTop: 2 }}>
        <T variant={wordy ? 'h2' : 'h1'} numberOfLines={1} style={{ fontVariant: ['tabular-nums'], flexShrink: 1 }}>{s.text}</T>
        {!wordy && s.unit ? <T variant="small" tone="mut">{s.unit}</T> : null}
      </View>

      {s.sub ? (
        <T variant="small" tone={s.subTone} numberOfLines={1} style={{ marginTop: 'auto', paddingRight: showSpark ? 44 : 0 }}>{s.sub}</T>
      ) : null}

      {showSpark ? (
        <Sparkline
          points={spark}
          width={36}
          height={18}
          color={palette.accent}
          strokeWidth={1.5}
          style={{ position: 'absolute', right: space.md, bottom: space.md }}
        />
      ) : null}
    </View>
  );
}
