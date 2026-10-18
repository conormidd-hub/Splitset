import { SymbolView } from 'expo-symbols';
import { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RECOVERY, type FocusId, type HomeLayout } from '@/api/home';
import { T } from '@/components/ui/T';
import { TextField } from '@/components/ui/TextField';
import { ICONS } from '@/lib/icons';
import { GROUP_LABELS, METRIC_ORDER, METRICS, type MetricDef, type MetricGroup, type MetricId } from '@/lib/metrics';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

type Props = {
  visible: boolean;
  /** `add` appends to At a glance and stays open; `pick` chooses what an In focus slot shows and closes. */
  mode: 'add' | 'pick';
  /** Which In focus slot `pick` fills; the right one can also show the recovery body figure. */
  slot?: 'left' | 'right';
  layout: HomeLayout;
  onClose: () => void;
  onAdd: (id: MetricId) => void;
  onPick: (id: FocusId) => void;
};

const WIDE = 640;

/** "The lowest sustained heart rate your watch saw, usually while you slept." and no more. */
function firstSentence(text: string): string {
  const m = /[.!?](\s|$)/.exec(text);
  return m ? text.slice(0, m.index + 1) : text;
}

/**
 * Every stat Garmin Connect can put on its home, grouped, searchable, with the ones that never
 * reach intervals.icu greyed out and explained rather than hidden. A bottom sheet on a phone, a
 * centred card on a wide screen.
 */
export function AddMetricSheet({ visible, mode, slot = 'left', layout, onClose, onAdd, onPick }: Props) {
  const { palette, name } = useTheme();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const wide = width >= WIDE;
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<MetricId | null>(null);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hit = (d: MetricDef) => !q || `${d.label} ${d.short} ${d.description} ${GROUP_LABELS[d.group]}`.toLowerCase().includes(q);
    const out = new Map<MetricGroup, MetricDef[]>();
    for (const id of METRIC_ORDER) {
      const d = METRICS[id];
      if (!hit(d)) continue;
      out.set(d.group, [...(out.get(d.group) ?? []), d]);
    }
    // the unavailable ones sit at the end of their group whatever the catalogue order says
    for (const [g, list] of out) out.set(g, [...list.filter((d) => d.available), ...list.filter((d) => !d.available)]);
    return [...out.entries()];
  }, [query]);

  const close = () => {
    setQuery('');
    setExpanded(null);
    onClose();
  };
  const current = slot === 'right' ? layout.focus2 : layout.focus;
  const choose = (id: FocusId) => {
    if (mode === 'pick') {
      onPick(id);
      close();
    } else {
      if (id !== RECOVERY) onAdd(id);
    }
  };

  // the scrim is the dark of whichever palette is on: the page's own black at night, ink by day
  const scrim = name === 'night' ? palette.bg : palette.ink;
  const title = mode === 'pick' ? (slot === 'right' ? 'In focus, right' : 'In focus, left') : 'Add to At a glance';

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close} aria-label={title}>
      <View style={{ flex: 1 }}>
        {/* a tap outside the card closes it. Not a button: kept out of the web's focus order and
            hidden from screen readers, which get the card's Close, Escape and the escape scrub */}
        <View
          aria-hidden
          onStartShouldSetResponder={() => true}
          onResponderRelease={close}
          style={[StyleSheet.absoluteFill, { backgroundColor: scrim, opacity: 0.5 }]}
        />
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          accessibilityViewIsModal
          onAccessibilityEscape={close}
          style={{ flex: 1, justifyContent: wide ? 'center' : 'flex-end', alignItems: wide ? 'center' : 'stretch', pointerEvents: 'box-none' }}>
          <View
            style={{
              backgroundColor: palette.bg, maxHeight: '80%', width: wide ? 520 : undefined,
              borderRadius: wide ? radius.lg : 0, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
              borderWidth: 1, borderColor: palette.hair, paddingBottom: wide ? 0 : insets.bottom,
            }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg, paddingBottom: space.sm }}>
              <T variant="h2" accessibilityRole="header" style={{ flex: 1 }}>{title}</T>
              <Pressable
                onPress={close}
                accessibilityRole="button"
                accessibilityLabel="Close"
                hitSlop={8}
                style={({ pressed }) => ({ width: 32, height: 32, borderRadius: 16, backgroundColor: palette.surface2, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.7 : 1 })}>
                <SymbolView name={ICONS.close} tintColor={palette.ink2} size={16} />
              </Pressable>
            </View>
            <View style={{ paddingHorizontal: space.lg, paddingBottom: space.sm }}>
              <TextField
                value={query}
                onChangeText={setQuery}
                placeholder="Search metrics"
                autoCapitalize="none"
                autoCorrect={false}
                clearButtonMode="while-editing"
                accessibilityLabel="Search metrics"
              />
            </View>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: space.lg }}>
              {mode === 'pick' && slot === 'right' && !query.trim() ? (
                <View style={{ marginTop: space.sm }}>
                  <T variant="label" tone="mut" style={{ paddingVertical: space.sm }}>Body</T>
                  <Pressable
                    onPress={() => choose(RECOVERY)}
                    accessibilityRole="button"
                    accessibilityLabel={current === RECOVERY ? 'Recovery body map, in focus' : 'Choose the recovery body map'}
                    style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, backgroundColor: palette.surface,
                      borderRadius: radius.md, borderWidth: 1, borderColor: palette.hair, opacity: pressed ? 0.7 : 1 })}>
                    <SymbolView name={ICONS.lift} tintColor={current === RECOVERY ? palette.accent : palette.mut} size={20} />
                    <View style={{ flex: 1, gap: 2 }}>
                      <T variant="h3">Recovery body map</T>
                      <T variant="small" tone="mut" numberOfLines={2}>How tired each muscle is from recent workouts and runs, on the body figure.</T>
                    </View>
                    {current === RECOVERY ? <SymbolView name={ICONS.check} tintColor={palette.pos} size={18} /> : <T tone="mut">›</T>}
                  </Pressable>
                </View>
              ) : null}
              {groups.length ? groups.map(([group, defs]) => (
                <View key={group} style={{ marginTop: space.sm }}>
                  <T variant="label" tone="mut" style={{ paddingVertical: space.sm }}>{GROUP_LABELS[group]}</T>
                  <View style={{ backgroundColor: palette.surface, borderRadius: radius.md, borderWidth: 1, borderColor: palette.hair, paddingHorizontal: space.md }}>
                    {defs.map((d, i) => (
                      <Row
                        key={d.id}
                        def={d}
                        first={i === 0}
                        mode={mode}
                        added={mode === 'add' ? layout.glance.includes(d.id) : current === d.id}
                        expanded={expanded === d.id}
                        onToggle={() => setExpanded((cur) => (cur === d.id ? null : d.id))}
                        onChoose={() => choose(d.id)}
                      />
                    ))}
                  </View>
                </View>
              )) : (
                <T tone="mut" align="center" style={{ paddingVertical: space.xl }}>Nothing matches “{query.trim()}”.</T>
              )}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

type RowProps = {
  def: MetricDef;
  first: boolean;
  mode: 'add' | 'pick';
  /** Already on the home screen (in At a glance, or the current In focus). */
  added: boolean;
  expanded: boolean;
  onToggle: () => void;
  onChoose: () => void;
};

function Row({ def, first, mode, added, expanded, onToggle, onChoose }: RowProps) {
  const { palette } = useTheme();
  const unavailable = !def.available;
  const inert = unavailable || (mode === 'add' && added);
  const body = unavailable
    ? (expanded ? `${def.unavailableReason ?? ''} ${def.description}`.trim() : def.unavailableReason ?? '')
    : expanded ? `${def.description}${def.setupHint ? ` ${def.setupHint}` : ''}` : firstSentence(def.description);

  return (
    <Pressable
      onPress={inert ? onToggle : onChoose}
      onLongPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={unavailable ? `${def.label}, not available` : added ? `${def.label}, added` : `${mode === 'pick' ? 'Choose' : 'Add'} ${def.label}`}
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md,
        borderTopWidth: first ? 0 : 1, borderTopColor: palette.hair,
        opacity: unavailable ? 0.5 : pressed ? 0.7 : 1,
      })}>
      <SymbolView name={def.icon} tintColor={added && !unavailable ? palette.accent : palette.mut} size={20} />
      <View style={{ flex: 1, gap: 2 }}>
        <T variant="h3" numberOfLines={1}>{def.label}</T>
        {body ? <T variant="small" tone="mut" numberOfLines={expanded ? undefined : 2}>{body}</T> : null}
      </View>
      {unavailable ? (
        <T variant="small" tone="mut">Not available</T>
      ) : added ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <SymbolView name={ICONS.check} tintColor={palette.pos} size={18} />
          <T variant="small" tone="pos" weight="700">{mode === 'pick' ? 'In focus' : 'Added'}</T>
        </View>
      ) : mode === 'pick' ? (
        <T tone="mut">›</T>
      ) : (
        <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: palette.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
          <SymbolView name={ICONS.plus} tintColor={palette.accent} size={18} />
        </View>
      )}
    </Pressable>
  );
}
