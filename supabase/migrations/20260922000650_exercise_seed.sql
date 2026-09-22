-- Splitset M5: the shared exercise library. Idempotent: re-running adds only what is missing,
-- and never touches a user's own exercises (owner_id is null on every row here).
--
-- Columns: name, muscle_group, equipment, measure, is_bodyweight, is_unilateral

insert into public.exercises (name, muscle_group, equipment, measure, is_bodyweight, is_unilateral)
values
  -- quads
  ('Back squat',                 'quads',      'barbell',    'weight_reps',       false, false),
  ('Front squat',                'quads',      'barbell',    'weight_reps',       false, false),
  ('Goblet squat',               'quads',      'dumbbell',   'weight_reps',       false, false),
  ('Leg press',                  'quads',      'machine',    'weight_reps',       false, false),
  ('Hack squat',                 'quads',      'machine',    'weight_reps',       false, false),
  ('Bulgarian split squat',      'quads',      'dumbbell',   'weight_reps',       false, true),
  ('Walking lunge',              'quads',      'dumbbell',   'weight_reps',       false, true),
  ('Reverse lunge',              'quads',      'dumbbell',   'weight_reps',       false, true),
  ('Step-up',                    'quads',      'dumbbell',   'weight_reps',       false, true),
  ('Leg extension',              'quads',      'machine',    'weight_reps',       false, false),
  -- hamstrings and glutes
  ('Deadlift',                   'hamstrings', 'barbell',    'weight_reps',       false, false),
  ('Trap bar deadlift',          'hamstrings', 'other',      'weight_reps',       false, false),
  ('Romanian deadlift',          'hamstrings', 'barbell',    'weight_reps',       false, false),
  ('Dumbbell Romanian deadlift', 'hamstrings', 'dumbbell',   'weight_reps',       false, false),
  ('Single-leg Romanian deadlift','hamstrings','dumbbell',   'weight_reps',       false, true),
  ('B-stance Romanian deadlift', 'hamstrings', 'dumbbell',   'weight_reps',       false, true),
  ('Leg curl',                   'hamstrings', 'machine',    'weight_reps',       false, false),
  ('Nordic hamstring curl',      'hamstrings', 'bodyweight', 'reps',              true,  false),
  ('Hip thrust',                 'glutes',     'barbell',    'weight_reps',       false, false),
  ('Glute bridge',               'glutes',     'bodyweight', 'reps',              true,  false),
  ('Single-leg glute bridge',    'glutes',     'bodyweight', 'reps',              true,  true),
  ('Kettlebell swing',           'glutes',     'kettlebell', 'weight_reps',       false, false),
  ('Banded lateral walk',        'glutes',     'band',       'reps',              true,  false),
  ('Cable kickback',             'glutes',     'cable',      'weight_reps',       false, true),
  -- calves and feet
  ('Standing calf raise',        'calves',     'machine',    'weight_reps',       false, false),
  ('Seated calf raise',          'calves',     'machine',    'weight_reps',       false, false),
  ('Single-leg calf raise',      'calves',     'bodyweight', 'weight_reps',       true,  true),
  ('Bent-knee calf raise',       'calves',     'bodyweight', 'weight_reps',       true,  true),
  ('Tibialis raise',             'calves',     'bodyweight', 'reps',              true,  false),
  -- chest
  ('Bench press',                'chest',      'barbell',    'weight_reps',       false, false),
  ('Incline bench press',        'chest',      'barbell',    'weight_reps',       false, false),
  ('Dumbbell bench press',       'chest',      'dumbbell',   'weight_reps',       false, false),
  ('Incline dumbbell press',     'chest',      'dumbbell',   'weight_reps',       false, false),
  ('Push-up',                    'chest',      'bodyweight', 'reps',              true,  false),
  ('Chest fly',                  'chest',      'cable',      'weight_reps',       false, false),
  ('Dip',                        'chest',      'bodyweight', 'weight_reps',       true,  false),
  -- back
  ('Pull-up',                    'back',       'bodyweight', 'weight_reps',       true,  false),
  ('Chin-up',                    'back',       'bodyweight', 'weight_reps',       true,  false),
  ('Lat pulldown',               'back',       'cable',      'weight_reps',       false, false),
  ('Barbell row',                'back',       'barbell',    'weight_reps',       false, false),
  ('Dumbbell row',               'back',       'dumbbell',   'weight_reps',       false, true),
  ('Seated cable row',           'back',       'cable',      'weight_reps',       false, false),
  ('Chest-supported row',        'back',       'machine',    'weight_reps',       false, false),
  ('Face pull',                  'back',       'cable',      'weight_reps',       false, false),
  -- shoulders
  ('Overhead press',             'shoulders',  'barbell',    'weight_reps',       false, false),
  ('Dumbbell shoulder press',    'shoulders',  'dumbbell',   'weight_reps',       false, false),
  ('Arnold press',               'shoulders',  'dumbbell',   'weight_reps',       false, false),
  ('Lateral raise',              'shoulders',  'dumbbell',   'weight_reps',       false, false),
  ('Rear delt fly',              'shoulders',  'dumbbell',   'weight_reps',       false, false),
  -- arms
  ('Barbell curl',               'biceps',     'barbell',    'weight_reps',       false, false),
  ('Dumbbell curl',              'biceps',     'dumbbell',   'weight_reps',       false, false),
  ('Hammer curl',                'biceps',     'dumbbell',   'weight_reps',       false, false),
  ('Tricep pushdown',            'triceps',    'cable',      'weight_reps',       false, false),
  ('Overhead tricep extension',  'triceps',    'dumbbell',   'weight_reps',       false, false),
  ('Skull crusher',              'triceps',    'barbell',    'weight_reps',       false, false),
  -- core
  ('Plank',                      'core',       'bodyweight', 'duration',          true,  false),
  ('Side plank',                 'core',       'bodyweight', 'duration',          true,  true),
  ('Copenhagen plank',           'core',       'bodyweight', 'duration',          true,  true),
  ('Dead bug',                   'core',       'bodyweight', 'reps',              true,  false),
  ('Bird dog',                   'core',       'bodyweight', 'reps',              true,  false),
  ('Pallof press',               'core',       'cable',      'weight_reps',       false, true),
  ('Hanging leg raise',          'core',       'bodyweight', 'reps',              true,  false),
  ('Ab wheel rollout',           'core',       'other',      'reps',              true,  false),
  ('Farmer''s carry',            'full_body',  'dumbbell',   'weight_duration',   false, false),
  -- plyometrics
  ('Double-leg pogo',            'calves',     'bodyweight', 'reps',              true,  false),
  ('Single-leg pogo',            'calves',     'bodyweight', 'reps',              true,  true),
  ('Box jump',                   'quads',      'other',      'reps',              true,  false),
  ('Broad jump',                 'quads',      'bodyweight', 'reps',              true,  false),
  -- warm-up, mobility, cardio
  ('Leg swings',                 'mobility',   'bodyweight', 'reps',              true,  true),
  ('Hip flexor stretch',         'mobility',   'bodyweight', 'duration',          true,  true),
  ('Hamstring stretch',          'mobility',   'bodyweight', 'duration',          true,  true),
  ('Figure-4 glute stretch',     'mobility',   'bodyweight', 'duration',          true,  true),
  ('Foam roll',                  'mobility',   'other',      'duration',          true,  false),
  ('Stationary bike',            'cardio',     'machine',    'duration',          false, false),
  ('Rower',                      'cardio',     'machine',    'distance_duration', false, false),
  ('Treadmill',                  'cardio',     'machine',    'distance_duration', false, false)
on conflict (lower(name)) where owner_id is null do nothing;
