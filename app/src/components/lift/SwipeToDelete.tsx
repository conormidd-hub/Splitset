import { useRef, useState, type ReactNode, type RefObject } from 'react';
import { Pressable, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated, { runOnJS, useAnimatedReaction, useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated';

import { T } from '@/components/ui/T';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

/** How far the row slides to show the Delete pane. */
const PANE = 84;
/** Dragged this far across its own width, the row deletes on release without a tap. */
const FULL_SWIPE = 0.5;

/** One per list: the row whose pane is open, so opening another closes it. */
export type SwipeGroup = RefObject<SwipeableMethods | null>;

/**
 * Slide the row to the right and a red Delete pane comes out from behind its left edge; tapping
 * the pane deletes. A short drag leaves the pane showing (a tap on the row, or another row's
 * swipe, closes it); a swipe back hides it; a long swipe, past half the row, deletes on release.
 * Nothing happens on a swipe to the left.
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
  const [rowWidth, setRowWidth] = useState(0);
  // the row was dragged past half its width this time: it deletes when it settles
  const fullSwipe = useRef(false);
  const onFullSwipe = () => { fullSwipe.current = true; };
  // whether the pane is showing, for the wrapper's tap
  const isOpen = useRef(false);
  const wrapper = useRef<View>(null);
  const remove = () => {
    ref.current?.close();
    onDelete();
  };
  // The swipeable always draws an (empty, see-through) right-hand action layer over the left one,
  // and on the web that layer takes the click before the pane can. So a press is also read here,
  // on the wrapper, which the click bubbles up to: over the pane's width while it is open, it
  // deletes. Not a button for assistive tech; the pane itself is.
  return (
    <Pressable
      ref={wrapper}
      accessible={false}
      focusable={false}
      onPress={(e) => {
        if (!isOpen.current) return;
        // page coordinates: a click on the web carries no locationX
        const px = e.nativeEvent.pageX;
        wrapper.current?.measure((_x, _y, _w, _h, pageX) => { if (px - pageX < PANE) remove(); });
      }}
      onLayout={(e) => setRowWidth(e.nativeEvent.layout.width)}>
      <ReanimatedSwipeable
        ref={ref}
        friction={1.5}
        leftThreshold={PANE / 2}
        overshootLeft
        overshootFriction={2}
        enableTrackpadTwoFingerGesture
        renderLeftActions={(progress, translation) => (
          <DeletePane progress={progress} translation={translation} rowWidth={rowWidth} onFullSwipe={onFullSwipe} label={label} onPress={remove} />
        )}
        onSwipeableWillOpen={() => {
          if (!openRef) return;
          if (openRef.current && openRef.current !== ref.current) openRef.current.close();
          openRef.current = ref.current;
        }}
        onSwipeableOpen={() => {
          isOpen.current = true;
          if (fullSwipe.current) remove();
        }}
        onSwipeableClose={() => {
          isOpen.current = false;
          fullSwipe.current = false;
          if (openRef && openRef.current === ref.current) openRef.current = null;
        }}>
        {children}
      </ReanimatedSwipeable>
    </Pressable>
  );
}

function DeletePane({ progress, translation, rowWidth, onFullSwipe, label, onPress }: {
  progress: SharedValue<number>; translation: SharedValue<number>;
  /** The row's width, and what to call once the drag crosses half of it (once per drag). */
  rowWidth: number; onFullSwipe: () => void;
  label: string; onPress: () => void;
}) {
  const { palette } = useTheme();
  const crossed = useSharedValue(false);
  useAnimatedReaction(() => translation.value, (v) => {
    if (!rowWidth) return;
    if (v >= rowWidth * FULL_SWIPE && !crossed.value) {
      crossed.value = true;
      runOnJS(onFullSwipe)();
    } else if (v < PANE / 2 && crossed.value) crossed.value = false;
  }, [rowWidth, onFullSwipe]);
  // the word grows in as the pane is pulled out, so a half-open pane doesn't show a clipped label
  const style = useAnimatedStyle(() => {
    const p = Math.min(1, progress.value);
    return { opacity: p, transform: [{ scale: 0.7 + 0.3 * p }] };
  });
  // a tap gesture, not a Pressable: inside the swipe container only the gesture system sees taps on the web
  const tap = Gesture.Tap().runOnJS(true).onEnd((_e, ok) => { if (ok) onPress(); });
  return (
    <View style={{ width: PANE, paddingRight: space.sm, paddingVertical: 4 }}>
      <GestureDetector gesture={tap}>
        <View
          accessible
          accessibilityRole="button"
          accessibilityLabel={`Delete ${label}`}
          style={{ flex: 1, borderRadius: radius.sm, backgroundColor: palette.neg, alignItems: 'center', justifyContent: 'center' }}>
          <Animated.View style={style}>
            <T variant="small" weight="700" style={{ color: '#ffffff' }}>Delete</T>
          </Animated.View>
        </View>
      </GestureDetector>
    </View>
  );
}
