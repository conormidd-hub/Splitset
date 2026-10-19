-- Splitset Lift tab and workout screen updates (after the recovery map review).
--
-- routine_groups      folders the user makes for their routines ("PPL", "Upper/Lower"), in order;
--                     routines.group_id puts a routine in one (null: "My routines"), and
--                     routines.position orders it within its group
-- exercise_notes      a note on an exercise that shows in every workout with it, whatever the
--                     template (template-only notes stay in routine_exercises.notes, and notes for
--                     one workout in workout_exercises.notes)
-- profiles            rest_timer_on: whether a new workout starts with the rest timer on (off by
--                     default); rest_seconds: its default length

create table public.routine_groups (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  name       text not null check (length(btrim(name)) between 1 and 60),
  position   integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index routine_groups_user_idx on public.routine_groups (user_id, position);

alter table public.routines
  add column group_id uuid references public.routine_groups (id) on delete set null;

create table public.exercise_notes (
  user_id     uuid not null references public.profiles (id) on delete cascade,
  exercise_id uuid not null references public.exercises (id) on delete cascade,
  note        text not null check (length(note) <= 2000),
  updated_at  timestamptz not null default now(),
  primary key (user_id, exercise_id)
);

do $$
declare
  t text;
begin
  foreach t in array array['routine_groups', 'exercise_notes'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I on public.%I for all to authenticated '
      'using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))',
      t || '_own', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format(
      'create trigger %I before insert or update on public.%I for each row execute function public.lww_guard()',
      t || '_lww', t);
  end loop;
end;
$$;

alter table public.profiles
  add column rest_timer_on boolean not null default false,
  add column rest_seconds  integer not null default 90 check (rest_seconds between 15 and 600);

grant update (rest_timer_on, rest_seconds) on public.profiles to authenticated;
