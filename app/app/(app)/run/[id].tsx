import { Stack, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';

import { isRun, typeLabel, useActivity } from '@/api/activities';
import { useUnits } from '@/api/profile';
import { LineChart } from '@/components/charts/LineChart';
import { RouteSvg } from '@/components/map/RouteSvg';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Chip';
import { Screen } from '@/components/ui/Screen';
import { Grid, StatTile } from '@/components/ui/StatTile';
import { ErrorBanner, Loading, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { longDate, shortTime } from '@/lib/dates';
import { formatDistance, formatDuration, formatElevation, formatHr, formatNumber, formatPace, secPerKm } from '@/lib/units';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

type Split = { k: number; t: number; hr: number | null; el: number | null };

const EFFORT_LABELS: Record<string, string> = {
  '1000': '1 km', '1609': '1 mile', '3000': '3 km', '5000': '5 km', '10000': '10 km',
  '15000': '15 km', '21097': 'Half', '42195': 'Marathon',
};

export default function ActivityDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const units = useUnits();
  const { palette } = useTheme();
  const q = useActivity(id);
  const a = q.data;

  if (q.isLoading) return <Screen><Loading label="Loading activity" /></Screen>;
  if (q.error || !a) return <Screen><ErrorBanner message={errorMessage(q.error) || 'Activity not found'} /></Screen>;

  const run = isRun(a.type);
  const pace = secPerKm(a.distance_m, a.moving_time_s);
  const details = a.activity_details;
  const splits = (details?.splits as Split[] | null) ?? [];
  const efforts = (details?.best_efforts as Record<string, number> | null) ?? null;
  const raw = details?.samples as { t: number[]; d: number[]; hr: (number | null)[] | null; alt: (number | null)[] | null } | null;
  const samples = raw && raw.t.length > 2 ? (() => {
    const hr = raw.t.map((t, i) => ({ x: t * 1000, y: raw.hr ? raw.hr[i] : null }));
    const pace = raw.t.map((t, i) => {
      if (i === 0) return { x: 0, y: null };
      const dd = raw.d[i] - raw.d[i - 1];
      const dt = t - raw.t[i - 1];
      const secPerKmHere = dd > 0 ? dt / (dd / 1000) : null;
      const shown = secPerKmHere == null || secPerKmHere > 900 ? null : (units === 'imperial' ? secPerKmHere * 1.609344 : secPerKmHere) / 60;
      return { x: t * 1000, y: shown };
    });
    return { hr, pace };
  })() : null;
  const zoneTimes = a.hr_zone_times ?? [];
  const zoneTotal = zoneTimes.reduce((s, v) => s + v, 0);
  const zoneColours = [palette.mut, palette.blue, palette.aqua, palette.amber, palette.orange, palette.neg, palette.neg];

  return (
    <>
      <Stack.Screen options={{ title: typeLabel(a.type) }} />
      <Screen>
        <View style={{ gap: space.xs }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <T variant="h1" style={{ flexShrink: 1 }}>{a.name ?? typeLabel(a.type)}</T>
            <Badge label={typeLabel(a.type)} tone={run ? 'accent' : 'mut'} />
          </View>
          <T tone="mut">{longDate(a.start_time_local)} · {shortTime(a.start_time_local)}{a.device ? ` · ${a.device}` : ''}</T>
        </View>

        <Card>
          <Grid>
            {a.distance_m ? <StatTile label="Distance" value={formatDistance(a.distance_m, units, 2)} /> : null}
            <StatTile label="Moving time" value={formatDuration(a.moving_time_s)} sub={a.elapsed_time_s ? `elapsed ${formatDuration(a.elapsed_time_s)}` : undefined} />
            {pace ? <StatTile label="Pace" value={formatPace(pace, units, false)} sub={units === 'imperial' ? '/mi' : '/km'} /> : null}
            <StatTile label="Avg HR" value={formatHr(a.avg_hr)} sub={a.max_hr ? `max ${a.max_hr}` : undefined} />
            {a.load != null ? <StatTile label="Load" value={formatNumber(a.load)} sub={a.intensity != null ? `intensity ${formatNumber(a.intensity)}` : undefined} /> : null}
            {a.elev_gain_m != null ? <StatTile label="Climb" value={formatElevation(a.elev_gain_m, units)} /> : null}
            {a.cadence != null ? <StatTile label="Cadence" value={formatNumber(a.cadence)} sub="spm" /> : null}
            {a.gap_ms != null && run ? <StatTile label="GAP" value={formatPace(1000 / a.gap_ms, units, false)} sub="grade adjusted" /> : null}
            {a.calories != null ? <StatTile label="Calories" value={formatNumber(a.calories)} /> : null}
            {a.gct_ms != null ? <StatTile label="Ground contact" value={`${formatNumber(a.gct_ms)} ms`} /> : null}
            {a.vert_osc_cm != null ? <StatTile label="Vertical osc." value={`${formatNumber(a.vert_osc_cm, 1)} cm`} /> : null}
            {a.stride_m != null ? <StatTile label="Stride" value={`${formatNumber(a.stride_m, 2)} m`} /> : null}
          </Grid>
        </Card>

        {zoneTotal > 0 ? (
          <Card title="Heart-rate zones" subtitle="Share of time">
            <View style={{ flexDirection: 'row', height: 14, borderRadius: radius.pill, overflow: 'hidden', gap: 2 }}>
              {zoneTimes.map((s, i) => (
                <View key={i} style={{ flex: Math.max(s, 0.0001), backgroundColor: zoneColours[i] ?? palette.mut }} />
              ))}
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md, marginTop: space.sm }}>
              {zoneTimes.map((s, i) => (
                <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: zoneColours[i] ?? palette.mut }} />
                  <T variant="small" tone="mut">Z{i + 1} {Math.round((s / zoneTotal) * 100)}%</T>
                </View>
              ))}
            </View>
          </Card>
        ) : null}

        {splits.length ? (
          <Card title="Splits" subtitle="Per kilometre">
            <View style={{ flexDirection: 'row', paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: palette.hair }}>
              <T variant="label" tone="mut" style={{ width: 40 }}>km</T>
              <T variant="label" tone="mut" style={{ flex: 1 }}>pace</T>
              <T variant="label" tone="mut" style={{ width: 60, textAlign: 'right' }}>hr</T>
              <T variant="label" tone="mut" style={{ width: 60, textAlign: 'right' }}>climb</T>
            </View>
            {splits.map((s) => {
              const fastest = Math.min(...splits.map((x) => x.t));
              const slowest = Math.max(...splits.map((x) => x.t));
              const frac = slowest > fastest ? (s.t - fastest) / (slowest - fastest) : 0;
              return (
                <View key={s.k} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6 }}>
                  <T variant="mono" tone="mut" style={{ width: 40 }}>{s.k}</T>
                  <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                    <View style={{ height: 8, borderRadius: 4, backgroundColor: palette.accent, opacity: 0.85, width: `${Math.round(35 + (1 - frac) * 60)}%` }} />
                    <T variant="mono">{formatPace(s.t, units, false)}</T>
                  </View>
                  <T variant="mono" tone="mut" style={{ width: 60, textAlign: 'right' }}>{s.hr ?? '–'}</T>
                  <T variant="mono" tone="mut" style={{ width: 60, textAlign: 'right' }}>{s.el != null ? `+${s.el}` : '–'}</T>
                </View>
              );
            })}
          </Card>
        ) : null}

        {efforts && Object.keys(efforts).length ? (
          <Card title="Best efforts" subtitle="Fastest stretch inside this run">
            <Grid>
              {Object.entries(efforts)
                .sort((x, y) => Number(x[0]) - Number(y[0]))
                .map(([m, s]) => (
                  <StatTile key={m} label={EFFORT_LABELS[m] ?? `${m} m`} value={formatDuration(s)} sub={formatPace(s / (Number(m) / 1000), units)} />
                ))}
            </Grid>
          </Card>
        ) : null}

        {samples ? (
          <Card title="Heart rate and pace" subtitle="Every 10 seconds">
            <LineChart
              height={180}
              series={[
                { name: 'bpm', color: palette.neg, points: samples.hr },
                { name: units === 'imperial' ? 'min/mi' : 'min/km', color: palette.accent, points: samples.pace, dashed: true },
              ]}
              xFormat={(ms) => `${Math.round(ms / 60000)}m`}
              yFormat={(v) => `${Math.round(v)}`}
            />
          </Card>
        ) : null}

        {details?.polyline ? (
          <Card title="Route">
            <RouteSvg encoded={details.polyline} />
          </Card>
        ) : null}
      </Screen>
    </>
  );
}
