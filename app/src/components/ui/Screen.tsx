import type { ReactNode, RefObject } from 'react';
import { RefreshControl, ScrollView, View, type NativeScrollEvent, type NativeSyntheticEvent, type ViewStyle } from 'react-native';
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
  /** Off while something inside is being dragged, so the page holds still under the finger. */
  scrollEnabled?: boolean;
  /** For a child that scrolls the page itself (a drag near the edge). */
  scrollRef?: RefObject<ScrollView | null>;
  onScroll?: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  style?: ViewStyle;
};

export function Screen({
  children, title, subtitle, right, scroll = true, padded = true,
  edges, refreshing, onRefresh, scrollEnabled = true, scrollRef, onScroll, style,
}: Props) {
  // a screen that draws its own title is a tab root with no navigation header above it, so it
  // keeps clear of the status bar itself; under a header, the header already does
  const safeEdges: Edge[] = edges ?? (title ? ['top', 'left', 'right'] : ['left', 'right']);
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
    <SafeAreaView edges={safeEdges} style={{ flex: 1, backgroundColor: palette.bg }}>
      {scroll ? (
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={{ paddingBottom: space.xxl }}
          keyboardShouldPersistTaps="handled"
          // iOS: the page makes room for the keyboard and scrolls the focused field above it, and
          // a swipe down puts away the number pads, which have no Return key
          automaticallyAdjustKeyboardInsets
          keyboardDismissMode="interactive"
          scrollEnabled={scrollEnabled}
          onScroll={onScroll}
          scrollEventThrottle={onScroll ? 16 : undefined}
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
