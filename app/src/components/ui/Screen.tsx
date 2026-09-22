import type { ReactNode } from 'react';
import { RefreshControl, ScrollView, View, type ViewStyle } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';

import { T } from './T';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

type Props = {
  children: ReactNode;
  /** Big in-screen title, used on tab roots that have no navigation header. */
  title?: string;
  subtitle?: string;
  right?: ReactNode;
  scroll?: boolean;
  padded?: boolean;
  edges?: Edge[];
  refreshing?: boolean;
  onRefresh?: () => void;
  style?: ViewStyle;
};

export function Screen({
  children, title, subtitle, right, scroll = true, padded = true,
  edges = ['left', 'right'], refreshing, onRefresh, style,
}: Props) {
  const { palette } = useTheme();
  const header = title ? (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: space.sm }}>
      <View style={{ flex: 1 }}>
        {subtitle ? <T variant="label" tone="mut">{subtitle}</T> : null}
        <T variant="display">{title}</T>
      </View>
      {right}
    </View>
  ) : null;

  const content = (
    <View style={[padded ? { padding: space.lg, gap: space.md } : null, style]}>
      {header}
      {children}
    </View>
  );

  return (
    <SafeAreaView edges={edges} style={{ flex: 1, backgroundColor: palette.bg }}>
      {scroll ? (
        <ScrollView
          contentContainerStyle={{ paddingBottom: space.xxl }}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={palette.mut} /> : undefined
          }>
          {content}
        </ScrollView>
      ) : (
        <View style={{ flex: 1 }}>{content}</View>
      )}
    </SafeAreaView>
  );
}
