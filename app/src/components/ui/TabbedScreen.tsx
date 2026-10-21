import { SymbolView } from 'expo-symbols';
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  Animated, Easing, Platform, Pressable, RefreshControl, ScrollView, View,
  type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { EdgeFade, FADE } from './BarButtons';
import { T } from './T';
import { ICONS, type IconKey } from '@/lib/icons';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

export type TabDef<K extends string> = { key: K; label: string; icon: IconKey };

/** How close to the bottom (px) a scroll asks the open tab for more. */
const END_REACHED = 600;
const ROW_HEIGHT = 46;
/** How far a tab's content slides in from the side it was picked on. */
const SLIDE = 28;
/** How far a pull past the top (pull to refresh) carries a pinned hero down with it. */
const PULL = 300;

/** The collapse progress of a pinned hero: 0 open, 1 collapsed. */
export type HeroProgress = Animated.AnimatedInterpolation<number>;

type Props<K extends string> = {
  /** The bar that stays above everything (ScreenTopBar). */
  topBar: ReactNode;
  /** What sits at the top of the page (the recovery figure, the run map). Scrolls away under the
   *  bar, or with `pinnedHero` stays put and shrinks, in which case it may be a function of the
   *  collapse progress. */
  hero: ReactNode | ((progress: HeroProgress) => ReactNode);
  /** Pin the hero above the page instead of scrolling it away: it shrinks from `from` to `to` tall
   *  over the first `from − to` px of scroll and stays there, with the tab row under it, so what it
   *  shows (a map) is still in view far down the page. Both heights include the hero's own padding. */
  pinnedHero?: { from: number; to: number };
  tabs: readonly TabDef<K>[];
  tab: K;
  onTab: (tab: K) => void;
  /** The open tab's content. */
  children: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
  /** Off while something inside is being dragged, so the page holds still under the finger. */
  scrollEnabled?: boolean;
  scrollRef?: RefObject<ScrollView | null>;
  onScroll?: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  /** Near the bottom of the page: the open tab may load its next page. */
  onEndReached?: () => void;
  /** Laid over the screen (sheets, quick views). */
  overlay?: ReactNode;
};

/**
 * A tab root laid out the way Strava's You screen is: a top bar of round buttons, a hero that
 * scrolls up and fades away under it (or, pinned, shrinks and stays), then a row of tabs that
 * sticks under the bar while the open tab's content scrolls beneath. Picking a tab slides its
 * content in from that side.
 */
export function TabbedScreen<K extends string>({
  topBar, hero, pinnedHero, tabs, tab, onTab, children, refreshing, onRefresh, scrollEnabled = true, scrollRef, onScroll, onEndReached, overlay,
}: Props<K>) {
  const { palette } = useTheme();
  const index = Math.max(0, tabs.findIndex((t) => t.key === tab));
  const [slide] = useState(() => new Animated.Value(0));
  const [rowW, setRowW] = useState(0);
  const [viewH, setViewH] = useState(0);
  const [under] = useState(() => new Animated.Value(index));
  const shown = useRef(index);
  // the page's offset, for a pinned hero's collapse (a layout animation, so not on the native driver)
  const [scrollY] = useState(() => new Animated.Value(0));
  const range = Math.max(1, (pinnedHero?.from ?? 1) - (pinnedHero?.to ?? 0));
  const progress = useMemo<HeroProgress>(
    () => scrollY.interpolate({ inputRange: [0, range], outputRange: [0, 1], extrapolate: 'clamp' }),
    [scrollY, range],
  );

  // the new tab's content comes in from the side it was picked on, and the underline follows.
  // Before paint, so the content never flashes in place first
  useLayoutEffect(() => {
    if (shown.current !== index) {
      slide.setValue(index > shown.current ? SLIDE : -SLIDE);
      shown.current = index;
    }
    const native = Platform.OS !== 'web';
    Animated.parallel([
      Animated.timing(slide, { toValue: 0, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: native }),
      Animated.timing(under, { toValue: index, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: native }),
    ]).start();
  }, [index, slide, under]);

  const tabW = tabs.length ? rowW / tabs.length : 0;
  const heroNode = typeof hero === 'function' ? hero(progress) : hero;

  const tabRow = (
    <View>
      <View
        accessibilityRole="tablist"
        onLayout={(e: LayoutChangeEvent) => setRowW(e.nativeEvent.layout.width)}
        style={{ height: ROW_HEIGHT, flexDirection: 'row', backgroundColor: palette.bg, borderBottomWidth: 1, borderBottomColor: palette.hair }}>
        {tabs.map((t) => {
          const on = t.key === tab;
          return (
            <Pressable
              key={t.key}
              onPress={() => onTab(t.key)}
              accessibilityRole="tab"
              aria-selected={on}
              accessibilityState={{ selected: on }}
              accessibilityLabel={t.label}
              style={({ pressed }) => ({ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, opacity: pressed ? 0.7 : 1 })}>
              <SymbolView name={ICONS[t.icon]} tintColor={on ? palette.accent : palette.mut} size={17} />
              <T variant="small" weight={on ? '700' : '500'} tone={on ? 'ink' : 'mut'} numberOfLines={1}>{t.label}</T>
            </Pressable>
          );
        })}
        {tabW ? (
          <Animated.View
            pointerEvents="none"
            style={{
              position: 'absolute', bottom: -1, left: 0, width: tabW, height: 2.5, alignItems: 'center',
              transform: [{ translateX: under.interpolate({ inputRange: [0, Math.max(1, tabs.length - 1)], outputRange: [0, tabW * Math.max(1, tabs.length - 1)] }) }],
            }}>
            <View style={{ width: Math.min(tabW - 2 * space.md, 72), height: 2.5, borderRadius: 2, backgroundColor: palette.accent }} />
          </Animated.View>
        ) : null}
      </View>
      <View style={{ height: 0 }}>
        <EdgeFade height={14} />
      </View>
    </View>
  );

  const handleScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (pinnedHero) scrollY.setValue(e.nativeEvent.contentOffset.y);
    onScroll?.(e);
    if (!onEndReached) return;
    const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
    if (layoutMeasurement.height + contentOffset.y >= contentSize.height - END_REACHED) onEndReached();
  };

  const content = (minHeight: number | undefined) => (
    <Animated.View
      style={{
        padding: space.lg, paddingTop: space.md, gap: space.md,
        // at least a screen's worth under the row, so the row can always reach the bar and stick
        // (or a pinned hero can always collapse), and switching to a short tab never drops the page
        minHeight,
        opacity: slide.interpolate({ inputRange: [-SLIDE, 0, SLIDE], outputRange: [0.2, 1, 0.2] }),
        transform: [{ translateX: slide }],
      }}>
      {children}
    </Animated.View>
  );

  if (pinnedHero) {
    // the hero and the tab row lie over the page, which scrolls under them; the hero's height
    // follows the scroll, so the page's top edge stays flush with it as it shrinks
    const headerH = pinnedHero.from + ROW_HEIGHT;
    const heroH = progress.interpolate({ inputRange: [0, 1], outputRange: [pinnedHero.from, pinnedHero.to] });
    // a pull past the top (to refresh) carries the header down with it, so the spinner shows
    const pull = scrollY.interpolate({ inputRange: [-PULL, 0], outputRange: [PULL, 0], extrapolate: 'clamp' });
    return (
      <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1, backgroundColor: palette.bg }}>
        {topBar}
        <View style={{ flex: 1 }}>
          <ScrollView
            ref={scrollRef}
            onLayout={(e: LayoutChangeEvent) => setViewH(e.nativeEvent.layout.height)}
            scrollEnabled={scrollEnabled}
            keyboardShouldPersistTaps="handled"
            automaticallyAdjustKeyboardInsets
            keyboardDismissMode="interactive"
            scrollEventThrottle={16}
            onScroll={handleScroll}
            contentContainerStyle={{ paddingTop: headerH, paddingBottom: space.xxl }}
            refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={palette.mut} progressViewOffset={headerH} /> : undefined}>
            {content(viewH ? viewH - pinnedHero.to - ROW_HEIGHT : undefined)}
          </ScrollView>
          <Animated.View style={{ position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: palette.bg, transform: [{ translateY: pull }] }}>
            <Animated.View style={{ height: heroH, overflow: 'hidden', paddingHorizontal: space.lg, paddingTop: space.xs }}>{heroNode}</Animated.View>
            {tabRow}
          </Animated.View>
        </View>
        {overlay}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1, backgroundColor: palette.bg }}>
      {topBar}
      <ScrollView
        ref={scrollRef}
        onLayout={(e: LayoutChangeEvent) => setViewH(e.nativeEvent.layout.height)}
        stickyHeaderIndices={[1]}
        scrollEnabled={scrollEnabled}
        keyboardShouldPersistTaps="handled"
        // as Screen does: iOS makes room for the keyboard and scrolls a focused field above it
        automaticallyAdjustKeyboardInsets
        keyboardDismissMode="interactive"
        scrollEventThrottle={16}
        onScroll={handleScroll}
        contentContainerStyle={{ paddingBottom: space.xxl }}
        refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={palette.mut} /> : undefined}>
        <View style={{ paddingHorizontal: space.lg, paddingTop: space.xs }}>{heroNode}</View>

        {/* the tab row: sticks under the bar, on a strip of page colour as tall as the bar's fade so
            nothing shows above it once stuck; the page fades again as it slides under the row */}
        <View>
          <View style={{ height: FADE, backgroundColor: palette.bg }} />
          {tabRow}
        </View>

        {content(viewH ? viewH - FADE - ROW_HEIGHT : undefined)}
      </ScrollView>
      {overlay}
    </SafeAreaView>
  );
}
