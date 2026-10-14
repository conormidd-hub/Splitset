import polyline from '@mapbox/polyline';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { keys } from './keys';
import { ROUTING_PROVIDER, valhalla } from './routing';
import { bboxOf, decodeRoute, type LatLng } from '@/lib/geo';
import type { Candidate } from '@/lib/routeBuilder';
import { useUserId } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import type { Tables, TablesInsert } from '@/types/database';

/**
 * Saved routes: the ones the user generated with `lib/routeBuilder` and chose to keep.
 *
 * A route row stores the routed shape as a precision-5 Google polyline (the same encoding as
 * activity_details.polyline, so `decodeRoute` reads both), its distance, climb and descent, the
 * chosen start, its box and how it was made. Terrain heights are not stored: `useRouteHeights`
 * asks Valhalla once per session and caches the answer for as long as the app runs.
 */

export type SavedRoute = Tables<'routes'>;

export function useRoutes(): UseQueryResult<SavedRoute[]> {
  const uid = useUserId();
  return useQuery({
    queryKey: keys.routes(uid),
    enabled: !!uid,
    queryFn: async (): Promise<SavedRoute[]> => {
      const { data, error } = await supabase
        .from('routes')
        .select('*')
        .eq('user_id', uid)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
  });
}

export function useRoute(id: string | undefined): UseQueryResult<SavedRoute> {
  return useQuery({
    queryKey: keys.route(id ?? ''),
    enabled: !!id,
    queryFn: async (): Promise<SavedRoute> => {
      const { data, error } = await supabase.from('routes').select('*').eq('id', id!).single();
      if (error) throw error;
      return data;
    },
  });
}

/**
 * Terrain height (metres) at every point of the route's decoded polyline, so the profile's x axis
 * is the cumulative distance along `decodeRoute(route.polyline)`. Valhalla is asked for at most 400
 * points spread evenly along the path (`valhalla.heights` resamples and interpolates back), and the
 * answer never goes stale.
 */
export function useRouteHeights(route: SavedRoute | undefined): UseQueryResult<number[]> {
  return useQuery({
    queryKey: keys.routeHeights(route?.id ?? ''),
    enabled: !!route,
    staleTime: Infinity,
    queryFn: async (): Promise<number[]> => {
      const pts = decodeRoute(route!.polyline);
      if (pts.length < 2) return pts.length ? [0] : [];
      return valhalla.heights(pts);
    },
  });
}

function invalidateRoutes(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ['routes'] });
  qc.invalidateQueries({ queryKey: ['route'] });
}

export type SaveRouteInput = { name: string; candidate: Candidate; start: LatLng };

/** Keep a generated candidate. Returns the new route's id. */
export function useSaveRoute(): UseMutationResult<string, Error, SaveRouteInput> {
  const uid = useUserId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ name, candidate, start }: SaveRouteInput): Promise<string> => {
      if (!uid) throw new Error('Not signed in');
      const trimmed = name.trim();
      if (!trimmed) throw new Error('Give the route a name');
      if (candidate.pts.length < 2) throw new Error('The route has no shape to save');
      const bbox = bboxOf(candidate.pts)!;
      const row: TablesInsert<'routes'> = {
        user_id: uid,
        name: trimmed,
        polyline: polyline.encode(candidate.pts, 5),
        distance_m: candidate.distance_m,
        elev_gain_m: candidate.elev_gain_m,
        elev_loss_m: candidate.elev_loss_m,
        start_lat: start.lat,
        start_lng: start.lng,
        bbox: [...bbox],
        kind: candidate.kind,
        provider: ROUTING_PROVIDER,
        updated_at: new Date().toISOString(),
      };
      const { data, error } = await supabase.from('routes').insert(row).select('id').single();
      if (error) throw error;
      return data.id;
    },
    onSuccess: () => invalidateRoutes(qc),
  });
}

export function useDeleteRoute(): UseMutationResult<void, Error, string> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('routes').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: (_, id) => {
      invalidateRoutes(qc);
      qc.removeQueries({ queryKey: keys.routeHeights(id) });
    },
  });
}
