import { SymbolView } from 'expo-symbols';
import { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LineChart, type Point, type Series } from '@/components/charts/LineChart';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { T } from '@/components/ui/T';
import { TextField } from '@/components/ui/TextField';
import { compareTrend } from '@/lib/homeLayout';
import { ICONS } from '@/lib/icons';
import { dailyWindow, formatMetric, GROUP_LABELS, METRIC_ORDER, METRICS, type MetricDef, type MetricGroup, type MetricId, type MetricInputs } from '@/lib/metrics';
import { dayMs, rolling, WEEKLY_METRICS, weeklyTotals } from '@/lib/trends';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

const WIDE = 640;

/** How a metric reads in a comparison; the weekly totals say so ("Running per week"). */
function nameOf(id: MetricId, short = false): string {
  const def = METRICS[id];
  return WEEKLY_METRICS.has(id) ? `${def.short} per week` : short ? def.short : def.label;
}

/** A comparison card's title and subtitle: "HRV vs Sleep" over "HRV (left) · Sleep (right)". */
export function compareText(a: MetricId, b: MetricId): { label: string; subtitle: string } {
  return { label: `${nameOf(a)} vs ${nameOf(b)}`, subtitle: `${nameOf(a, true)} (left) · ${nameOf(b, true)} (right)` };
}

/** A metric as a comparison draws it: its 7-day rolling mean, or a point per week for the
 *  weekly totals. Two years at most, as the single-metric charts. */
function comparePoints(id: MetricId, inputs: MetricInputs, days: number): Point[] {
  const n = Math.min(days, 730);
  if (WEEKLY_METRICS.has(id)) {
    // reach back to the first week's Monday, so the line doesn't open on a part-week dip
    const start = new Date(dayMs(inputs.today) - (n - 1) * 86_400_000);
    return weeklyTotals(dailyWindow(id, inputs, n + ((start.getDay() + 6) % 7)));
  }
  return rolling(dailyWindow(id, inputs, n).map((d) => ({ x: dayMs(d.date), y: d.value })), 7);
}

/**
 * Two metrics on one chart: the first on the left axis in the accent colour, the second on the
 * right in orange, each axis labelled in its own metric's terms. A tap reads both on that day.
 */
export function CompareChart({ a, b, inputs, days, height = 190 }: { a: MetricId; b: MetricId; inputs: MetricInputs; days: number; height?: number }) {
  const { palette } = useTheme();
  const left = useMemo(() => comparePoints(a, inputs, days), [a, inputs, days]);
  const right = useMemo(() => comparePoints(b, inputs, days), [b, inputs, days]);
  const series: Series[] = [
    { name: METRICS[a].short, color: palette.accent, points: left },
    { name: METRICS[b].short, color: palette.orange, points: right, axis: 'right' },
  ];
  // a line through four or five weekly totals hides where each week sits, so they get dots too
  if (WEEKLY_METRICS.has(a)) series.push({ name: `${METRICS[a].short} weeks`, color: palette.accent, points: left, kind: 'points', legend: false });
  if (WEEKLY_METRICS.has(b)) series.push({ name: `${METRICS[b].short} weeks`, color: palette.orange, points: right, kind: 'points', legend: false, axis: 'right' });
  return (
    <LineChart
      height={height}
      series={series}
      yFormat={(v) => formatMetric(a, v, inputs.units).text}
      yFormatRight={(v) => formatMetric(b, v, inputs.units).text}
      // a weekly total cannot dip below nothing
      yMin={WEEKLY_METRICS.has(a) ? 0 : undefined}
      yMinRight={WEEKLY_METRICS.has(b) ? 0 : undefined}
      emptyText="Neither has readings in this range"
    />
  );
}

type Side = 'a' | 'b';
const SIDE_NAME: Record<Side, string> = { a: 'left', b: 'right' };

/**
 * Builds a comparison for the Trends screen: a metric for the left axis, one for the right, a
 * live preview over the screen's range, then Add. The same pair already on the screen (either
 * way round) is named rather than added twice. A bottom sheet on a phone, a centred card on a
 * wide screen.
 */
export function CompareBuilder({ visible, onClose, onAdd, existing, chartable, inputs, days, rangeText }: {
  visible: boolean;
  onClose: () => void;
  /** The new comparison's id (compareTrend); the caller saves it. */
  onAdd: (id: string) => void;
  /** The charts on the screen now. */
  existing: readonly string[];
  /** Whether a metric can be charted, the same rule the Add sheet uses. */
  chartable: (id: MetricId) => boolean;
  inputs: MetricInputs;
  days: number;
  /** The screen's range for the preview's caption, e.g. "last 90 days". */
  rangeText: string;
}) {
  const { palette, name } = useTheme();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const wide = width >= WIDE;
  const [a, setA] = useState<MetricId | null>(null);
  const [b, setB] = useState<MetricId | null>(null);
  // which side the list is choosing for; null once both are chosen shows the preview
  const [side, setSide] = useState<Side | null>('a');
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = new Map<MetricGroup, MetricDef[]>();
    for (const id of METRIC_ORDER) {
      const d = METRICS[id];
      if (!chartable(id) || (q && !`${d.label} ${d.short} ${GROUP_LABELS[d.group]}`.toLowerCase().includes(q))) continue;
      out.set(d.group, [...(out.get(d.group) ?? []), d]);
    }
    return [...out.entries()];
  }, [query, chartable]);

  const close = () => {
    setA(null);
    setB(null);
    setSide('a');
    setQuery('');
    onClose();
  };
  const choose = (id: MetricId) => {
    // the next side still empty is asked for next; with both chosen, the preview
    if (side === 'b') {
      setB(id);
      setSide(a ? null : 'a');
    } else {
      setA(id);
      setSide(b ? null : 'b');
    }
    setQuery('');
  };
  const tapSide = (s: Side) => setSide((cur) => (cur === s && a && b ? null : s));
  const exact = a != null && b != null && existing.includes(compareTrend(a, b));
  const reversed = a != null && b != null && existing.includes(compareTrend(b, a));
  const add = () => {
    if (!a || !b || a === b || exact || reversed) return;
    onAdd(compareTrend(a, b));
    close();
  };

  const scrim = name === 'night' ? palette.bg : palette.ink;
  const choosing = side ? (side === 'a' ? a : b) : null;
  const other = side ? (side === 'a' ? b : a) : null;
  const sideColour = (s: Side) => (s === 'a' ? palette.accent : palette.orange);
  const text = a && b ? compareText(a, b) : null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close} aria-label="Compare two metrics">
      <View style={{ flex: 1 }}>
        {/* a tap outside the card closes it; screen readers get the card's Close and Escape */}
        <View aria-hidden onStartShouldSetResponder={() => true} onResponderRelease={close}
          style={[StyleSheet.absoluteFill, { backgroundColor: scrim, opacity: 0.5 }]} />
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          accessibilityViewIsModal
          onAccessibilityEscape={close}
          style={{ flex: 1, justifyContent: wide ? 'center' : 'flex-end', alignItems: wide ? 'center' : 'stretch', pointerEvents: 'box-none' }}>
          <View style={{
            backgroundColor: palette.bg, maxHeight: '85%', width: wide ? 520 : undefined,
            borderRadius: wide ? radius.lg : 0, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
            borderWidth: 1, borderColor: palette.hair, paddingBottom: wide ? 0 : insets.bottom,
          }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg, paddingBottom: space.sm }}>
              <View style={{ flex: 1 }}>
                <T variant="h2" accessibilityRole="header">Compare two metrics</T>
                <T variant="small" tone="mut">One on each axis, on one chart</T>
              </View>
              <Pressable onPress={close} accessibilityRole="button" accessibilityLabel="Close" hitSlop={8}
                style={({ pressed }) => ({ width: 32, height: 32, borderRadius: 16, backgroundColor: palette.surface2, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.7 : 1 })}>
                <SymbolView name={ICONS.close} tintColor={palette.ink2} size={16} />
              </Pressable>
            </View>

            <View style={{ flexDirection: 'row', gap: space.sm, paddingHorizontal: space.lg, paddingBottom: space.sm }}>
              {(['a', 'b'] as const).map((s) => (
                <SideButton key={s} side={s} metric={s === 'a' ? a : b} colour={sideColour(s)} active={side === s} onPress={() => tapSide(s)} />
              ))}
            </View>

            {side ? (
              <View style={{ paddingHorizontal: space.lg, paddingBottom: space.sm, gap: space.sm }}>
                <T variant="small" tone="mut">Choose a metric for the {SIDE_NAME[side]} axis.</T>
                <TextField value={query} onChangeText={setQuery} placeholder="Search metrics" autoCapitalize="none" autoCorrect={false}
                  clearButtonMode="while-editing" accessibilityLabel="Search metrics" />
              </View>
            ) : null}

            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: space.lg, gap: space.sm }}>
              {side ? (
                groups.length ? groups.map(([group, defs]) => (
                  <View key={group}>
                    <T variant="label" tone="mut" style={{ paddingVertical: space.sm }}>{GROUP_LABELS[group]}</T>
                    <View style={{ backgroundColor: palette.surface, borderRadius: radius.md, borderWidth: 1, borderColor: palette.hair, paddingHorizontal: space.md }}>
                      {defs.map((d, i) => {
                        const taken = d.id === other;
                        const current = d.id === choosing;
                        return (
                          <Pressable
                            key={d.id}
                            onPress={taken ? undefined : () => choose(d.id)}
                            accessibilityRole="button"
                            accessibilityState={taken ? { disabled: true } : { selected: current }}
                            accessibilityLabel={taken ? `${d.label}, on the ${SIDE_NAME[side === 'a' ? 'b' : 'a']} axis` : d.label}
                            style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md,
                              borderTopWidth: i ? 1 : 0, borderTopColor: palette.hair, opacity: taken ? 0.5 : pressed ? 0.7 : 1 })}>
                            <SymbolView name={d.icon} tintColor={current ? sideColour(side) : palette.mut} size={20} />
                            <View style={{ flex: 1, gap: 2 }}>
                              <T variant="h3" numberOfLines={1}>{d.label}</T>
                              <T variant="small" tone="mut" numberOfLines={1}>
                                {taken ? `On the ${SIDE_NAME[side === 'a' ? 'b' : 'a']} axis` : WEEKLY_METRICS.has(d.id) ? 'A total per week' : 'Daily, as a 7-day mean'}
                              </T>
                            </View>
                            {current ? (
                              <SymbolView name={ICONS.check} tintColor={palette.pos} size={18} />
                            ) : taken ? null : (
                              <SymbolView name={ICONS.chevron} tintColor={palette.mut} size={16} />
                            )}
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>
                )) : (
                  <T tone="mut" align="center" style={{ paddingVertical: space.xl }}>Nothing matches “{query.trim()}”.</T>
                )
              ) : a && b && text ? (
                <View style={{ gap: space.sm, paddingTop: space.xs }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <T variant="label" tone="mut">Preview, {rangeText}</T>
                    <Button title="Swap sides" variant="ghost" small onPress={() => { setA(b); setB(a); }} />
                  </View>
                  <Card title={text.label} subtitle={text.subtitle}>
                    <CompareChart a={a} b={b} inputs={inputs} days={days} />
                  </Card>
                  <T variant="small" tone="mut">Each axis has its own scale, so read the shapes together rather than the heights. Tap the chart for both values on a day.</T>
                </View>
              ) : null}
            </ScrollView>

            <View style={{ paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.lg, gap: space.sm, borderTopWidth: 1, borderTopColor: palette.hair }}>
              {exact || reversed ? (
                <T variant="small" tone="mut" align="center">
                  {exact ? 'This comparison is already on Trends.' : 'These two are already on Trends, with the sides the other way round.'}
                </T>
              ) : null}
              <Button title="Add comparison" onPress={add} disabled={!a || !b || a === b || exact || reversed} />
            </View>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

/** One side of the comparison: its axis, the metric on it, and a tap to choose another. */
function SideButton({ side, metric, colour, active, onPress }: { side: Side; metric: MetricId | null; colour: string; active: boolean; onPress: () => void }) {
  const { palette } = useTheme();
  const axis = `${side === 'a' ? 'Left' : 'Right'} axis`;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`${axis}: ${metric ? METRICS[metric].label : 'not chosen'}`}
      accessibilityHint="Choose the metric for this axis"
      style={({ pressed }) => ({
        flex: 1, gap: 2, paddingVertical: space.sm, paddingHorizontal: space.md, borderRadius: radius.md,
        backgroundColor: palette.surface, borderWidth: 2, borderColor: active ? colour : palette.hair, opacity: pressed ? 0.8 : 1,
      })}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colour }} />
        <T variant="label" tone="mut">{axis}</T>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <T variant="h3" tone={metric ? 'ink' : 'mut'} numberOfLines={1} style={{ flex: 1 }}>{metric ? METRICS[metric].short : 'Choose'}</T>
        <SymbolView name={active ? ICONS.collapse : ICONS.expand} tintColor={palette.mut} size={14} />
      </View>
    </Pressable>
  );
}
