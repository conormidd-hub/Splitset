import { useEffect, useState } from 'react';
import { Animated, Platform, View } from 'react-native';

import { T } from '@/components/ui/T';
import { useTheme } from '@/theme/ThemeProvider';
import { heat } from '@/theme/tokens';

const DASH_W = 15;
const DASH_H = 11;
const GAP = 5;

/**
 * Streak heat as seven slanted dashes beside the greeting, one per day of the last week: each day
 * trained lights one in the accent green, left to right, and they ignite one after another when
 * the screen opens. "6/7 streak heat" sits under them.
 */
export function StreakDashes({ days }: { days: number }) {
  const { palette } = useTheme();
  const lit = Math.max(0, Math.min(7, days));
  const [glow] = useState(() => Array.from({ length: 7 }, () => new Animated.Value(0)));
  useEffect(() => {
    Animated.stagger(70, glow.slice(0, lit).map((v) =>
      Animated.timing(v, { toValue: 1, duration: 220, useNativeDriver: Platform.OS !== 'web' }))).start();
  }, [glow, lit]);

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={`Streak heat: trained ${lit} of the last 7 days`}
      style={{ alignItems: 'flex-end', gap: 4 }}>
      <View style={{ flexDirection: 'row', gap: GAP, paddingRight: 3 }}>
        {glow.map((v, i) => (
          <View key={i} style={{ width: DASH_W, height: DASH_H, transform: [{ skewX: '-20deg' }], borderRadius: 2, backgroundColor: palette.surface3 }}>
            {i < lit ? (
              <Animated.View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 2, backgroundColor: heat.flame, opacity: v }} />
            ) : null}
          </View>
        ))}
      </View>
      <T variant="tiny" tone="mut">{lit}/7 streak heat</T>
    </View>
  );
}
