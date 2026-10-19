import { SymbolView } from 'expo-symbols';
import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';

import { ListRow } from './ListRow';
import { T } from './T';
import { QuickView } from '@/components/recovery/FigureBubble';
import { ICONS } from '@/lib/icons';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

export type DatedItem = { id: string; /** YYYY-MM-DD, local */ date: string; title: string; subtitle?: string; value?: string };

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

const pad = (n: number) => String(n).padStart(2, '0');
const isoOf = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;

/** The month's days as rows of seven, Monday first, with nulls before the 1st and after the last. */
export function monthGrid(year: number, month: number): (number | null)[][] {
  const first = (new Date(year, month, 1).getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = [...Array(first).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  const rows: (number | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
  return rows;
}

/**
 * A month calendar dropped from a top-bar button: days with something on them carry a dot, and
 * tapping one opens it (or lists them, when the day had more than one). It opens on the month of
 * the newest item; the arrows step back and forth.
 */
export function DateFinder({ visible, onClose, title, items, onOpen, empty = 'Nothing logged yet' }: {
  visible: boolean; onClose: () => void; title: string; items: readonly DatedItem[];
  onOpen: (id: string) => void; empty?: string;
}) {
  const { palette } = useTheme();
  const byDay = useMemo(() => {
    const m = new Map<string, DatedItem[]>();
    for (const it of items) m.set(it.date, [...(m.get(it.date) ?? []), it]);
    return m;
  }, [items]);
  const newest = useMemo(() => items.reduce<string | null>((a, it) => (a == null || it.date > a ? it.date : a), null), [items]);
  // the month on show; null follows the newest item until the arrows are used
  const [picked, setPicked] = useState<{ y: number; m: number } | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const base = newest ? { y: Number(newest.slice(0, 4)), m: Number(newest.slice(5, 7)) - 1 } : { y: new Date().getFullYear(), m: new Date().getMonth() };
  const { y, m } = picked ?? base;
  const step = (by: number) => {
    const d = new Date(y, m + by, 1);
    setPicked({ y: d.getFullYear(), m: d.getMonth() });
    setDay(null);
  };
  const close = () => { setDay(null); setPicked(null); onClose(); };
  const tap = (iso: string) => {
    const on = byDay.get(iso) ?? [];
    if (on.length === 1) { close(); onOpen(on[0].id); } else if (on.length) setDay(iso);
  };
  const monthLabel = new Date(y, m, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const inMonth = items.filter((it) => it.date.startsWith(`${y}-${pad(m + 1)}`)).length;
  const today = new Date();
  const todayIso = isoOf(today.getFullYear(), today.getMonth(), today.getDate());

  return (
    <QuickView visible={visible} onClose={close} title={title}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Arrow dir="back" onPress={() => step(-1)} label="Previous month" />
        <View style={{ flex: 1, alignItems: 'center' }}>
          <T variant="h3">{monthLabel}</T>
          <T variant="tiny" tone="mut">{inMonth ? `${inMonth} logged` : items.length ? 'Nothing this month' : empty}</T>
        </View>
        <Arrow dir="chevron" onPress={() => step(1)} label="Next month" />
      </View>
      <View style={{ gap: 2 }}>
        <View style={{ flexDirection: 'row' }}>
          {WEEKDAYS.map((d, i) => <T key={i} variant="tiny" tone="mut" align="center" style={{ flex: 1 }}>{d}</T>)}
        </View>
        {monthGrid(y, m).map((row, r) => (
          <View key={r} style={{ flexDirection: 'row' }}>
            {row.map((d, i) => {
              if (d == null) return <View key={i} style={{ flex: 1, height: 38 }} />;
              const iso = isoOf(y, m, d);
              const count = byDay.get(iso)?.length ?? 0;
              const sel = day === iso;
              return (
                <Pressable
                  key={i}
                  onPress={() => tap(iso)}
                  disabled={!count}
                  accessibilityRole="button"
                  accessibilityLabel={`${d} ${monthLabel}${count ? `, ${count} logged` : ''}`}
                  style={({ pressed }) => ({ flex: 1, height: 38, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}>
                  <View style={{
                    width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
                    backgroundColor: sel ? palette.accent : count ? palette.accentSoft : 'transparent',
                    borderWidth: iso === todayIso ? 1 : 0, borderColor: palette.mut,
                  }}>
                    <T variant="small" weight={count ? '700' : '400'} tone={sel ? 'onAccent' : count ? 'ink' : 'mut'}>{d}</T>
                  </View>
                  {count ? <View style={{ position: 'absolute', bottom: 1, width: 4, height: 4, borderRadius: 2, backgroundColor: sel ? palette.ink : palette.accent }} /> : null}
                </Pressable>
              );
            })}
          </View>
        ))}
      </View>
      {day ? (
        <View style={{ borderRadius: radius.md, backgroundColor: palette.surface2, paddingHorizontal: space.md }}>
          {(byDay.get(day) ?? []).map((it, i) => (
            <ListRow key={it.id} first={i === 0} title={it.title} subtitle={it.subtitle} value={it.value} onPress={() => { close(); onOpen(it.id); }} />
          ))}
        </View>
      ) : null}
    </QuickView>
  );
}

function Arrow({ dir, onPress, label }: { dir: 'back' | 'chevron'; onPress: () => void; label: string }) {
  const { palette } = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={8}
      style={({ pressed }) => ({ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.surface2, opacity: pressed ? 0.7 : 1 })}>
      <SymbolView name={ICONS[dir]} tintColor={palette.ink2} size={18} />
    </Pressable>
  );
}
