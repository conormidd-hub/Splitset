import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import { T } from './T';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

type Props = {
  title: string;
  subtitle?: string;
  value?: string;
  valueSub?: string;
  badge?: ReactNode;
  onPress?: () => void;
  first?: boolean;
};

/** One line in a list: title and subtitle on the left, a number and its unit on the right. */
export function ListRow({ title, subtitle, value, valueSub, badge, onPress, first }: Props) {
  const { palette } = useTheme();
  const inner = (
    <View
      style={{
        flexDirection: 'row', alignItems: 'center', gap: space.md,
        paddingVertical: space.md, borderTopWidth: first ? 0 : 1, borderTopColor: palette.hair,
      }}>
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <T variant="h3" numberOfLines={1} style={{ flexShrink: 1 }}>{title}</T>
          {badge}
        </View>
        {subtitle ? <T variant="small" tone="mut" numberOfLines={1}>{subtitle}</T> : null}
      </View>
      {value ? (
        <View style={{ alignItems: 'flex-end' }}>
          <T variant="h3" style={{ fontVariant: ['tabular-nums'] }}>{value}</T>
          {valueSub ? <T variant="small" tone="mut">{valueSub}</T> : null}
        </View>
      ) : null}
      {onPress ? <T tone="mut">›</T> : null}
    </View>
  );
  return onPress ? (
    <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>{inner}</Pressable>
  ) : inner;
}
