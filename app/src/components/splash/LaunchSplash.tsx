import { useIsFetching } from '@tanstack/react-query';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';
import { Animated, Easing, Platform, StyleSheet, useWindowDimensions, View, type ImageSourcePropType } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { useSession } from '@/lib/session';
import { palettes } from '@/theme/tokens';

// The logo cut into its two halves on one 855 x 790 canvas, and the wordmark: the exact artwork,
// so the halves line up again once both are in.
const OUTDOORS = require('../../../assets/images/splash/outdoors.png');
const STRENGTH = require('../../../assets/images/splash/strength.png');
const WORDMARK = require('../../../assets/images/splash/wordmark.png');
const SYMBOL_ASPECT = 790 / 855;
const WORDMARK_ASPECT = 116 / 950;

const BG = palettes.night.bg;
const DASH = palettes.night.accent;
const EASE = Easing.bezier(0.22, 1, 0.36, 1);

// One clock, in ms, drives the whole reveal; each part reads its own window off it. The windows
// match the web version's CSS in public/index.html.
const OUTDOORS_MS = [130, 830];
const STRENGTH_MS = [470, 1210];
const WORDMARK_MS = [1050, 1540];
const DASHES_MS = [1540, 1940];
const END_MS = DASHES_MS[1];
/** The dashes' breath: dim to bright and back, each dash a little behind the one before. */
const BREATH_MS = 1250;
const DASH_STAGGER_MS = 180;
/** How long nothing must be fetching before the app counts as loaded (queries start in waves). */
const SETTLE_MS = 250;
/** However slow the network, the app is never held back longer than this. */
const MAX_MS = 10000;
const FADE_MS = 350;
const nativeDriver = Platform.OS !== 'web';

/**
 * The launch screen, shown for as long as the app is genuinely loading (the session, then the
 * first screen's queries) and faded away once it has. The logo builds once, the mountain half from
 * the left and the gym half from the right, then SPLITSET; after that only three green dashes
 * breathe. With reduce motion on, the logo is shown whole and still.
 *
 * On web, public/index.html draws the same screen in CSS before the app's script has loaded; this
 * then leaves that one in place and only takes it away.
 */
export function LaunchSplash() {
  const { isLoading } = useSession();
  const fetching = useIsFetching();
  const [boot] = useState(() => (Platform.OS === 'web' ? document.getElementById('boot') : null));
  const [settled, setSettled] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [gone, setGone] = useState(false);
  const [fade] = useState(() => new Animated.Value(1));

  useEffect(() => {
    // the native splash is a plain background of the same colour: this takes over from it
    SplashScreen.hideAsync().catch(() => {});
    const t = setTimeout(() => setTimedOut(true), MAX_MS);
    return () => clearTimeout(t);
  }, []);

  const idle = !isLoading && fetching === 0;
  useEffect(() => {
    if (!idle) return;
    const t = setTimeout(() => setSettled(true), SETTLE_MS);
    return () => clearTimeout(t);
  }, [idle]);

  const closing = settled || timedOut;
  useEffect(() => {
    if (!closing) return;
    if (boot) {
      boot.classList.add('ss-loading-screen--leaving');
      const t = setTimeout(() => { boot.remove(); setGone(true); }, FADE_MS);
      return () => clearTimeout(t);
    }
    Animated.timing(fade, { toValue: 0, duration: FADE_MS, useNativeDriver: nativeDriver }).start(() => setGone(true));
  }, [closing, boot, fade]);

  if (gone || boot) return null;
  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, styles.root, { opacity: fade }]}
      pointerEvents={closing ? 'none' : 'auto'}
      accessible
      accessibilityLabel="Loading SplitSet"
      accessibilityLiveRegion="polite">
      <LogoReveal />
    </Animated.View>
  );
}

function LogoReveal() {
  const reduced = useReducedMotion();
  const { width } = useWindowDimensions();
  const [clock] = useState(() => new Animated.Value(reduced ? END_MS : 0));
  const [breath] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (reduced) return;
    const reveal = Animated.timing(clock, { toValue: END_MS, duration: END_MS, easing: Easing.linear, useNativeDriver: false });
    const breathe = Animated.loop(
      Animated.timing(breath, { toValue: BREATH_MS, duration: BREATH_MS, easing: Easing.linear, useNativeDriver: nativeDriver }),
    );
    reveal.start();
    breathe.start();
    return () => { reveal.stop(); breathe.stop(); };
  }, [reduced, clock, breath]);

  const symbolW = Math.min(width * 0.69, 300);
  const symbolH = symbolW * SYMBOL_ASPECT;
  const wordW = Math.min(width * 0.76, 320);
  const wordH = wordW * WORDMARK_ASPECT;
  const outdoors = progress(clock, OUTDOORS_MS, EASE);
  const strength = progress(clock, STRENGTH_MS, EASE);
  const wordmark = progress(clock, WORDMARK_MS, EASE);
  const dashes = progress(clock, DASHES_MS, Easing.out(Easing.quad));

  return (
    <View style={styles.lockup}>
      <View style={{ width: symbolW, height: symbolH }}>
        <Wipe source={OUTDOORS} p={outdoors} from="left" w={symbolW} h={symbolH} drift={[-9, -7]} />
        <Wipe source={STRENGTH} p={strength} from="right" w={symbolW} h={symbolH} drift={[9, 7]} />
      </View>
      <Animated.View style={{ width: wordW, height: wordH, marginTop: 8, transform: [{ translateY: wordmark.interpolate({ inputRange: [0, 1], outputRange: [4, 0] }) }] }}>
        <Wipe source={WORDMARK} p={wordmark} from="left" w={wordW} h={wordH} fadeIn={1} />
      </Animated.View>
      <Animated.View
        style={[styles.dashes, {
          opacity: dashes,
          transform: [{ translateY: dashes.interpolate({ inputRange: [0, 1], outputRange: [5, 0] }) }],
        }]}>
        {[0, 1, 2].map((i) => (
          <Animated.View key={i} style={[styles.dash, { opacity: reduced ? 0.4 : breathing(breath, i * DASH_STAGGER_MS) }]} />
        ))}
      </Animated.View>
    </View>
  );
}

/**
 * One piece of artwork wiped into view from one side as `p` runs 0 to 1: the clip window slides
 * one way while the image slides back the other, so the image stays put and only its visible edge
 * moves (transforms only, no layout per frame). `drift` eases it in from a few pixels off, and it
 * fades in over the first `fadeIn` of the wipe.
 */
function Wipe({ source, p, from, w, h, drift = [0, 0], fadeIn = 0.22 }: {
  source: ImageSourcePropType;
  p: Animated.AnimatedInterpolation<number>;
  from: 'left' | 'right';
  w: number;
  h: number;
  drift?: [number, number];
  fadeIn?: number;
}) {
  const hidden = from === 'left' ? -w : w;
  const clip = p.interpolate({ inputRange: [0, 1], outputRange: [hidden, 0] });
  const counter = p.interpolate({ inputRange: [0, 1], outputRange: [-hidden, 0] });
  return (
    <Animated.View
      style={{
        position: 'absolute',
        width: w,
        height: h,
        overflow: 'hidden',
        opacity: p.interpolate({ inputRange: [0, fadeIn], outputRange: [0, 1], extrapolate: 'clamp' }),
        transform: [
          { translateX: p.interpolate({ inputRange: [0, 1], outputRange: [drift[0], 0] }) },
          { translateY: p.interpolate({ inputRange: [0, 1], outputRange: [drift[1], 0] }) },
          { translateX: clip },
        ],
      }}>
      <Animated.Image source={source} style={{ width: w, height: h, transform: [{ translateX: counter }] }} resizeMode="contain" />
    </Animated.View>
  );
}

/** 0 to 1 across one window of the clock, eased, and held at either end outside it. */
function progress(clock: Animated.Value, [from, to]: number[], easing: (t: number) => number) {
  return clock.interpolate({ inputRange: [from, to], outputRange: [0, 1], easing, extrapolate: 'clamp' });
}

/**
 * A dash's opacity over one breath, `lag` ms behind the first: dim at 0.18, brightest (0.92) 45%
 * of the way through, eased in and out. Sampled into steps so it can run on the native driver,
 * which can't take a custom easing.
 */
function breathing(breath: Animated.Value, lag: number) {
  const STEP = 50;
  const peak = BREATH_MS * 0.45;
  const at = (t: number) => {
    const ph = (((t - lag) % BREATH_MS) + BREATH_MS) % BREATH_MS;
    const k = ph < peak ? ph / peak : 1 - (ph - peak) / (BREATH_MS - peak);
    return 0.18 + (0.92 - 0.18) * Easing.inOut(Easing.ease)(k);
  };
  const inputRange: number[] = [];
  for (let t = 0; t <= BREATH_MS; t += STEP) inputRange.push(t);
  return breath.interpolate({ inputRange, outputRange: inputRange.map(at) });
}

const styles = StyleSheet.create({
  root: { backgroundColor: BG, alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
  lockup: { alignItems: 'center' },
  dashes: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 27 },
  dash: { width: 15, height: 3, borderRadius: 12, backgroundColor: DASH },
});
