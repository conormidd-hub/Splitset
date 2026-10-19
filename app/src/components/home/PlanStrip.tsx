import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Pressable, View } from 'react-native';

import { planTypeLabel, type PlanSession } from '@/api/plan';
import { Badge } from '@/components/ui/Chip';
import { T } from '@/components/ui/T';
import { ICONS, type IconName } from '@/lib/icons';
import { formatDistance, type Units } from '@/lib/units';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

const TYPE_ICON: Record<string, IconName> = {
  run: ICONS.run, ride: ICONS.ride, strength: ICONS.lift, walk: ICONS.walk, rest: ICONS.moon, other: ICONS.cardio,
};

/**
 * Today's plan as one thin line under the streak: the first session (its kind, title and
 * distance) and how many more, or a rest day. Tapping opens the session, or the Plan tab.
 */
export function PlanStrip({ sessions, loaded, units }: { sessions: readonly PlanSession[]; loaded: boolean; units: Units }) {
  const { palette } = useTheme();
  const first = sessions[0];
  const more = sessions.length - 1;
  const detail = first
    ? [planTypeLabel(first.type), first.target_distance_m ? formatDistance(first.target_distance_m, units, 1) : null].filter(Boolean).join(' · ')
    : null;
  const title = first ? first.title : loaded ? 'Rest day: nothing planned' : 'Today’s plan';
  const status = first?.status;

  return (
    <Pressable
      onPress={() => router.push(first ? `/plan/${first.id}` : '/plan')}
      accessibilityRole="button"
      accessibilityLabel={`Today's plan: ${title}${detail ? `, ${detail}` : ''}${status && status !== 'planned' ? `, ${status}` : ''}${more > 0 ? `, and ${more} more` : ''}`}
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 44, paddingHorizontal: space.md, paddingVertical: space.sm,
        backgroundColor: palette.surface, borderRadius: radius.md, borderWidth: 1, borderColor: palette.hair,
        borderLeftWidth: 3, borderLeftColor: first ? palette.accent : palette.hair, opacity: pressed ? 0.8 : 1,
      })}>
      <SymbolView name={first ? TYPE_ICON[first.type] ?? ICONS.cardio : ICONS.moon} tintColor={first ? palette.accent : palette.mut} size={16} />
      <T variant="label" tone="mut">Today</T>
      <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
        <T weight="600" numberOfLines={1} style={{ flexShrink: 1 }}>{title}</T>
        {detail ? <T variant="small" tone="mut" numberOfLines={1} style={{ flexShrink: 2 }}>{detail}</T> : null}
      </View>
      {more > 0 ? <T variant="small" tone="mut">+{more}</T> : null}
      {status && status !== 'planned' ? <Badge label={status} tone={status === 'done' ? 'pos' : 'neg'} /> : null}
      <T tone="mut">›</T>
    </Pressable>
  );
}
