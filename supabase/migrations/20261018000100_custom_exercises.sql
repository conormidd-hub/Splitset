-- Splitset recovery map, phase 8: saving a custom exercise in one transaction.
--
-- create_custom_exercise(p)       inserts the caller's exercise, its muscles by role and, if given,
--                                 its known best (manual_pbs). Returns the exercise's id.
-- update_custom_exercise(id, p)   updates one of the caller's exercises and replaces its muscles.
--                                 How its sets are logged (measure) never changes, so sets already
--                                 logged keep their meaning. The app then runs the recompute rule.
--
-- p: { "exercise": { name, slug, group, equipment, measure, is_bodyweight, is_unilateral,
--                    muscle_group, load_mode, bw_factor, fatigue, pb_estimate_from,
--                    pb_estimate_ratio, load_split },
--      "muscles":  [{ muscle_id, role }],
--      "best":     { weight_kg, reps, e1rm, dated_at } | null }
--
-- Every number is worked out in the app (src/lib/recovery/customExercise.ts). Both functions are
-- security invoker, so RLS decides what the caller may write; the existing table checks still
-- apply (custom_ slugs only, a load mode and fatigue class with a slug, the bodyweight factor's
-- pairing, the PB-estimate pair). They refuse an exercise with no primary muscle. The role caps
-- stay app-side, as phase 1 decided, so no constant is copied into SQL.

create or replace function public.create_custom_exercise(p jsonb)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  e      jsonb := p -> 'exercise';
  new_id uuid;
begin
  if not exists (select 1 from jsonb_array_elements(coalesce(p -> 'muscles', '[]')) m where m ->> 'role' = 'primary') then
    raise exception 'a custom exercise needs at least one primary muscle';
  end if;

  insert into public.exercises (owner_id, name, slug, "group", equipment, measure, is_bodyweight, is_unilateral, muscle_group,
                                load_mode, bw_factor, fatigue, pb_estimate_from, pb_estimate_ratio, load_split)
  values ((select auth.uid()), e ->> 'name', e ->> 'slug', e ->> 'group', e ->> 'equipment', e ->> 'measure',
          (e ->> 'is_bodyweight')::boolean, (e ->> 'is_unilateral')::boolean, e ->> 'muscle_group', e ->> 'load_mode',
          (e ->> 'bw_factor')::double precision, e ->> 'fatigue', e ->> 'pb_estimate_from',
          (e ->> 'pb_estimate_ratio')::double precision, e -> 'load_split')
  returning id into new_id;

  insert into public.exercise_muscles (exercise_id, muscle_id, role)
  select new_id, m ->> 'muscle_id', m ->> 'role' from jsonb_array_elements(p -> 'muscles') m;

  if jsonb_typeof(p -> 'best') = 'object' then
    insert into public.manual_pbs (user_id, exercise_id, weight_kg, reps, e1rm, dated_at)
    values ((select auth.uid()), new_id, (p -> 'best' ->> 'weight_kg')::real, (p -> 'best' ->> 'reps')::integer,
            (p -> 'best' ->> 'e1rm')::double precision, (p -> 'best' ->> 'dated_at')::date);
  end if;
  return new_id;
end;
$$;

create or replace function public.update_custom_exercise(p_id uuid, p jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  e jsonb := p -> 'exercise';
begin
  if not exists (select 1 from jsonb_array_elements(coalesce(p -> 'muscles', '[]')) m where m ->> 'role' = 'primary') then
    raise exception 'a custom exercise needs at least one primary muscle';
  end if;

  update public.exercises
     set name = e ->> 'name', slug = coalesce(slug, e ->> 'slug'), "group" = e ->> 'group', equipment = e ->> 'equipment',
         is_bodyweight = (e ->> 'is_bodyweight')::boolean, is_unilateral = (e ->> 'is_unilateral')::boolean,
         muscle_group = e ->> 'muscle_group', load_mode = e ->> 'load_mode', bw_factor = (e ->> 'bw_factor')::double precision,
         fatigue = e ->> 'fatigue', pb_estimate_from = e ->> 'pb_estimate_from',
         pb_estimate_ratio = (e ->> 'pb_estimate_ratio')::double precision, load_split = e -> 'load_split',
         updated_at = greatest(updated_at, now())
   where id = p_id and owner_id = (select auth.uid());
  if not found then
    raise exception 'exercise % not found', p_id;
  end if;

  delete from public.exercise_muscles where exercise_id = p_id;
  insert into public.exercise_muscles (exercise_id, muscle_id, role)
  select p_id, m ->> 'muscle_id', m ->> 'role' from jsonb_array_elements(p -> 'muscles') m;
end;
$$;

revoke all on function public.create_custom_exercise(jsonb) from public, anon;
revoke all on function public.update_custom_exercise(uuid, jsonb) from public, anon;
grant execute on function public.create_custom_exercise(jsonb) to authenticated;
grant execute on function public.update_custom_exercise(uuid, jsonb) to authenticated;
