-- Splitset maps: the saved home needs the precision a tap or an address gives (about a metre).
--
-- As `real`, the two coordinates came back from the API with six significant digits: 144.975 for
-- 144.97451, forty metres off, so a saved home never matched the start it was saved from and a
-- route from home began down the street. Double precision keeps what was saved.

alter table public.profiles
  alter column home_lat type double precision,
  alter column home_lng type double precision;
