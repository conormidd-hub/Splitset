import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { Keyboard, Modal, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Badge } from '@/components/ui/Chip';
import { T } from '@/components/ui/T';
import type { RecoveryMuscle, SessionMapMuscle } from '@/api/recovery';
import { ICONS } from '@/lib/icons';
import { fmtHours } from '@/lib/recovery/engine';
import { referenceMarker, ROLE_BADGE, type FigureTheme } from '@/lib/recovery/figure';
import type { MuscleId } from '@/lib/recovery/library';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

const WIDE = 640;

type Props = {
  muscle: MuscleId | null;
  name: string;
  theme: FigureTheme;
  /** The tapped muscle's entry: a recovery_map one, or a session_map one on the session view. */
  state: RecoveryMuscle | SessionMapMuscle | null;
  /** IANA zone for workout dates (profiles.timezone). */
  timeZone?: string | null;
  /** The muscle before this session (the live workout's Body view), for a before-and-after line. */
  before?: { label: string } | null;
  onClose: () => void;
};

/** A workout's finish in the user's time zone: "Wed 7 Oct, 18:00". */
export function workoutWhen(iso: string, timeZone?: string | null): string {
  const opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
  try {
    return new Intl.DateTimeFormat(undefined, { ...opts, timeZone: timeZone ?? undefined }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat(undefined, opts).format(new Date(iso));
  }
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexGrow: 1, flexBasis: 0, minWidth: 72 }}>
      <T variant="tiny" tone="mut">{label}</T>
      <T variant="h3" style={{ fontVariant: ['tabular-nums'] }}>{value}</T>
    </View>
  );
}

/**
 * The tap detail of spec §10: name, level and advice, F (or L), trainable and ready, weekly load W,
 * and the exercises behind it this week (role badge, date, role_weight × L_e), largest first, with
 * provisional references marked. A bottom sheet on a phone, a centred card when wide.
 */
export function MuscleSheet({ muscle, name, theme, state, timeZone, before, onClose }: Props) {
  const { palette, name: themeName } = useTheme();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const wide = width >= WIDE;
  const scrim = themeName === 'night' ? palette.bg : palette.ink;
  const open = muscle && state ? { name, state } : null;
  const visible = !!open;
  // the last muscle shown stays drawn while the sheet slides away, rather than blanking as it goes
  const [last, setLast] = useState(open);
  if (open && (open.state !== last?.state || open.name !== last?.name)) setLast(open);
  const shown = open ?? last;
  const recovery = shown && 'F' in shown.state ? shown.state : null;
  const session = shown && 'L' in shown.state ? shown.state : null;

  // a set field on the live workout keeps its number pad up through a tap on the figure, and the
  // pad would cover this sheet
  useEffect(() => {
    if (visible) Keyboard.dismiss();
  }, [visible]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} aria-label={shown?.name}>
      <View style={{ flex: 1 }}>
        {/* a tap outside the card closes it. Not a button: kept out of the web's focus order and
            hidden from screen readers, which get the card's Close, Escape and the escape scrub */}
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
          {shown ? (
            <View
              style={{
                backgroundColor: palette.bg, maxHeight: '80%', width: wide ? 520 : undefined,
                borderRadius: wide ? radius.lg : 0, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
                borderWidth: 1, borderColor: palette.hair, paddingBottom: wide ? 0 : insets.bottom,
              }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg, paddingBottom: space.sm }}>
                <View style={{ width: 18, height: 18, borderRadius: 5, backgroundColor: theme === 'dark' ? shown.state.fill_dark : shown.state.fill, borderWidth: 1, borderColor: palette.hair }} />
                <View style={{ flex: 1 }}>
                  <T variant="h2" accessibilityRole="header">{shown.name}</T>
                  <T variant="small" tone="ink2">{shown.state.label}{recovery ? ` · ${recovery.advice}` : ''}</T>
                  {visible && before ? (
                    <T variant="small" tone="accent" weight="600">This session: {before.label} → {shown.state.label}</T>
                  ) : null}
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
              <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: space.lg, gap: space.md }}>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md, backgroundColor: palette.surface, borderRadius: radius.md, borderWidth: 1, borderColor: palette.hair, padding: space.md }}>
                  {recovery ? (
                    <>
                      <Stat label="Fatigue F" value={recovery.F.toFixed(2)} />
                      <Stat label="Trainable in" value={fmtHours(recovery.trainable_in_h)} />
                      <Stat label="Ready in" value={fmtHours(recovery.ready_in_h)} />
                      <Stat label="Weekly load W" value={recovery.W.toFixed(2)} />
                    </>
                  ) : session ? (
                    <>
                      <Stat label="Load L" value={session.L.toFixed(2)} />
                      <Stat label="Recovery window" value={`${session.R.toFixed(0)} h`} />
                      <Stat label="Trainable after" value={fmtHours(session.trainable_after_h)} />
                      <Stat label="Ready after" value={fmtHours(session.ready_after_h)} />
                    </>
                  ) : null}
                </View>
                {recovery ? (
                  <View>
                    <T variant="label" tone="mut" style={{ paddingVertical: space.sm }}>This week</T>
                    {recovery.contributing.length ? (
                      <View style={{ backgroundColor: palette.surface, borderRadius: radius.md, borderWidth: 1, borderColor: palette.hair, paddingHorizontal: space.md }}>
                        {recovery.contributing.map((x, i) => {
                          const marker = referenceMarker(x.pb_source);
                          return (
                            <View
                              key={`${x.workout_id}-${x.exercise_id}`}
                              accessible
                              accessibilityLabel={`${x.exercise}, ${x.role}, ${workoutWhen(x.workout_date, timeZone)}, load ${x.load.toFixed(2)}${marker ? `, ${marker}` : ''}`}
                              style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 10, borderTopWidth: i ? 1 : 0, borderColor: palette.hair }}>
                              <Badge label={ROLE_BADGE[x.role]} tone={x.role === 'primary' ? 'accent' : 'mut'} />
                              <View style={{ flex: 1 }}>
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs, flexWrap: 'wrap' }}>
                                  <T variant="small" weight="600">{x.exercise}</T>
                                  {marker ? <Badge label={marker} /> : null}
                                </View>
                                <T variant="tiny" tone="mut">{workoutWhen(x.workout_date, timeZone)}</T>
                              </View>
                              <T variant="small" style={{ fontVariant: ['tabular-nums'] }}>{x.load.toFixed(2)}</T>
                            </View>
                          );
                        })}
                      </View>
                    ) : (
                      <T variant="small" tone="mut">Nothing in the last 7 days.</T>
                    )}
                  </View>
                ) : null}
              </ScrollView>
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}
