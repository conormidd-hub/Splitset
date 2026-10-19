import { useState } from 'react';
import { Image, View } from 'react-native';

import { useTheme } from '@/theme/ThemeProvider';

// Conor's SPLITSET wordmark (assets/images/wordmark.png), cut by colour into two masks so each
// half takes the theme's colour: SPLIT and SET, at the source's own proportions.
const SPLIT = require('../../../assets/images/wordmark-split.png');
const SET = require('../../../assets/images/wordmark-set.png');
const SRC = { split: 997, gap: 44, set: 693, height: 131 };
const ASPECT = (SRC.split + SRC.gap + SRC.set) / SRC.height;
/** SPLIT's cream in the logo, for dark backgrounds. */
const CREAM = '#fdf6e9';

/**
 * The SPLITSET wordmark, as wide as the space it is given allows, up to `maxHeight` tall. SPLIT is
 * cream on a dark theme and the text colour on a light one (cream would vanish there); SET is the
 * accent green.
 */
export function Wordmark({ maxHeight = 16 }: { maxHeight?: number }) {
  const { palette, name } = useTheme();
  const [width, setWidth] = useState(0);
  const h = width ? Math.min(maxHeight, width / ASPECT) : 0;
  const k = h / SRC.height;
  return (
    <View
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      accessible
      accessibilityRole="header"
      accessibilityLabel="SplitSet"
      style={{ alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', height: maxHeight }}>
      {h ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SRC.gap * k }}>
          <Image source={SPLIT} style={{ width: SRC.split * k, height: h }} tintColor={name === 'night' ? CREAM : palette.ink} resizeMode="contain" />
          <Image source={SET} style={{ width: SRC.set * k, height: h }} tintColor={palette.accent} resizeMode="contain" />
        </View>
      ) : null}
    </View>
  );
}
