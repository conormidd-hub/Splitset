import { useRef, type ReactNode, type RefObject } from 'react';
import { Pressable, View } from 'react-native';
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

import { T } from '@/components/ui/T';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

/** How far the row slides to show the Delete pane. */
const PANE = 84;

/** One per list: the row whose pane is open, so opening another closes it. */
export type SwipeGroup = RefObject<SwipeableMethods | null>;

/**
 * Slide the row to the right and a red Delete pane comes out from behind its left edge; tapping
 * the pane deletes. A short drag leaves the pane showing (a tap on the row, or another row's
 * swipe, closes it); a swipe back hides it. Nothing happens on a swipe to the left.
 */
export function SwipeToDelete({ children, onDelete, label, openRef }: {
  children: ReactNode;
  onDelete: () => void;
  /** What is deleted, for the pane's screen-reader label ("set 3"). */
  label: string;
  /** The list's open row, shared by its rows. */
  openRef?: SwipeGroup;
}) {
  const ref = useRef<SwipeableMethods | null>(null);
  const remove = () => {
    ref.current?.close();
    onDelete();
  };
  return (
    <ReanimatedSwipeable
      ref={ref}
      friction={1.5}
      leftThreshold={PANE / 2}
      overshootLeft={false}
      enableTrackpadTwoFingerGesture
      renderLeftActions={(progress) => <DeletePane progress={progress} label={label} onPress={remove} />}
      onSwipeableWillOpen={() => {
        if (!openRef) return;
        if (openRef.current && openRef.current !== ref.current) openRef.current.close();
        openRef.current = ref.current;
      }}
      onSwipeableClose={() => {
        if (openRef && openRef.current === ref.current) openRef.current = null;
      }}>
      {children}
    </ReanimatedSwipeable>
  );
}

function DeletePane({ progress, label, onPress }: { progress: SharedValue<number>; label: string; onPress: () => void }) {
  const { palette } = useTheme();
  // the word grows in as the pane is pulled out, so a half-open pane doesn't show a clipped label
  const style = useAnimatedStyle(() => {
    const p = Math.min(1, progress.value);
    return { opacity: p, transform: [{ scale: 0.7 + 0.3 * p }] };
  });
  return (
    <View style={{ width: PANE, paddingRight: space.sm, paddingVertical: 4 }}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`Delete ${label}`}
        style={({ pressed }) => ({ flex: 1, borderRadius: radius.sm, backgroundColor: palette.neg, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.8 : 1 })}>
        <Animated.View style={style}>
          <T variant="small" weight="700" style={{ color: '#ffffff' }}>Delete</T>
        </Animated.View>
      </Pressable>
    </View>
  );
}
