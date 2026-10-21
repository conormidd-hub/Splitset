-- Splitset maps: a saved home, the usual start of a route.
--
-- The route builders offer "Home" as a start point, next to "My location" and an address search.
-- The user saves it from either builder ("Save as home"), from an address they searched or a
-- point they tapped; the label is the address or place name, or "Home".

alter table public.profiles
  add column home_lat   real,
  add column home_lng   real,
  add column home_label text;

comment on column public.profiles.home_lat   is 'Latitude of the saved home start point; null until saved.';
comment on column public.profiles.home_lng   is 'Longitude of the saved home start point.';
comment on column public.profiles.home_label is 'The address or place name saved as home, shown on the route builders.';

grant update (home_lat, home_lng, home_label) on public.profiles to authenticated;
