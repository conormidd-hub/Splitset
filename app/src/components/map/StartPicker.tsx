import { useState, type ReactNode } from 'react';
import { View } from 'react-native';

import { currentLocation, useDebounced, useHome, usePlaceSearch } from '@/api/places';
import { Button } from '@/components/ui/Button';
import { ListRow } from '@/components/ui/ListRow';
import { ErrorBanner, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { TextField } from '@/components/ui/TextField';
import type { LatLng } from '@/lib/geo';
import { GEOCODER_PROVIDER, samePlace } from '@/lib/places';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

type Props = {
  /** Where searches are biased to: the map's centre. */
  near: LatLng | null;
  /** The search field's prompt: "Start from an address or place", "Add an address as the next point". */
  prompt: string;
  /** A place was chosen: an address, the device's location or the saved home. */
  onPick: (p: LatLng, label: string) => void;
  /** The point "Save as home" would keep, with its label when known. Null hides the button. */
  current: { p: LatLng; label?: string | null } | null;
  /** More buttons for the row, such as "Last run start" or "Clear points". */
  extra?: ReactNode;
};

const MIN_CHARS = 3;
const DEBOUNCE_MS = 350;

/**
 * The ways to put a point on the map without hunting for it: search an address or a place name,
 * use the device's location, or jump to the saved home. "Save as home" keeps the current point
 * (and its label) as home for next time. Shared by the route generator and the course builder.
 */
export function StartPicker({ near, prompt, onPick, current, extra }: Props) {
  const { palette } = useTheme();
  const [q, setQ] = useState('');
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settled = useDebounced(q, DEBOUNCE_MS);
  const results = usePlaceSearch(settled, near);
  const { home, save } = useHome();

  const searching = q.trim().length >= MIN_CHARS;
  const places = searching && settled.trim() === q.trim() ? results.data ?? [] : [];
  const pick = (p: LatLng, label: string) => {
    setQ('');
    setError(null);
    onPick(p, label);
  };
  const useLocation = async () => {
    setError(null);
    setLocating(true);
    try {
      pick(await currentLocation(), 'My location');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLocating(false);
    }
  };
  const saveHome = () => {
    if (!current) return;
    setError(null);
    save.mutate({ ...current.p, label: current.label?.trim() || 'Home' }, { onError: (e) => setError(errorMessage(e)) });
  };
  const canSaveHome = !!current && !samePlace(current.p, home);

  return (
    <View style={{ gap: space.sm }}>
      <TextField
        value={q}
        onChangeText={setQ}
        placeholder={prompt}
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="search"
        accessibilityLabel={prompt}
      />
      {searching ? (
        <View style={{ backgroundColor: palette.surface, borderRadius: radius.md, borderWidth: 1, borderColor: palette.hair, paddingHorizontal: space.md }}>
          {results.isFetching && !places.length ? (
            <T variant="small" tone="mut" style={{ paddingVertical: space.sm }}>Searching…</T>
          ) : results.error ? (
            <T variant="small" tone="neg" style={{ paddingVertical: space.sm }}>{errorMessage(results.error)}</T>
          ) : places.length ? (
            places.map((pl, i) => (
              <ListRow key={`${pl.lat},${pl.lng},${pl.name}`} first={i === 0} title={pl.name} subtitle={pl.detail || undefined} onPress={() => pick({ lat: pl.lat, lng: pl.lng }, pl.name)} />
            ))
          ) : (
            <T variant="small" tone="mut" style={{ paddingVertical: space.sm }}>Nothing found. Try a street and suburb, or a place name.</T>
          )}
          <T variant="tiny" tone="mut" style={{ paddingVertical: space.xs }}>Search by {GEOCODER_PROVIDER}</T>
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
        <Button title="My location" variant="secondary" small onPress={useLocation} loading={locating} />
        {home ? <Button title={`Home · ${home.label}`} variant="secondary" small onPress={() => pick({ lat: home.lat, lng: home.lng }, home.label)} /> : null}
        {canSaveHome ? <Button title={home ? 'Save as home instead' : 'Save as home'} variant="ghost" small onPress={saveHome} loading={save.isPending} /> : null}
        {extra}
      </View>
      {error ? <ErrorBanner message={error} /> : null}
    </View>
  );
}
