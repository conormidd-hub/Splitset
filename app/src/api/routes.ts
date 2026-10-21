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
import { parseWaypoints, type Waypoint } from '@/lib/courseBuilder';
import { bboxOf, decodeRoute } from '@/lib/geo';
import { useUserId } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import type { Tables, TablesInsert, TablesUpdate } from '@/types/database';

/**
 * Saved routes: generated with `lib/routeBuilder` (a loop or point to point by target distance)
 * or drawn point by point with `lib/courseBuilder`, and kept.
 *
 * A route row stores the routed shape as a precision-5 Google polyline (the same encoding as
 * activity_details.polyline, so `decodeRoute` reads both), its distance, climb and descent, the
 * start, its box and how it was made. A drawn course also keeps the waypoints the user placed,
 * so it opens in the builder again. Terrain heights are not stored: `useRouteHeights` asks
 * Valhalla once per session and caches the answer for as long as the app runs.
 */

export type SavedRoute = Tables<'routes'>;
export type RouteKind = 'loop' | 'point_to_point' | 'drawn';

/** "Loop", "Point to point", "Drawn course"; `short` gives the badge-sized "A to B" and "Drawn". */
export function kindLabel(kind: string, short = false): string {
  if (kind === 'loop') return 'Loop';
  if (kind === 'drawn') return short ? 'Drawn' : 'Drawn course';
  return short ? 'A to B' : 'Point to point';
}

/** The waypoints of a drawn course, or null for a generated route (or a stored value that cannot be read). */
export function routeWaypoints(route: SavedRoute | undefined | null): Waypoint[] | null {
  return route?.kind === 'drawn' ? parseWaypoints(route.waypoints) : null;
}

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

/** What a route is made of, from either builder. */
export type RouteShape = {
  pts: [number, number][];
  distance_m: number;
  elev_gain_m: number;
  elev_loss_m: number;
  kind: RouteKind;
  /** The points placed in the course builder; null for a generated route. */
  waypoints: Waypoint[] | null;
};
export type SaveRouteInput = RouteShape & { name: string };
export type UpdateRouteInput = SaveRouteInput & { id: string };

/** The columns a save and an update both write. The start is the shape's first point. */
function columnsFor(input: SaveRouteInput): Omit<TablesInsert<'routes'>, 'user_id'> {
  const name = input.name.trim();
  if (!name) throw new Error('Give the route a name');
  if (input.pts.length < 2) throw new Error('The route has no shape to save');
  const bbox = bboxOf(input.pts)!;
  return {
    name,
    polyline: polyline.encode(input.pts, 5),
    distance_m: input.distance_m,
    elev_gain_m: input.elev_gain_m,
    elev_loss_m: input.elev_loss_m,
    start_lat: input.pts[0][0],
    start_lng: input.pts[0][1],
    bbox: [...bbox],
    kind: input.kind,
    waypoints: input.waypoints,
    provider: ROUTING_PROVIDER,
    updated_at: new Date().toISOString(),
  };
}

/** Keep a generated candidate or a drawn course. Returns the new route's id. */
export function useSaveRoute(): UseMutationResult<string, Error, SaveRouteInput> {
  const uid = useUserId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SaveRouteInput): Promise<string> => {
      if (!uid) throw new Error('Not signed in');
      const row: TablesInsert<'routes'> = { user_id: uid, ...columnsFor(input) };
      const { data, error } = await supabase.from('routes').insert(row).select('id').single();
      if (error) throw error;
      return data.id;
    },
    onSuccess: () => invalidateRoutes(qc),
  });
}

/** Replace a saved route's name and shape: a course changed in the builder. Returns its id. */
export function useUpdateRoute(): UseMutationResult<string, Error, UpdateRouteInput> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...input }: UpdateRouteInput): Promise<string> => {
      const row: TablesUpdate<'routes'> = columnsFor(input);
      const { error } = await supabase.from('routes').update(row).eq('id', id);
      if (error) throw error;
      return id;
    },
    onSuccess: (id) => {
      invalidateRoutes(qc);
      // the shape changed, so the heights along it did too
      qc.removeQueries({ queryKey: keys.routeHeights(id) });
    },
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
