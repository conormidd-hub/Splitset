import * as Location from 'expo-location';
import { useMutation, useQuery, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { keys } from './keys';
import { useProfile, useUpdateProfile } from './profile';
import type { Bbox, LatLng } from '@/lib/geo';
import { fetchCafes, searchPlaces, type Cafe, type Place } from '@/lib/places';

/**
 * Places for the route builders: address search results, the cafés in a map box, the user's
 * saved home and their current location.
 */

/** The value once it has stopped changing for `ms`: a search box's text, a map box after a pan. */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** Addresses and places matching `q` (three characters or more), nearest `near` first. */
export function usePlaceSearch(q: string, near: LatLng | null): UseQueryResult<Place[]> {
  const term = q.trim();
  const nearKey = near ? `${near.lat.toFixed(2)},${near.lng.toFixed(2)}` : '';
  return useQuery({
    queryKey: keys.placeSearch(term.toLowerCase(), nearKey),
    enabled: term.length >= 3,
    staleTime: 10 * 60_000,
    retry: false,
    queryFn: () => searchPlaces(term, near),
  });
}

/** The cafés in `box` (from `cafeBox`, so a small pan reuses the last answer). Never goes stale. */
export function useCafes(box: Bbox | null): UseQueryResult<Cafe[]> {
  const key = box ? box.join(',') : '';
  return useQuery({
    queryKey: keys.cafes(key),
    enabled: !!box,
    staleTime: Infinity,
    retry: 1,
    queryFn: () => fetchCafes(box!),
  });
}

export type HomePlace = LatLng & { label: string };

/** The saved home start point, and how to save one (over the last). */
export function useHome(): { home: HomePlace | null; save: UseMutationResult<void, Error, HomePlace> } {
  const { data } = useProfile();
  const update = useUpdateProfile();
  const home: HomePlace | null =
    data?.home_lat != null && data.home_lng != null ? { lat: data.home_lat, lng: data.home_lng, label: data.home_label?.trim() || 'Home' } : null;
  const save = useMutation({
    mutationFn: (h: HomePlace) => update.mutateAsync({ home_lat: h.lat, home_lng: h.lng, home_label: h.label.trim() || 'Home' }),
  });
  return { home, save };
}

/** Where the device is right now. Throws a short, showable message when it cannot say. */
export async function currentLocation(): Promise<LatLng> {
  const perm = await Location.requestForegroundPermissionsAsync();
  if (perm.status !== 'granted') throw new Error('Location is off for Splitset. Allow it in your settings to start from where you are.');
  const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
  const { latitude, longitude } = pos.coords;
  if (typeof latitude !== 'number' || typeof longitude !== 'number') throw new Error('Could not read your location');
  return { lat: latitude, lng: longitude };
}
