import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { isRun, typeLabel, useActivity } from '@/api/activities';
import { useUnits } from '@/api/profile';
import { useRunEfforts, useTrack } from '@/api/segments';
import { RouteCard } from '@/components/run/RouteCard';
import { SegmentsCard } from '@/components/run/SegmentsCard';
import { StatsStrip } from '@/components/run/StatsStrip';
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
  const run = isRun(a?.type);
  // The track is the cached decode of activity_details that the segment scans reuse.
  const trackQ = useTrack(id);
  const effortsQ = useRunEfforts(run ? id : undefined);
  // A finger scrubbing a profile chart freezes the page scroll until it lifts.
  const [scrubbing, setScrubbing] = useState(false);
  /** The inspected point: set from the map or the chart, read by the sticky stats bar. */
  const [cursor, setCursor] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  /** Past the name row: the pinned bar shows its own back chevron. */
  const [scrolled, setScrolled] = useState(false);

  if (q.isLoading) return <Screen><Loading label="Loading activity" /></Screen>;
  if (q.error || !a) return <Screen><ErrorBanner message={errorMessage(q.error) || 'Activity not found'} /></Screen>;

  const pace = secPerKm(a.distance_m, a.moving_time_s);
  const details = a.activity_details;
  const splits = (details?.splits as Split[] | null) ?? [];
  const bestEfforts = (details?.best_efforts as Record<string, number> | null) ?? null;
  const segmentEfforts = effortsQ.data ?? [];
  const zoneTimes = a.hr_zone_times ?? [];
  const zoneTotal = zoneTimes.reduce((s, v) => s + v, 0);
  const zoneColours = [palette.mut, palette.blue, palette.aqua, palette.amber, palette.orange, palette.neg, palette.neg];

  const track = trackQ.data ?? null;
  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/run');
  };
  const canCut = run && !!track && track.pts.length >= 2;

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1, backgroundColor: palette.bg }}>
        <ScrollView
          scrollEnabled={!scrubbing}
          stickyHeaderIndices={[1]}
          scrollEventThrottle={32}
          onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => {
            const past = e.nativeEvent.contentOffset.y > 20;
            setScrolled((cur) => (cur === past ? cur : past));
          }}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: space.xxl }}>
          {/* the name scrolls away under the pinned stats bar */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingLeft: space.sm, paddingRight: space.lg, paddingTop: space.sm }}>
            <Pressable onPress={goBack} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back" style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, paddingHorizontal: space.sm })}>
              <T variant="h1" tone="ink">‹</T>
            </Pressable>
            <T variant="h1" numberOfLines={1} style={{ flex: 1 }}>{a.name ?? typeLabel(a.type)}</T>
          </View>

          {/* the stats bar: pinned at the top once the name has scrolled under it */}
          <View style={{ backgroundColor: palette.bg, flexDirection: 'row', alignItems: 'center', paddingLeft: space.sm, paddingRight: space.lg, paddingTop: space.xs, paddingBottom: space.sm, borderBottomWidth: 1, borderBottomColor: palette.hair }}>
            <Pressable
              onPress={goBack}
              disabled={!scrolled}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Back"
              accessibilityElementsHidden={!scrolled}
              importantForAccessibility={scrolled ? 'auto' : 'no-hide-descendants'}
              style={({ pressed }) => ({ width: 24, alignItems: 'center', opacity: scrolled ? (pressed ? 0.6 : 1) : 0 })}>
              <T variant="h2" tone="ink">‹</T>
            </Pressable>
            <View style={{ flex: 1 }}>
              {track ? (
                <StatsStrip track={track} index={cursor} units={units} onClear={() => setCursor(null)} valueTone="accent" size="large" />
              ) : trackQ.isLoading ? (
                <Loading />
              ) : (
                <T variant="small" tone="mut">No detail streams for this activity yet.</T>
              )}
            </View>
          </View>

          <View style={{ padding: space.lg, gap: space.md }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
              <T variant="small" tone="mut" numberOfLines={1} style={{ flexShrink: 1 }}>
                {longDate(a.start_time_local)} · {shortTime(a.start_time_local)}{a.device ? ` · ${a.device}` : ''}
              </T>
              <Badge label={typeLabel(a.type)} tone={run ? 'accent' : 'mut'} />
            </View>

            {trackQ.error ? (
              <Card title="Route"><ErrorBanner message={errorMessage(trackQ.error)} /></Card>
            ) : track ? (
              <RouteCard
                activityId={id}
                track={track}
                units={units}
                hrZones={a.hr_zones}
                efforts={segmentEfforts}
                cursor={cursor}
                onCursor={setCursor}
                creating={creating}
                onCreatingChange={setCreating}
                onScrubbingChange={setScrubbing}
              />
            ) : null}

            {run ? <SegmentsCard activityId={id} units={units} trackReady={!trackQ.isLoading} onCut={canCut ? () => setCreating(true) : undefined} /> : null}

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
                    {/* the bar lives in its own track so the fastest split's label never runs into the hr column */}
                    <View style={{ flex: 1 }}>
                      <View style={{ height: 8, borderRadius: 4, backgroundColor: palette.accent, opacity: 0.85, width: `${Math.round(35 + (1 - frac) * 65)}%` }} />
                    </View>
                    <T variant="mono" style={{ width: 48 }}>{formatPace(s.t, units, false)}</T>
                  </View>
                  <T variant="mono" tone="mut" style={{ width: 60, textAlign: 'right' }}>{s.hr ?? '–'}</T>
                  <T variant="mono" tone="mut" style={{ width: 60, textAlign: 'right' }}>{s.el != null ? `+${s.el}` : '–'}</T>
                </View>
              );
            })}
          </Card>
        ) : null}

        {bestEfforts && Object.keys(bestEfforts).length ? (
          <Card title="Best efforts" subtitle="Fastest stretch inside this run">
            <Grid>
              {Object.entries(bestEfforts)
                .sort((x, y) => Number(x[0]) - Number(y[0]))
                .map(([m, s]) => (
                  <StatTile key={m} label={EFFORT_LABELS[m] ?? `${m} m`} value={formatDuration(s)} sub={formatPace(s / (Number(m) / 1000), units)} />
                ))}
            </Grid>
          </Card>
        ) : null}
          </View>
        </ScrollView>
      </SafeAreaView>
    </>
  );
}
