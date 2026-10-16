-- Splitset recovery map, phase 1: the muscles, the exercise library and per-user thresholds.
--
-- muscles           the 17 muscle IDs of docs/load-model-spec.md §2; global and read-only
-- exercises         gains the library columns (slug, group, load mode, fatigue, PB estimate, load split)
-- exercise_muscles  which muscles an exercise loads, by role (primary | secondary | tertiary)
-- user_thresholds   per-user overrides of data/recovery_constants.json, by dotted key
--
-- supabase/seed_library.py fills muscles, the library columns and exercise_muscles from
-- data/exercise_library.json. Nothing here holds a tunable number: recovery hours, role weights
-- and role caps live in data/recovery_constants.json only, so the caps are enforced by the seed
-- loader and the custom-exercise flow rather than by a constraint. The library's existing
-- columns map as docs/recovery-map-integration-notes.md §3 says: unilateral = is_unilateral,
-- log_as = measure, note = instructions, is_custom = (owner_id is not null).

-- ---------------------------------------------------------------- muscles

create table public.muscles (
  id      text primary key,          -- chest | traps | lats | ... (spec §2, used exactly everywhere)
  "group" text not null,             -- Chest | Back | Shoulders | Arms | Core | Legs
  name    text not null,
  views   text[] not null
          check (cardinality(views) > 0 and views <@ array['front', 'back']::text[])
);

comment on table public.muscles is 'The 17 muscles of the recovery map. Seeded from data/exercise_library.json; recovery hours come from constants, not from here.';

alter table public.muscles enable row level security;
create policy muscles_select on public.muscles for select to authenticated using (true);
revoke all on public.muscles from anon, authenticated;
grant select on public.muscles to authenticated;

-- ---------------------------------------------------------------- library columns on exercises

-- slug is unique where set (nulls are distinct), which also lets pb_estimate_from reference it.
-- A user's own exercise may only carry a custom_ slug, so nobody can claim a library slug
-- before the seed loader does.
alter table public.exercises
  add column slug text unique
    check (slug ~ '^[a-z0-9_-]+$'),
  add column "group" text
    check ("group" in ('Chest', 'Back', 'Shoulders', 'Arms', 'Legs', 'Core', 'Full body')),
  add column load_mode text
    check (load_mode in ('weight', 'bodyweight', 'assisted', 'fixed')),
  add column bw_factor double precision
    check (bw_factor > 0 and bw_factor <= 1),
  add column fatigue text
    check (fatigue in ('low', 'standard', 'high')),
  add column load_split jsonb
    check (jsonb_typeof(load_split) = 'object'),
  add constraint exercises_custom_slug
    check (owner_id is null or slug is null or slug like 'custom\_%'),
  add constraint exercises_bw_factor_mode
    check (case when load_mode is null then bw_factor is null
                else (load_mode in ('bodyweight', 'assisted')) = (bw_factor is not null) end),
  add constraint exercises_scored_complete
    check (slug is null or (load_mode is not null and fatigue is not null));

-- Deferred, so the loader can write exercises in file order even when one estimates from a
-- later one (deadlift from squat_bb).
alter table public.exercises
  add column pb_estimate_from text
    references public.exercises (slug) on update cascade on delete set null
    deferrable initially deferred,
  add column pb_estimate_ratio double precision
    check (pb_estimate_ratio > 0),
  add constraint exercises_pb_estimate_pair
    check (pb_estimate_from is null or pb_estimate_ratio is not null);

comment on column public.exercises.slug is 'Library slug (data/exercise_library.json), or custom_<uuid> for a user''s own scored exercise. Null = not scored.';
comment on column public.exercises."group" is 'Library group, for the picker filters. muscle_group keeps the older, finer vocabulary.';

-- ---------------------------------------------------------------- exercise_muscles

create table public.exercise_muscles (
  exercise_id uuid not null references public.exercises (id) on delete cascade,
  muscle_id   text not null references public.muscles (id),
  role        text not null check (role in ('primary', 'secondary', 'tertiary')),
  primary key (exercise_id, muscle_id)
);
create index exercise_muscles_muscle_idx on public.exercise_muscles (muscle_id, role);

comment on table public.exercise_muscles is 'Muscles an exercise loads, by role. Global exercises are seeded; users map their own.';

alter table public.exercise_muscles enable row level security;

create policy exercise_muscles_select on public.exercise_muscles
  for select to authenticated
  using (exists (select 1 from public.exercises e
                  where e.id = exercise_id and (e.owner_id is null or e.owner_id = (select auth.uid()))));
create policy exercise_muscles_insert_own on public.exercise_muscles
  for insert to authenticated
  with check (exists (select 1 from public.exercises e
                       where e.id = exercise_id and e.owner_id = (select auth.uid())));
create policy exercise_muscles_update_own on public.exercise_muscles
  for update to authenticated
  using (exists (select 1 from public.exercises e
                  where e.id = exercise_id and e.owner_id = (select auth.uid())))
  with check (exists (select 1 from public.exercises e
                       where e.id = exercise_id and e.owner_id = (select auth.uid())));
create policy exercise_muscles_delete_own on public.exercise_muscles
  for delete to authenticated
  using (exists (select 1 from public.exercises e
                  where e.id = exercise_id and e.owner_id = (select auth.uid())));

revoke all on public.exercise_muscles from anon, authenticated;
grant select, insert, update, delete on public.exercise_muscles to authenticated;

-- ---------------------------------------------------------------- user_thresholds

-- key is a dotted path into data/recovery_constants.json (pb.manual_policy,
-- base_recovery_hours.default, levels.3.min). The app validates keys and value types; the
-- database only checks the shape of the key.
create table public.user_thresholds (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  key        text not null check (key ~ '^[a-z_]+(\.[a-z0-9_]+)*$'),
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

comment on table public.user_thresholds is 'Per-user overrides of data/recovery_constants.json, by dotted key.';

alter table public.user_thresholds enable row level security;
create policy user_thresholds_own on public.user_thresholds
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on public.user_thresholds from anon, authenticated;
grant select, insert, update, delete on public.user_thresholds to authenticated;

create trigger user_thresholds_lww before insert or update on public.user_thresholds
  for each row execute function public.lww_guard();
