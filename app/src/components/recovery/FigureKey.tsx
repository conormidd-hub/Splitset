import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Legend } from './Legend';
import { useThresholds } from '@/api/recovery';
import { T } from '@/components/ui/T';
import { ICONS } from '@/lib/icons';
import { legendRows, type FigureTheme, type MapMode } from '@/lib/recovery/figure';
import type { Thresholds } from '@/lib/recovery/thresholds';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

const WIDE = 640;

type KeyProps = {
  mode: MapMode;
  /** The user's thresholds; read from the profile when left out. */
  thresholds?: Thresholds;
  /** The figure draws a glow on the muscles this session has loaded (the live workout's Body view). */
  glow?: boolean;
};

/** What the colour stands for, in a sentence, per view. */
export function keyIntro(mode: MapMode): string {
  return mode === 'session'
    ? 'Colour is load L: how much this workout has put on each muscle. Darker is more.'
    : 'Colour is fatigue F: how much each muscle is still carrying from recent workouts and activities. It fades as the muscle recovers.';
}

export const GLOW_NOTE = 'A glowing outline marks a muscle this session has loaded, on top of what it was already carrying.';

function useFigureTheme(): FigureTheme {
  const { name } = useTheme();
  return name === 'night' ? 'dark' : 'light';
}

/**
 * The round ⓘ that sits by every body figure: opens the key, so what the colours mean is one tap
 * away wherever a figure is drawn (Today, the Lift tab, a workout, its summary, Recovery).
 */
export function KeyButton({ mode, thresholds, glow, size = 30 }: KeyProps & { size?: number }) {
  const { palette } = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel="What the colours mean"
        hitSlop={8}
        style={({ pressed }) => ({
          width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center',
          backgroundColor: palette.surface2, borderWidth: 1, borderColor: palette.hair, opacity: pressed ? 0.7 : 1,
        })}>
        <T variant="small" tone="ink2" weight="700" style={{ fontStyle: 'italic', lineHeight: size - 4 }}>i</T>
      </Pressable>
      <KeySheet visible={open} onClose={() => setOpen(false)} mode={mode} thresholds={thresholds} glow={glow} />
    </>
  );
}

/**
 * The compact key: the six levels as small labelled swatches in one wrapping row. Tapping it opens
 * the full key, or with `inline` (inside a quick view, which is already a modal) unfolds the full
 * rows in place.
 */
export function KeyStrip({ mode, thresholds, glow, inline = false }: KeyProps & { inline?: boolean }) {
  const { palette } = useTheme();
  const theme = useFigureTheme();
  const own = useThresholds();
  const c = thresholds ?? own;
  const [open, setOpen] = useState(false);
  const rows = legendRows(c, theme, mode);
  return (
    <View style={{ gap: space.sm }}>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityLabel={`Colour key: ${rows.map((r) => r.label).join(', ')}. ${inline ? (open ? 'Hides' : 'Shows') : 'Opens'} what each level means.`}
        accessibilityState={inline ? { expanded: open } : undefined}
        style={({ pressed }) => ({ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm, opacity: pressed ? 0.7 : 1 })}>
        {rows.map((r) => (
          <View key={r.level} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <View style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: r.fill, borderWidth: 1, borderColor: palette.hair }} />
            <T variant="tiny" tone="mut">{r.label}</T>
          </View>
        ))}
        <View style={{ flex: 1 }} />
        <T variant="tiny" tone="accent" weight="600">{inline ? (open ? 'Less' : 'Key') : 'Key ›'}</T>
      </Pressable>
      {inline && open ? <KeyBody mode={mode} thresholds={c} glow={glow} /> : null}
      {!inline ? <KeySheet visible={open} onClose={() => setOpen(false)} mode={mode} thresholds={c} glow={glow} /> : null}
    </View>
  );
}

/** The key's content: the sentence for the view, the six rows, and the glow note when it applies. */
function KeyBody({ mode, thresholds, glow }: KeyProps) {
  const theme = useFigureTheme();
  const own = useThresholds();
  const c = thresholds ?? own;
  return (
    <View style={{ gap: space.md }}>
      <T variant="small" tone="ink2">{keyIntro(mode)}</T>
      <Legend theme={theme} mode={mode} thresholds={c} />
      {glow ? <T variant="small" tone="ink2">{GLOW_NOTE}</T> : null}
      <T variant="tiny" tone="mut">Where each colour starts can be tuned in Settings › Recovery map.</T>
    </View>
  );
}

/** "What the colours mean": a bottom sheet on a phone, a centred card when wide. */
export function KeySheet({ visible, onClose, mode, thresholds, glow }: KeyProps & { visible: boolean; onClose: () => void }) {
  const { palette, name: themeName } = useTheme();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const wide = width >= WIDE;
  const scrim = themeName === 'night' ? palette.bg : palette.ink;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} aria-label="What the colours mean">
      <View style={{ flex: 1 }}>
        <View
          aria-hidden
          onStartShouldSetResponder={() => true}
          onResponderRelease={onClose}
          style={[StyleSheet.absoluteFill, { backgroundColor: scrim, opacity: 0.5 }]}
        />
        <View
          accessibilityViewIsModal
          onAccessibilityEscape={onClose}
          style={{ flex: 1, justifyContent: wide ? 'center' : 'flex-end', alignItems: wide ? 'center' : 'stretch', pointerEvents: 'box-none' }}>
          <View
            style={{
              backgroundColor: palette.bg, maxHeight: '80%', width: wide ? 520 : undefined,
              borderRadius: wide ? radius.lg : 0, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
              borderWidth: 1, borderColor: palette.hair, paddingBottom: wide ? 0 : insets.bottom,
            }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg, paddingBottom: space.sm }}>
              <View style={{ flex: 1 }}>
                <T variant="h2" accessibilityRole="header">What the colours mean</T>
                <T variant="small" tone="mut">{mode === 'session' ? 'This workout' : 'Recovery'}</T>
              </View>
              <Pressable
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel="Close"
                hitSlop={8}
                style={({ pressed }) => ({ width: 32, height: 32, borderRadius: 16, backgroundColor: palette.surface2, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.7 : 1 })}>
                <SymbolView name={ICONS.close} tintColor={palette.ink2} size={16} />
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: space.lg }}>
              <KeyBody mode={mode} thresholds={thresholds} glow={glow} />
            </ScrollView>
          </View>
        </View>
      </View>
    </Modal>
  );
}
