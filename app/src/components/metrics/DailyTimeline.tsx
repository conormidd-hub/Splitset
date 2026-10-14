import { View } from 'react-native';

import { T } from '@/components/ui/T';
import { describeDelta, type MetricId, type TimelineRow } from '@/lib/metrics';
import type { Units } from '@/lib/units';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';
import { shortDay } from './helpers';

const DATE_W = 54;
const DELTA_W = 64;

type Props = { id: MetricId; rows: TimelineRow[]; units: Units; today: string };

/**
 * The Day view: the last fortnight as a list, newest first, each day a bar scaled between the
 * fortnight's low and high, the value beside it and the change from the previous reading.
 */
export function DailyTimeline({ id, rows, units, today }: Props) {
  const { palette } = useTheme();
  const present = rows.map((r) => r.value).filter((v): v is number => v != null);
  if (!present.length) {
    return <T tone="mut" align="center" style={{ paddingVertical: space.xl }}>Nothing in the last 14 days yet</T>;
  }
  const min = Math.min(...present);
  const max = Math.max(...present);
  const span = max - min;
  // one width for the value column, from the longest text, so the bars end in a straight line
  const valueW = Math.min(132, Math.max(56, Math.max(...rows.map((r) => r.text.length)) * 8.5 + 4));

  return (
    <View>
      {rows.map((row, i) => {
        const isToday = row.date === today;
        const has = row.value != null;
        const frac = has ? (span > 0 ? ((row.value as number) - min) / span : 1) : 0;
        const delta = row.delta == null ? null : describeDelta(id, row.delta, units);
        const glyph = row.delta == null ? '' : row.delta > 0 ? '▲' : row.delta < 0 ? '▼' : '';
        // the glyph carries the sign, so the text drops its own
        const deltaText = !delta ? '' : row.delta === 0 ? '±0' : `${glyph} ${delta.text.replace(/^[+−]/, '')}`;
        return (
          <View
            key={row.date}
            style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 7, borderTopWidth: i ? 1 : 0, borderTopColor: palette.hair }}>
            <T variant="small" tone={isToday ? 'accent' : 'mut'} weight={isToday ? '700' : '600'} style={{ width: DATE_W }} numberOfLines={1}>
              {shortDay(row.date, today)}
            </T>
            {has ? (
              <View style={{ flex: 1, height: 10, borderRadius: radius.pill, backgroundColor: palette.surface3, overflow: 'hidden' }}>
                <View style={{ width: `${Math.round(6 + frac * 94)}%`, height: '100%', borderRadius: radius.pill, backgroundColor: palette.accent, opacity: isToday ? 1 : 0.35 }} />
              </View>
            ) : (
              <View style={{ flex: 1, height: 10, borderRadius: radius.pill, borderWidth: 1, borderStyle: 'dotted', borderColor: palette.hair }} />
            )}
            <T variant="mono" tone={has ? 'ink' : 'mut'} weight={isToday ? '700' : undefined} style={{ width: valueW, textAlign: 'right' }} numberOfLines={1}>
              {row.text}
            </T>
            <T variant="small" tone={delta?.tone ?? 'mut'} style={{ width: DELTA_W, textAlign: 'right', fontVariant: ['tabular-nums'] }} numberOfLines={1}>
              {deltaText}
            </T>
          </View>
        );
      })}
    </View>
  );
}
