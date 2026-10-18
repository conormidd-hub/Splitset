import { useEffect, useState, type ReactNode } from 'react';
import { Animated, Modal, Pressable, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BodyMap } from './BodyMap';
import { useThresholds } from '@/api/recovery';
import type { FigureMap, FigureTheme, MapMode } from '@/lib/recovery/figure';
import type { MuscleId } from '@/lib/recovery/library';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

const SIZE = 40;

/**
 * The body figure shrunk into a round header button: where the full figure sits at the top of a
 * screen, it shows once that figure has scrolled away (`shown`), and opens a quick view.
 */
export function FigureBubble({ map, mode, shown, onPress, nameOf, label }: {
  map: FigureMap | null; mode: MapMode; shown: boolean; onPress: () => void; nameOf: (id: MuscleId) => string;
  /** What it opens, for screen readers ("Recovery map", "This workout's muscles"). */
  label: string;
}) {
  const { palette, name } = useTheme();
  const c = useThresholds();
  const theme: FigureTheme = name === 'night' ? 'dark' : 'light';
  const [t] = useState(() => new Animated.Value(shown ? 1 : 0));
  useEffect(() => {
    // width animates too (not on the native driver), so a hidden bubble leaves no gap in the header
    Animated.timing(t, { toValue: shown ? 1 : 0, duration: 180, useNativeDriver: false }).start();
  }, [shown, t]);

  return (
    <Animated.View
      pointerEvents={shown ? 'auto' : 'none'}
      style={{ opacity: t, width: t.interpolate({ inputRange: [0, 1], outputRange: [0, SIZE] }), overflow: 'visible',
        transform: [{ scale: t.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) }] }}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityElementsHidden={!shown}
        importantForAccessibility={shown ? 'auto' : 'no-hide-descendants'}
        hitSlop={4}
        style={({ pressed }) => ({
          width: SIZE, height: SIZE, borderRadius: SIZE / 2, overflow: 'hidden', alignItems: 'center', justifyContent: 'center',
          backgroundColor: palette.surface, borderWidth: 1.5, borderColor: palette.accent, opacity: pressed ? 0.8 : 1,
        })}>
        <View pointerEvents="none" style={{ marginTop: 8 }}>
          <BodyMap map={map} view="front" mode={mode} theme={theme} thresholds={c} width={22} nameOf={nameOf} />
        </View>
      </Pressable>
    </Animated.View>
  );
}

/**
 * The quick view a FigureBubble opens: a card floating under the header, closed by a tap
 * anywhere outside it (or the back gesture).
 */
export function QuickView({ visible, onClose, title, children }: { visible: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      {/* the backdrop closes it; screen readers use the card's own close */}
      <Pressable onPress={onClose} accessible={false} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.25)' }}>
        <Pressable
          // a tap inside the card stays in the card
          onPress={() => undefined}
          accessible={false}
          aria-modal
          aria-label={title}
          style={{
            position: 'absolute', top: insets.top + 64, right: space.lg, width: Math.min(380, width - 2 * space.lg),
            backgroundColor: palette.surface, borderRadius: radius.lg, padding: space.md, gap: space.md,
            borderWidth: 1, borderColor: palette.hair, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 16, elevation: 8,
          }}>
          {children}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
