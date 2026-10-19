import type { SymbolViewProps } from 'expo-symbols';

/**
 * One name per platform for every glyph the metric tiles and pages draw: SF Symbols on iOS,
 * Material Symbols on Android and the web (the tab bar in app/(app)/_layout.tsx does the same).
 * Every name here exists in the symbol lists shipped with expo-symbols 57.
 */
export type IconName = SymbolViewProps['name'];

export const ICONS = {
  heart:     { ios: 'heart.fill',                android: 'favorite',              web: 'favorite' },
  hrv:       { ios: 'waveform.path.ecg',         android: 'ecg_heart',             web: 'ecg_heart' },
  sleep:     { ios: 'bed.double.fill',           android: 'bedtime',               web: 'bedtime' },
  moon:      { ios: 'moon.fill',                 android: 'nightlight',            web: 'nightlight' },
  lungs:     { ios: 'lungs.fill',                android: 'respiratory_rate',      web: 'respiratory_rate' },
  spo2:      { ios: 'drop.fill',                 android: 'spo2',                  web: 'spo2' },
  stress:    { ios: 'brain.head.profile',        android: 'psychology',            web: 'psychology' },
  steps:     { ios: 'shoeprints.fill',           android: 'steps',                 web: 'steps' },
  calories:  { ios: 'flame.fill',                android: 'local_fire_department', web: 'local_fire_department' },
  weight:    { ios: 'scalemass.fill',            android: 'scale',                 web: 'scale' },
  readiness: { ios: 'bolt.fill',                 android: 'bolt',                  web: 'bolt' },
  status:    { ios: 'chart.line.uptrend.xyaxis', android: 'trending_up',           web: 'trending_up' },
  vo2:       { ios: 'gauge.with.needle',         android: 'speed',                 web: 'speed' },
  fitness:   { ios: 'chart.bar.fill',            android: 'insights',              web: 'insights' },
  run:       { ios: 'figure.run',                android: 'directions_run',        web: 'directions_run' },
  walk:      { ios: 'figure.walk',               android: 'directions_run',        web: 'directions_run' },
  lift:      { ios: 'dumbbell.fill',             android: 'fitness_center',        web: 'fitness_center' },
  ride:      { ios: 'bicycle',                   android: 'directions_bike',       web: 'directions_bike' },
  swim:      { ios: 'figure.pool.swim',          android: 'pool',                  web: 'pool' },
  hike:      { ios: 'figure.walk',               android: 'directions_walk',       web: 'directions_walk' },
  cardio:    { ios: 'figure.mixed.cardio',       android: 'exercise',              web: 'exercise' },
  flame:     { ios: 'flame.fill',                android: 'local_fire_department', web: 'local_fire_department' },
  time:      { ios: 'stopwatch.fill',            android: 'timeline',              web: 'timeline' },
  trophy:    { ios: 'trophy.fill',               android: 'emoji_events',          web: 'emoji_events' },
  battery:   { ios: 'bolt.fill',                 android: 'battery_charging_full', web: 'battery_charging_full' },
  water:     { ios: 'drop.fill',                 android: 'water_drop',            web: 'water_drop' },
  sparkles:  { ios: 'sparkles',                  android: 'insights',              web: 'insights' },
  plus:      { ios: 'plus',                      android: 'add',                   web: 'add' },
  minus:     { ios: 'minus',                     android: 'remove',                web: 'remove' },
  grip:      { ios: 'line.3.horizontal',         android: 'drag_handle',           web: 'drag_handle' },
  check:     { ios: 'checkmark.circle.fill',     android: 'check_circle',          web: 'check_circle' },
  close:     { ios: 'xmark',                     android: 'close',                 web: 'close' },
  edit:      { ios: 'pencil',                    android: 'edit',                  web: 'edit' },
  tune:      { ios: 'slider.horizontal.3',       android: 'tune',                  web: 'tune' },
  settings:  { ios: 'gear',                      android: 'settings',              web: 'settings' },
  sync:      { ios: 'arrow.triangle.2.circlepath', android: 'sync',                web: 'sync' },
  calendar:  { ios: 'calendar',                  android: 'calendar_month',        web: 'calendar_month' },
  history:   { ios: 'clock.arrow.circlepath',    android: 'history',               web: 'history' },
  map:       { ios: 'map.fill',                  android: 'map',                   web: 'map' },
  routines:  { ios: 'list.bullet.rectangle.fill', android: 'list_alt',             web: 'list_alt' },
  chart:     { ios: 'chart.xyaxis.line',         android: 'show_chart',            web: 'show_chart' },
  compare:   { ios: 'chart.line.uptrend.xyaxis', android: 'stacked_line_chart',    web: 'stacked_line_chart' },
  body:      { ios: 'figure.arms.open',          android: 'accessibility_new',     web: 'accessibility_new' },
  route:     { ios: 'point.topleft.down.to.point.bottomright.curvepath', android: 'route', web: 'route' },
  expand:    { ios: 'chevron.down',              android: 'expand_more',           web: 'expand_more' },
  collapse:  { ios: 'chevron.up',                android: 'expand_less',           web: 'expand_less' },
  chevron:   { ios: 'chevron.right',             android: 'chevron_right',         web: 'chevron_right' },
  back:      { ios: 'chevron.left',              android: 'chevron_left',          web: 'chevron_left' },
} as const satisfies Record<string, IconName>;

export type IconKey = keyof typeof ICONS;
