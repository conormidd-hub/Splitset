import { useIsFetching } from '@tanstack/react-query';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';
import { Animated, Easing, Image, Platform, StyleSheet, useWindowDimensions, View } from 'react-native';

import { Wordmark } from '@/components/ui/Wordmark';
import { useSession } from '@/lib/session';

const LOGO = require('../../../assets/images/splash-icon.png');
/** The native splash's background (app.json), so the hand-over to this one doesn't show. */
const BG = '#000000';
/** The reveal runs to LEAD_TO over LEAD_MS on its own, then waits on the page for the rest. */
const LEAD_MS = 1400;
const LEAD_TO = 0.8;
/** However slow the network, the app is never held back longer than this. */
const MAX_MS = 8000;
const nativeDriver = Platform.OS !== 'web';

/**
 * The launch screen: the Splitset logo, with the SPLITSET wordmark revealed left to right under
 * it while the session and the first screen's data load behind. Most of the wordmark shows on a
 * timer; the last of it waits until nothing is fetching, then the whole screen fades away.
 */
export function LaunchSplash() {
  const { isLoading } = useSession();
  const fetching = useIsFetching();
  const { width } = useWindowDimensions();
  const [reveal] = useState(() => new Animated.Value(0));
  const [fade] = useState(() => new Animated.Value(1));
  const [leadDone, setLeadDone] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [closing, setClosing] = useState(false);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    // this screen starts where the native splash leaves off: same black, same logo
    SplashScreen.hideAsync().catch(() => {});
    Animated.timing(reveal, { toValue: LEAD_TO, duration: LEAD_MS, easing: Easing.out(Easing.cubic), useNativeDriver: false })
      .start(() => setLeadDone(true));
    const t = setTimeout(() => setTimedOut(true), MAX_MS);
    return () => clearTimeout(t);
  }, [reveal]);

  // once ready it stays closing, even if a later refetch starts while it fades
  if (!closing && (timedOut || (leadDone && !isLoading && fetching === 0))) setClosing(true);

  useEffect(() => {
    if (!closing) return;
    Animated.sequence([
      Animated.timing(reveal, { toValue: 1, duration: 350, easing: Easing.out(Easing.quad), useNativeDriver: false }),
      Animated.delay(250),
      Animated.timing(fade, { toValue: 0, duration: 350, useNativeDriver: nativeDriver }),
    ]).start(() => setGone(true));
  }, [closing, reveal, fade]);

  if (gone) return null;

  const logo = Math.min(width * 0.8, 340);
  const mark = Math.min(width - 96, 240);
  return (
    <Animated.View testID="launch-splash" style={[StyleSheet.absoluteFill, styles.root, { opacity: fade }]}>
      {/* the logo sits dead centre, where web's index.html drew it before the app loaded */}
      <View style={{ width: logo, height: logo }}>
        <Image source={LOGO} style={{ width: logo, height: logo }} resizeMode="contain" accessibilityIgnoresInvertColors />
        {/* the logo image carries its own black margin: the wordmark sits up inside it */}
        <View style={{ position: 'absolute', top: logo * 0.84, left: (logo - mark) / 2, width: mark }}>
          <Animated.View
            style={{ overflow: 'hidden', width: reveal.interpolate({ inputRange: [0, 1], outputRange: [0, mark] }) }}>
            <View style={{ width: mark }}>
              <Wordmark maxHeight={Math.round(mark / 13.2)} onDark />
            </View>
          </Animated.View>
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: BG, alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
});
