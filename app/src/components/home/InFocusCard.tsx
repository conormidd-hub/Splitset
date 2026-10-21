import { router, type Href } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import { useActivityCatchUp, useMuscleNames, useRecoveryMap } from '@/api/recovery';
import { Sparkline } from '@/components/charts/Sparkline';
import { FigurePair } from '@/components/recovery/FigurePair';
import { Badge } from '@/components/ui/Chip';
import { Loading } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { ICONS, type IconName } from '@/lib/icons';
import { METRICS, type Snapshot } from '@/lib/metrics';
import { mostTired } from '@/lib/recovery/screens';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

export type FocusSlot = 'left' | 'right';
/** What a slot shows: a metric's snapshot, the recovery body figure, or nothing chosen yet. */
export type FocusContent = { kind: 'metric'; snapshot: Snapshot } | { kind: 'recovery' } | null;

const WORDY = new Set<Snapshot['id']>(['training_status', 'hrv_status', 'last_activity']);
const MIN_HEIGHT = 178;

/**
 * In focus on Today: two tiles side by side. The left is a metric; the right is the recovery
 * body figure by default, or another metric. Each opens its own screen, and its pencil changes
 * what it shows.
 */
export function InFocusPair({ left, right, onChange }: { left: FocusContent; right: FocusContent; onChange: (slot: FocusSlot) => void }) {
  return (
    <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'stretch' }}>
      {([['left', left], ['right', right]] as const).map(([slot, c]) => (
        <View key={slot} style={{ flex: 1, minWidth: 0 }}>
          {c?.kind === 'metric' ? <MetricFocus s={c.snapshot} onChange={() => onChange(slot)} />
            : c?.kind === 'recovery' ? <RecoveryFocus onChange={() => onChange(slot)} />
            : <EmptyFocus onPress={() => onChange(slot)} />}
        </View>
      ))}
    </View>
  );
}

/** The tile's frame: the body opens the detail, and the pencil beside it (not inside: a button
 *  can't hold another) changes what the tile shows. */
function Tile({ icon, label, onOpen, openLabel, onChange, children }: {
  icon: IconName; label: string; onOpen: () => void; openLabel: string; onChange: () => void; children: ReactNode;
}) {
  const { palette } = useTheme();
  return (
    <View style={{ flex: 1, minHeight: MIN_HEIGHT, backgroundColor: palette.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: palette.hair }}>
      <Pressable
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={openLabel}
        style={({ pressed }) => ({ flex: 1, padding: space.md, gap: 4, opacity: pressed ? 0.85 : 1 })}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingRight: 26, minHeight: 22 }}>
          <SymbolView name={icon} tintColor={palette.accent} size={16} />
          <T variant="label" tone="mut" numberOfLines={1} style={{ flexShrink: 1 }}>{label}</T>
        </View>
        {children}
      </Pressable>
      <Pressable
        onPress={onChange}
        accessibilityRole="button"
        accessibilityLabel={`Change ${label}`}
        hitSlop={10}
        style={({ pressed }) => ({ position: 'absolute', top: space.sm, right: space.sm, width: 28, height: 28, borderRadius: 14,
          alignItems: 'center', justifyContent: 'center', backgroundColor: palette.surface2, opacity: pressed ? 0.7 : 1 })}>
        <SymbolView name={ICONS.edit} tintColor={palette.mut} size={13} />
      </Pressable>
    </View>
  );
}

function MetricFocus({ s, onChange }: { s: Snapshot; onChange: () => void }) {
  const { palette } = useTheme();
  const def = METRICS[s.id];
  const wordy = WORDY.has(s.id);
  const spark = s.spark.filter((p) => p.y != null);
  return (
    <Tile icon={def.icon} label={def.short} onOpen={() => router.push((s.href ?? `/metric/${s.id}`) as Href, { withAnchor: true })}
      openLabel={`${def.label}: ${s.text}${s.unit ? ` ${s.unit}` : ''}${s.sub ? `, ${s.sub}` : ''}`} onChange={onChange}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4 }}>
        <T variant={wordy ? 'h2' : 'display'} numberOfLines={1} style={{ fontVariant: ['tabular-nums'], flexShrink: 1 }}>{s.text}</T>
        {!wordy && s.unit ? <T variant="small" tone="mut">{s.unit}</T> : null}
      </View>
      {s.sub ? <T variant="small" tone={s.subTone} numberOfLines={1}>{s.sub}</T> : null}
      {s.level ? <View style={{ flexDirection: 'row' }}><Badge label={s.level.label} tone={s.level.tone} /></View> : null}
      <View style={{ flex: 1 }} />
      {spark.length >= 2 ? <Sparkline points={s.spark} height={36} color={palette.accent} strokeWidth={2} area dot /> : null}
    </Tile>
  );
}

function RecoveryFocus({ onChange }: { onChange: () => void }) {
  useActivityCatchUp();
  const map = useRecoveryMap();
  const names = useMuscleNames();
  const tired = map.data ? mostTired(map.data, 2) : [];
  const line = tired.length ? tired.map((id) => `${names(id)} · ${map.data![id].label.toLowerCase()}`).join('\n') : 'Every muscle is ready';
  return (
    <Tile icon={ICONS.lift} label="Recovery" onOpen={() => router.push('/recovery')}
      openLabel={`Recovery. ${tired.length ? `Most tired: ${line.replace('\n', ', ')}` : line}. Opens the Recovery screen.`} onChange={onChange}>
      {map.data ? (
        <View style={{ alignItems: 'center', paddingVertical: 2 }}>
          <FigurePair map={map.data} mode="recovery" figureWidth={46} nameOf={names} />
        </View>
      ) : <Loading />}
      <View style={{ flex: 1 }} />
      <T variant="tiny" tone="ink2" numberOfLines={2}>{line}</T>
    </Tile>
  );
}

function EmptyFocus({ onPress }: { onPress: () => void }) {
  const { palette } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Pick an In focus metric"
      style={({ pressed }) => ({
        flex: 1, minHeight: MIN_HEIGHT, borderWidth: 1.5, borderStyle: 'dashed', borderColor: palette.accentLine, borderRadius: radius.lg,
        padding: space.md, alignItems: 'center', justifyContent: 'center', gap: space.xs, opacity: pressed ? 0.8 : 1,
      })}>
      <SymbolView name={ICONS.plus} tintColor={palette.accent} size={20} />
      <T variant="small" tone="accent" weight="700" align="center">Pick a metric</T>
    </Pressable>
  );
}
