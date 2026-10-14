import { router, type Href } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Pressable, View } from 'react-native';

import { Sparkline } from '@/components/charts/Sparkline';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Chip';
import { T } from '@/components/ui/T';
import { ICONS } from '@/lib/icons';
import { METRICS, type Snapshot } from '@/lib/metrics';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

type Props = {
  /** Null when no In focus metric is chosen yet. */
  snapshot: Snapshot | null;
  /** Opens the picker. */
  onChange: () => void;
};

const WORDY = new Set<Snapshot['id']>(['training_status', 'hrv_status', 'last_activity']);

/** The one big card at the top of Today: the chosen metric, its number, its band and its trend. */
export function InFocusCard({ snapshot: s, onChange }: Props) {
  const { palette } = useTheme();

  if (!s) {
    return (
      <Pressable
        onPress={onChange}
        accessibilityRole="button"
        accessibilityLabel="Pick an In focus metric"
        style={({ pressed }) => ({
          borderWidth: 1.5, borderStyle: 'dashed', borderColor: palette.accentLine, borderRadius: radius.lg,
          padding: space.xl, alignItems: 'center', gap: space.xs, opacity: pressed ? 0.8 : 1,
        })}>
        <SymbolView name={ICONS.plus} tintColor={palette.accent} size={22} />
        <T variant="h3" tone="accent">Pick an In focus metric</T>
        <T variant="small" tone="mut" align="center">The one number you want first every morning, large, with its trend.</T>
      </Pressable>
    );
  }

  const def = METRICS[s.id];
  const wordy = WORDY.has(s.id);
  const sparkPoints = s.spark.filter((p) => p.y != null).length;
  return (
    <Card onPress={() => router.push((s.href ?? `/metric/${s.id}`) as Href)}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <SymbolView name={def.icon} tintColor={palette.accent} size={18} />
        <T variant="h3" numberOfLines={1} style={{ flex: 1 }}>{def.label}</T>
        <Button title="Change" variant="ghost" small onPress={onChange} />
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: space.xs }}>
        <T variant={wordy ? 'h1' : 'display'} numberOfLines={1} style={{ fontVariant: ['tabular-nums'], flexShrink: 1 }}>{s.text}</T>
        {!wordy && s.unit ? <T variant="h3" tone="mut">{s.unit}</T> : null}
      </View>

      {s.sub || s.level ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: 2 }}>
          {s.sub ? <T tone={s.subTone} numberOfLines={1} style={{ flexShrink: 1 }}>{s.sub}</T> : null}
          {s.level ? <Badge label={s.level.label} tone={s.level.tone} /> : null}
        </View>
      ) : null}

      {sparkPoints >= 2 ? (
        <Sparkline points={s.spark} height={56} color={palette.accent} strokeWidth={2} area dot style={{ marginTop: space.md }} />
      ) : null}
    </Card>
  );
}
