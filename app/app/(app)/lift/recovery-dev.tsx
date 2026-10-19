// Development builds only (build phases 6 and 7): the recovery map at any instant, or one
// finished workout's session map, in the app's theme or forced light or dark. Opened from
// Settings → Developer; production builds show neither the card nor this screen.

import { useState } from 'react';
import { View } from 'react-native';

import { useWorkouts } from '@/api/lifting';
import { useProfile } from '@/api/profile';
import { useMuscleNames, useRecoveryMap, useSessionMap, useThresholds } from '@/api/recovery';
import { RecoveryFigure } from '@/components/recovery/RecoveryFigure';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Chip, ChipRow, Segmented } from '@/components/ui/Chip';
import { Screen } from '@/components/ui/Screen';
import { Loading } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { TextField } from '@/components/ui/TextField';
import { workoutWhen } from '@/components/recovery/MuscleSheet';
import { useNowMinute } from '@/lib/clock';
import type { MapMode } from '@/lib/recovery/figure';
import { ThemeOverride } from '@/theme/ThemeProvider';
import type { ThemeName } from '@/theme/tokens';
import { space } from '@/theme/tokens';

const HOUR_MS = 3_600_000;

export default function RecoveryDev() {
  if (!__DEV__) {
    return (
      <Screen>
        <T tone="mut">This preview screen is only in development builds.</T>
      </Screen>
    );
  }
  return <RecoveryDevScreen />;
}

function RecoveryDevScreen() {
  const [atMs, setAtMs] = useState<number | null>(null);
  const [typed, setTyped] = useState('');
  const [typedError, setTypedError] = useState<string | null>(null);
  const [mode, setMode] = useState<MapMode>('recovery');
  const [workoutId, setWorkoutId] = useState<string | null>(null);
  const [theme, setTheme] = useState<'app' | ThemeName>('app');

  const nowMs = useNowMinute();
  const c = useThresholds();
  const names = useMuscleNames();
  const profile = useProfile();
  const timeZone = profile.data?.timezone ?? null;
  const workouts = useWorkouts(10);
  const recovery = useRecoveryMap(atMs ?? undefined);
  const chosen = workoutId ?? workouts.data?.[0]?.id ?? undefined;
  const session = useSessionMap(mode === 'session' ? chosen : undefined);

  // the F26 seed puts Wednesday 20:00 two hours after its last workout (Legs)
  const last = workouts.data?.find((w) => w.finished_at)?.finished_at;
  const seeded = last ? Date.parse(last) + 2 * HOUR_MS : null;
  const step = (hours: number) => setAtMs((cur) => (cur ?? Date.now()) + hours * HOUR_MS);
  const applyTyped = () => {
    const t = Date.parse(typed.trim().replace(' ', 'T'));
    if (Number.isNaN(t)) setTypedError('Use YYYY-MM-DD HH:mm (your device\'s time) or an ISO time');
    else {
      setTypedError(null);
      setAtMs(t);
    }
  };

  const map = mode === 'session' ? session.data : recovery.data;
  const loading = mode === 'session' ? session.isLoading : recovery.isLoading;
  const error = mode === 'session' ? session.error : recovery.error;

  return (
    <Screen>
      <Card title="Recovery map (dev preview)" subtitle="Development builds only. The real screens are Lift → Recovery and the Today card.">
        <View style={{ gap: space.md }}>
          <Segmented options={[{ value: 'recovery', label: 'Recovery' }, { value: 'session', label: 'Session' }]} value={mode} onChange={setMode} />
          {mode === 'recovery' ? (
            <View style={{ gap: space.sm }}>
              <T variant="small" tone="ink2">
                {atMs == null ? 'Now' : 'At'} · {workoutWhen(new Date(atMs ?? nowMs).toISOString(), timeZone)}
                {timeZone ? ` (${timeZone})` : ''}
              </T>
              <ChipRow>
                <Chip label="Now" selected={atMs == null} onPress={() => setAtMs(null)} />
                <Chip label="F26 Wednesday 20:00" selected={atMs != null && atMs === seeded} onPress={() => seeded && setAtMs(seeded)} />
                <Chip label="−1 day" onPress={() => step(-24)} />
                <Chip label="−1 h" onPress={() => step(-1)} />
                <Chip label="+1 h" onPress={() => step(1)} />
                <Chip label="+1 day" onPress={() => step(24)} />
              </ChipRow>
              <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'flex-start' }}>
                <View style={{ flex: 1 }}>
                  <TextField
                    value={typed}
                    onChangeText={setTyped}
                    onSubmitEditing={applyTyped}
                    placeholder="2026-10-14 20:00"
                    autoCapitalize="none"
                    autoCorrect={false}
                    accessibilityLabel="Show the map at"
                    error={typedError}
                  />
                </View>
                <Button title="Show" small variant="secondary" onPress={applyTyped} />
              </View>
            </View>
          ) : (
            <ChipRow>
              {(workouts.data ?? []).map((w) => (
                <Chip
                  key={w.id!}
                  label={`${w.name ?? 'Workout'} · ${workoutWhen(w.finished_at!, timeZone)}`}
                  selected={w.id === chosen}
                  onPress={() => setWorkoutId(w.id)}
                />
              ))}
            </ChipRow>
          )}
          <Segmented
            options={[{ value: 'app', label: 'App theme' }, { value: 'race', label: 'Light' }, { value: 'night', label: 'Dark' }]}
            value={theme}
            onChange={setTheme}
          />
        </View>
      </Card>

      <ThemeOverride name={theme === 'app' ? null : theme}>
        <ThemedFigure>
          {error ? <T tone="neg">{error instanceof Error ? error.message : 'Could not load the map'}</T>
            : loading || !map ? <Loading />
            : <RecoveryFigure map={map} mode={mode} nameOf={names} thresholds={c} timeZone={timeZone} />}
        </ThemedFigure>
      </ThemeOverride>
    </Screen>
  );
}

/** A card in whichever theme the override sets, so forced light or dark shows on its own background. */
function ThemedFigure({ children }: { children: React.ReactNode }) {
  return <Card>{children}</Card>;
}
