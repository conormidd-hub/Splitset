import polyline from '@mapbox/polyline';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { RUN_TYPES, isRun, type Activity } from './activities';
import { keys } from './keys';
import { bboxOf, decodeRoute, type Bbox } from '@/lib/geo';
import { buildTrack, type Samples, type Track } from '@/lib/runAnalysis';
import { bboxIntersects, expandBbox, matchSegment, type Effort, type SegmentDef } from '@/lib/segments';
import { useUserId } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import type { Json, Tables, TablesInsert } from '@/types/database';

/**
 * Segments and efforts: the Supabase side of Strava-style segments.
 *
 * Matching is pure TypeScript (`lib/segments.matchSegment`) over a run's `Track`
 * (`lib/runAnalysis.buildTrack`). This module owns everything around it: loading and caching
 * tracks, deciding which (segment, run) pairs still need a scan, persisting efforts and keeping
 * the per-segment watermark.
 *
 * Scan bookkeeping, as in the design brief: a run needs a scan for segment S when its
 * `activity_details.fetched_at` is newer than `S.scanned_through`. A FULL scan (`useScanSegment`,
 * `useScanAll`) processes those runs in fetched_at order and finally moves the watermark to the
 * newest fetched_at it saw. A PARTIAL scan (`useScanRun`, when a run detail opens) matches one run
 * against every segment whose watermark is older than that run and whose box overlaps it, writing
 * efforts but NOT moving the watermark, so the next full scan still covers runs in between.
 * Rescanning a pair always means: delete that pair's efforts, then insert the new set.
 *
 * Tracks are cached under `keys.track(activityId)` with `staleTime: Infinity`; `useTrack` and the
 * scans share that cache, so a run decoded for the detail screen is not decoded again by a scan.
 */

export type Segment = Tables<'segments'>;
export type SegmentEffort = Tables<'segment_efforts'>;
/** An effort with the run it belongs to, as `useSegmentEfforts` returns it. */
export type SegmentEffortWithActivity = SegmentEffort & {
  activities: Pick<Activity, 'name' | 'start_time_local'>;
};
/** An effort with its segment, as `useRunEfforts` returns it. */
export type RunEffort = SegmentEffort & { segments: Pick<Segment, 'id' | 'name' | 'distance_m'> };

export type ScanResult = { scanned: number; efforts: number };
export type ScanProgress = (done: number, total: number) => void;

/** activity_details rows are fetched in batches of this many ids (polylines plus samples are a few hundred KB each). */
/** Supabase caps a response at 1000 rows; effort lists are paged below that. */
const EFFORT_PAGE = 1000;
const TRACK_BATCH = 20;
/** Candidate-run listings are paged like `useRunRoutes`, well under the Supabase row cap. */
const LIST_PAGE = 500;
/**
 * Runs are pre-filtered by box before their tracks are loaded. The exact tolerance depends on the
 * run's point spacing (max(25 m, 1.2 x spacing), so ~30 m for a subsampled marathon); this margin
 * is generous and `matchSegment` re-applies the exact one.
 */
const PREFILTER_MARGIN_M = 50;
const EPOCH = '1970-01-01T00:00:00+00:00';
const TRACK_COLUMNS = 'activity_id, polyline, samples, fetched_at' as const;
const SCAN_COLUMNS = 'activity_id, bbox, fetched_at, activities!inner(type, start_time)' as const;

type TrackRow = { activity_id: string; polyline: string | null; samples: Json | null; fetched_at: string };
type ScanRow = {
  activity_id: string;
  bbox: number[] | null;
  fetched_at: string;
  activities: { type: string; start_time: string };
};

// ---------------------------------------------------------------- tracks

/** `activity_details.samples` is untyped JSON; accept it only when it has the shape `buildTrack` needs. */
function parseSamples(raw: Json | null | undefined): Samples | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  const t = s.t, d = s.d;
  if (!Array.isArray(t) || !Array.isArray(d) || t.length < 2 || t.length !== d.length) return null;
  const arr = (xs: unknown): (number | null)[] | null => (Array.isArray(xs) ? (xs as (number | null)[]) : null);
  return {
    t: t as number[],
    d: d as number[],
    hr: arr(s.hr),
    alt: arr(s.alt),
    cad: arr(s.cad),
    route_d: Array.isArray(s.route_d) ? (s.route_d as number[]) : null,
  };
}

function trackFromRow(row: TrackRow | null | undefined): Track | null {
  if (!row) return null;
  const pts = row.polyline ? decodeRoute(row.polyline) : [];
  return buildTrack(pts, parseSamples(row.samples));
}

async function fetchTrackRows(ids: string[]): Promise<Map<string, TrackRow>> {
  const out = new Map<string, TrackRow>();
  for (let i = 0; i < ids.length; i += TRACK_BATCH) {
    const batch = ids.slice(i, i + TRACK_BATCH);
    const { data, error } = await supabase.from('activity_details').select(TRACK_COLUMNS).in('activity_id', batch);
    if (error) throw error;
    for (const row of data as TrackRow[]) out.set(row.activity_id, row);
  }
  return out;
}

/** The decoded, metric-aligned track of one run; null when it has no details row or nothing to show. */
export function useTrack(activityId: string | undefined): UseQueryResult<Track | null> {
  return useQuery({
    queryKey: keys.track(activityId ?? ''),
    enabled: !!activityId,
    staleTime: Infinity,
    queryFn: async (): Promise<Track | null> => {
      const rows = await fetchTrackRows([activityId!]);
      return trackFromRow(rows.get(activityId!));
    },
  });
}

/**
 * Tracks for many runs, through the same cache `useTrack` uses. Ids already in the cache are not
 * fetched again; the rest are read from activity_details in batches of 20 and handed to
 * `queryClient.fetchQuery` under `keys.track(id)`, so a later `useTrack` (or scan) finds them.
 * Missing or undecodable runs map to null.
 */
export async function loadTracks(queryClient: QueryClient, ids: string[]): Promise<Map<string, Track | null>> {
  const out = new Map<string, Track | null>();
  const missing: string[] = [];
  for (const id of ids) {
    const cached = queryClient.getQueryData<Track | null>(keys.track(id));
    if (cached !== undefined) out.set(id, cached);
    else missing.push(id);
  }
  for (let i = 0; i < missing.length; i += TRACK_BATCH) {
    const batch = missing.slice(i, i + TRACK_BATCH);
    const rows = await fetchTrackRows(batch);
    for (const id of batch) {
      const track = await queryClient.fetchQuery({
        queryKey: keys.track(id),
        staleTime: Infinity,
        // scans touch hundreds of tracks; let the ones nobody is viewing go soon after
        gcTime: 60_000,
        queryFn: async (): Promise<Track | null> => trackFromRow(rows.get(id)),
      });
      out.set(id, track);
    }
  }
  return out;
}

// ---------------------------------------------------------------- queries

export function useSegments(): UseQueryResult<Segment[]> {
  const uid = useUserId();
  return useQuery({
    queryKey: keys.segments(uid),
    enabled: !!uid,
    queryFn: async (): Promise<Segment[]> => {
      const { data, error } = await supabase.from('segments').select('*').eq('user_id', uid).order('name');
      if (error) throw error;
      return data;
    },
  });
}

export function useSegment(id: string | undefined): UseQueryResult<Segment> {
  return useQuery({
    queryKey: keys.segment(id ?? ''),
    enabled: !!id,
    queryFn: async (): Promise<Segment> => {
      const { data, error } = await supabase.from('segments').select('*').eq('id', id!).single();
      if (error) throw error;
      return data;
    },
  });
}

/** Every effort on one segment with its run's name and local start, oldest first (history order). */
export function useSegmentEfforts(segmentId: string | undefined): UseQueryResult<SegmentEffortWithActivity[]> {
  return useQuery({
    queryKey: keys.segmentEfforts(segmentId ?? ''),
    enabled: !!segmentId,
    queryFn: async (): Promise<SegmentEffortWithActivity[]> => {
      const out: SegmentEffortWithActivity[] = [];
      for (let from = 0; ; from += EFFORT_PAGE) {
        const { data, error } = await supabase
          .from('segment_efforts')
          .select('*, activities(name, start_time_local)')
          .eq('segment_id', segmentId!)
          .order('started_at', { ascending: true, nullsFirst: false })
          .order('id')
          .range(from, from + EFFORT_PAGE - 1);
        if (error) throw error;
        out.push(...(data as unknown as SegmentEffortWithActivity[]));
        if (data.length < EFFORT_PAGE) break;
      }
      return out;
    },
  });
}

/** This run's efforts with the segment each belongs to, in run order. */
export function useRunEfforts(activityId: string | undefined): UseQueryResult<RunEffort[]> {
  return useQuery({
    queryKey: keys.runEfforts(activityId ?? ''),
    enabled: !!activityId,
    queryFn: async (): Promise<RunEffort[]> => {
      const { data, error } = await supabase
        .from('segment_efforts')
        .select('*, segments(id, name, distance_m)')
        .eq('activity_id', activityId!)
        .order('start_idx');
      if (error) throw error;
      return data as unknown as RunEffort[];
    },
  });
}

/** All of the user's efforts, for ranking a run's efforts against their best on each segment. */
export function useAllEfforts(): UseQueryResult<SegmentEffort[]> {
  const uid = useUserId();
  return useQuery({
    queryKey: keys.allEfforts(uid),
    enabled: !!uid,
    queryFn: async (): Promise<SegmentEffort[]> => {
      // Paged past the 1000-row cap with a total order, so no segment's efforts are silently dropped.
      const out: SegmentEffort[] = [];
      for (let from = 0; ; from += EFFORT_PAGE) {
        const { data, error } = await supabase
          .from('segment_efforts')
          .select('*')
          .eq('user_id', uid)
          .order('segment_id')
          .order('elapsed_s')
          .order('id')
          .range(from, from + EFFORT_PAGE - 1);
        if (error) throw error;
        out.push(...data);
        if (data.length < EFFORT_PAGE) break;
      }
      return out;
    },
  });
}

// ---------------------------------------------------------------- helpers shared by the mutations

function invalidateSegments(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ['segments'] });
  qc.invalidateQueries({ queryKey: ['segment'] });
}

function invalidateEfforts(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ['segmentEfforts'] });
  qc.invalidateQueries({ queryKey: ['runEfforts'] });
  qc.invalidateQueries({ queryKey: ['allEfforts'] });
}

function asBbox(b: number[] | null | undefined, pts: [number, number][]): Bbox {
  if (b && b.length === 4) return [b[0], b[1], b[2], b[3]];
  return bboxOf(pts) ?? [0, 0, 0, 0];
}

function segmentDef(seg: Segment): SegmentDef {
  const pts = decodeRoute(seg.polyline);
  return { id: seg.id, pts, distance_m: seg.distance_m, bbox: asBbox(seg.bbox, pts) };
}

/** Wall-clock start of an effort: the activity's start plus the matched offset in seconds. */
function startedAtIso(activityStart: string, startedAtS: number): string | null {
  const ms = Date.parse(activityStart);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + startedAtS * 1000).toISOString();
}

function effortRow(uid: string, segmentId: string, run: ScanRow, e: Effort): TablesInsert<'segment_efforts'> {
  return {
    user_id: uid,
    segment_id: segmentId,
    activity_id: run.activity_id,
    elapsed_s: e.elapsed_s,
    start_idx: e.start_idx,
    end_idx: e.end_idx,
    started_at: startedAtIso(run.activities.start_time, e.started_at_s),
  };
}

/**
 * Rescan outcome for a set of (segment, run) pairs: delete the pairs' efforts, then insert the new
 * ones, in that order. Called with the pairs of one batch so a full scan costs two round trips per
 * twenty runs instead of two per run.
 */
async function replaceEfforts(
  pairs: { segmentIds: string[]; activityIds: string[] },
  rows: TablesInsert<'segment_efforts'>[],
): Promise<void> {
  if (!pairs.segmentIds.length || !pairs.activityIds.length) return;
  const del = await supabase
    .from('segment_efforts')
    .delete()
    .in('segment_id', pairs.segmentIds)
    .in('activity_id', pairs.activityIds);
  if (del.error) throw del.error;
  if (!rows.length) return;
  // A partial scan (opening a run) can rescan the same pair while a full scan is running; both
  // compute the same rows, so a duplicate from the other writer is simply kept.
  const ins = await supabase.from('segment_efforts').upsert(rows, { onConflict: 'segment_id,activity_id,start_idx', ignoreDuplicates: true });
  if (ins.error) throw ins.error;
}

/** Let the UI paint a progress line between batches. */
const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function fetchSegment(id: string): Promise<Segment> {
  const { data, error } = await supabase.from('segments').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

async function fetchSegments(uid: string): Promise<Segment[]> {
  const { data, error } = await supabase.from('segments').select('*').eq('user_id', uid).order('name');
  if (error) throw error;
  return data;
}

/**
 * Run-type details rows with a polyline fetched after `since`, oldest fetched first. This is the
 * "needs a scan" set for a segment whose watermark is `since`; the newest row's fetched_at becomes
 * the next watermark once they are processed.
 */
async function runsFetchedAfter(uid: string, since: string): Promise<ScanRow[]> {
  const out: ScanRow[] = [];
  for (let from = 0; ; from += LIST_PAGE) {
    const { data, error } = await supabase
      .from('activity_details')
      .select(SCAN_COLUMNS)
      .eq('user_id', uid)
      .not('polyline', 'is', null)
      .in('activities.type', RUN_TYPES)
      .gt('fetched_at', since)
      .order('fetched_at')
      .order('activity_id')
      .range(from, from + LIST_PAGE - 1);
    if (error) throw error;
    out.push(...(data as unknown as ScanRow[]));
    if (data.length < LIST_PAGE) break;
  }
  return out;
}

type ScanPlan = {
  seg: Segment;
  def: SegmentDef;
  /** Runs whose box overlaps the segment's; only these are loaded and matched. */
  candidates: ScanRow[];
  /** fetched_at of the newest run needing a scan (box-rejected ones included); null when none. */
  watermark: string | null;
};

async function planFullScan(uid: string, seg: Segment): Promise<ScanPlan> {
  const def = segmentDef(seg);
  const rows = await runsFetchedAfter(uid, seg.scanned_through);
  const box = expandBbox(def.bbox, PREFILTER_MARGIN_M);
  const candidates = rows.filter((r) => !r.bbox || r.bbox.length !== 4 || bboxIntersects(r.bbox as Bbox, box));
  return { seg, def, candidates, watermark: rows.length ? rows[rows.length - 1].fetched_at : null };
}

/**
 * Match every candidate run of a plan, batch by batch, persist the efforts and move the segment's
 * watermark. `onDone` is called after each run (with the running count) so callers can report
 * progress against a total they know.
 */
async function runFullScan(qc: QueryClient, uid: string, plan: ScanPlan, onDone: (count: number) => void): Promise<ScanResult> {
  let done = 0, efforts = 0;
  for (let i = 0; i < plan.candidates.length; i += TRACK_BATCH) {
    const batch = plan.candidates.slice(i, i + TRACK_BATCH);
    const tracks = await loadTracks(qc, batch.map((r) => r.activity_id));
    const rows: TablesInsert<'segment_efforts'>[] = [];
    for (const run of batch) {
      const track = tracks.get(run.activity_id);
      if (track) for (const e of matchSegment(plan.def, track)) rows.push(effortRow(uid, plan.seg.id, run, e));
      onDone(++done);
    }
    await replaceEfforts({ segmentIds: [plan.seg.id], activityIds: batch.map((r) => r.activity_id) }, rows);
    efforts += rows.length;
    await nextTick();
  }
  if (plan.watermark) {
    const { error } = await supabase
      .from('segments')
      .update({ scanned_through: plan.watermark, updated_at: new Date().toISOString() })
      .eq('id', plan.seg.id);
    if (error) throw error;
  }
  return { scanned: plan.candidates.length, efforts };
}

// ---------------------------------------------------------------- mutations

export type SaveSegmentInput = {
  id?: string;
  name: string;
  pts: [number, number][];
  distance_m: number;
  source_activity_id?: string | null;
};

/**
 * Create a segment from a stretch of a run, or update one. Geometry (polyline at precision 5, box,
 * start and end) is derived from `pts`. Updating with a changed polyline invalidates every effort
 * on the segment, so they are deleted and the watermark reset to the epoch; the caller then runs a
 * full scan. Returns the segment id.
 */
export function useSaveSegment(): UseMutationResult<string, Error, SaveSegmentInput> {
  const uid = useUserId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SaveSegmentInput): Promise<string> => {
      if (!uid) throw new Error('Not signed in');
      const name = input.name.trim();
      if (!name) throw new Error('Give the segment a name');
      if (input.pts.length < 2) throw new Error('A segment needs at least two points');
      const encoded = polyline.encode(input.pts, 5);
      const bbox = bboxOf(input.pts)!;
      const [startLat, startLng] = input.pts[0];
      const [endLat, endLng] = input.pts[input.pts.length - 1];
      const geometry = {
        polyline: encoded,
        distance_m: input.distance_m,
        start_lat: startLat,
        start_lng: startLng,
        end_lat: endLat,
        end_lng: endLng,
        bbox: [...bbox],
      };
      const updated_at = new Date().toISOString();
      if (input.id) {
        const { data: current, error: readErr } = await supabase
          .from('segments')
          .select('polyline')
          .eq('id', input.id)
          .single();
        if (readErr) throw readErr;
        const changed = current.polyline !== encoded;
        const patch = changed
          ? { ...geometry, name, updated_at, scanned_through: EPOCH }
          : { ...geometry, name, updated_at };
        const { error } = await supabase.from('segments').update(patch).eq('id', input.id);
        if (error) throw error;
        if (changed) {
          const { error: delErr } = await supabase.from('segment_efforts').delete().eq('segment_id', input.id);
          if (delErr) throw delErr;
        }
        return input.id;
      }
      const row: TablesInsert<'segments'> = {
        ...geometry,
        user_id: uid,
        name,
        source_activity_id: input.source_activity_id ?? null,
        updated_at,
      };
      const { data, error } = await supabase.from('segments').insert(row).select('id').single();
      if (error) throw error;
      return data.id;
    },
    onSuccess: () => {
      invalidateSegments(qc);
      invalidateEfforts(qc);
    },
  });
}

/** Delete a segment; its efforts go with it (cascade). */
export function useDeleteSegment(): UseMutationResult<void, Error, string> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('segments').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidateSegments(qc);
      invalidateEfforts(qc);
    },
  });
}

/**
 * Full scan of one segment: every run fetched since its watermark, in fetched_at order, then the
 * watermark moves. `onProgress(done, total)` counts the runs whose box overlaps the segment (the
 * ones actually matched); it is called with (0, total) before the first track loads.
 */
export function useScanSegment(): UseMutationResult<ScanResult, Error, { segmentId: string; onProgress?: ScanProgress }> {
  const uid = useUserId();
  const qc = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: async ({ segmentId, onProgress }): Promise<ScanResult> => {
      if (!uid) throw new Error('Not signed in');
      const seg = await fetchSegment(segmentId);
      const plan = await planFullScan(uid, seg);
      const total = plan.candidates.length;
      onProgress?.(0, total);
      return runFullScan(qc, uid, plan, (done) => onProgress?.(done, total));
    },
    onSettled: () => {
      invalidateSegments(qc);
      invalidateEfforts(qc);
    },
  });
}

/**
 * Full scan of every segment ("Scan new runs"). Plans all segments first so `onProgress` counts
 * against one total; a run shared by several segments is decoded once thanks to the track cache.
 */
export function useScanAll(): UseMutationResult<ScanResult, Error, { onProgress?: ScanProgress } | void> {
  const uid = useUserId();
  const qc = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: async (input): Promise<ScanResult> => {
      if (!uid) throw new Error('Not signed in');
      const onProgress = input?.onProgress;
      const segments = await fetchSegments(uid);
      const plans: ScanPlan[] = [];
      for (const seg of segments) plans.push(await planFullScan(uid, seg));
      const total = plans.reduce((n, p) => n + p.candidates.length, 0);
      onProgress?.(0, total);
      let offset = 0, scanned = 0, efforts = 0;
      for (const plan of plans) {
        const result = await runFullScan(qc, uid, plan, (done) => onProgress?.(offset + done, total));
        offset += plan.candidates.length;
        scanned += result.scanned;
        efforts += result.efforts;
      }
      return { scanned, efforts };
    },
    onSettled: () => {
      invalidateSegments(qc);
      invalidateEfforts(qc);
    },
  });
}

/**
 * Partial scan of one run against every segment whose watermark is older than the run's details
 * and whose box overlaps it. Writes efforts for those pairs; never moves a watermark. Returns the
 * number of efforts written (0 when nothing needed scanning).
 */
export function useScanRun(): UseMutationResult<{ efforts: number }, Error, { activityId: string }> {
  const uid = useUserId();
  const qc = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: async ({ activityId }): Promise<{ efforts: number }> => {
      if (!uid) throw new Error('Not signed in');
      const { data: meta, error: metaErr } = await supabase
        .from('activity_details')
        .select(SCAN_COLUMNS)
        .eq('activity_id', activityId)
        .not('polyline', 'is', null)
        .maybeSingle();
      if (metaErr) throw metaErr;
      const run = meta as unknown as ScanRow | null;
      if (!run || !isRun(run.activities.type)) return { efforts: 0 };

      const { data: segs, error: segErr } = await supabase
        .from('segments')
        .select('*')
        .eq('user_id', uid)
        .lt('scanned_through', run.fetched_at);
      if (segErr) throw segErr;
      const runBox = run.bbox && run.bbox.length === 4 ? (run.bbox as Bbox) : null;
      const defs = segs
        .map(segmentDef)
        .filter((d) => !runBox || bboxIntersects(runBox, expandBbox(d.bbox, PREFILTER_MARGIN_M)));
      if (!defs.length) return { efforts: 0 };

      const track = (await loadTracks(qc, [activityId])).get(activityId);
      if (!track) return { efforts: 0 };
      const rows: TablesInsert<'segment_efforts'>[] = [];
      for (const def of defs) for (const e of matchSegment(def, track)) rows.push(effortRow(uid, def.id, run, e));
      await replaceEfforts({ segmentIds: defs.map((d) => d.id), activityIds: [activityId] }, rows);
      // Only here did anything change (a rescan may also have removed stale efforts), so invalidate
      // here rather than in onSuccess, which cannot tell a no-op from a scan that found nothing.
      invalidateEfforts(qc);
      return { efforts: rows.length };
    },
  });
}
