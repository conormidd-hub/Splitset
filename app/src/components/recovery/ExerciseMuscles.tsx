import { View } from 'react-native';

import { FigurePair } from './FigurePair';
import { useThresholds, type MuscleRole } from '@/api/recovery';
import { T } from '@/components/ui/T';
import { MUSCLE_IDS, type MuscleId, type Role } from '@/lib/recovery/library';
import { loadSplit, roleFigure, roleTints } from '@/lib/recovery/screens';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

const ROLE_NAMES: Record<Role, string> = { primary: 'Primary', secondary: 'Secondary', tertiary: 'Tertiary' };

/** What an exercise with no muscles mapped (a legacy or older custom one) shows in place of its
 *  split bar: logging it adds no load. */
export const NOT_ON_MAP = 'Not on the recovery map: no muscles mapped';

export function NotOnMap() {
  return <T variant="tiny" tone="mut" numberOfLines={1}>{NOT_ON_MAP}</T>;
}

/** The three role tints for the current theme: the app accent, fading towards the Ready grey. */
export function useRoleTints() {
  const { palette, name } = useTheme();
  const c = useThresholds();
  const ready = name === 'night' ? c.ready_fill_dark : c.ready_fill;
  return { tints: roleTints(palette.accent, ready), ready };
}

/**
 * Where one set's load lands, as the bar shows it: spec §6's formula with the user's own role
 * weights (a stored load_split assumes the defaults, so it goes stale once Settings changes one),
 * biggest share first, ties in body order. The caption reads "chest 56% · front delts 22% ·
 * triceps 22%"; the label is the same for a screen reader.
 */
export function useLoadSplit(roles: readonly MuscleRole[], nameOf: (id: MuscleId) => string) {
  const c = useThresholds();
  const parts = loadSplit(c, null, roles)
    .sort((a, b) => b.pct - a.pct || MUSCLE_IDS.indexOf(a.muscle) - MUSCLE_IDS.indexOf(b.muscle));
  const named = parts.map((p) => `${nameOf(p.muscle).toLowerCase()} ${p.pct}%`);
  return { parts, caption: named.join(' · '), label: `Load split: ${named.join(', ')}` };
}

/**
 * Where one set's load lands: a stacked bar of the exercise's load split, each part in its role's
 * tint, with the percentages written underneath (see useLoadSplit).
 */
export function LoadSplitBar({ roles, nameOf, height = 8 }: {
  roles: readonly MuscleRole[]; nameOf: (id: MuscleId) => string; height?: number;
}) {
  const { palette } = useTheme();
  const { tints } = useRoleTints();
  const { parts, caption, label } = useLoadSplit(roles, nameOf);
  if (!parts.length) return <T variant="small" tone="mut">No muscles mapped, so this exercise adds no load.</T>;
  const roleOf = new Map(roles.map((r) => [r.muscle_id, r.role as Role]));
  return (
    <View style={{ gap: 4 }} accessibilityLabel={label}>
      <View style={{ flexDirection: 'row', height, borderRadius: radius.pill, overflow: 'hidden', backgroundColor: palette.surface2, gap: 2 }}>
        {parts.map((p) => (
          <View key={p.muscle} style={{ flex: p.pct, backgroundColor: tints[roleOf.get(p.muscle) ?? 'tertiary'] }} />
        ))}
      </View>
      <T variant="tiny" tone="mut">{caption}</T>
    </View>
  );
}

/** An exercise's muscles (build phase 7): the mini figure in three tints, the load split bar and
 *  a key to the tints. */
export function ExerciseMuscles({ roles, nameOf, figureWidth = 72, showSplit = true }: {
  roles: readonly MuscleRole[]; nameOf: (id: MuscleId) => string; figureWidth?: number;
  /** Off where the split bar is already shown (the picker row). */
  showSplit?: boolean;
}) {
  const { tints, ready } = useRoleTints();
  const used = (['primary', 'secondary', 'tertiary'] as const).filter((role) => roles.some((r) => r.role === role));
  return (
    <View style={{ gap: space.md }}>
      <FigurePair map={roleFigure(roles, tints, ready)} mode="session" figureWidth={figureWidth} nameOf={nameOf}
        context="muscles used" emptyText={used.length ? 'none on this side' : 'no muscles mapped'} />
      {showSplit ? <LoadSplitBar roles={roles} nameOf={nameOf} /> : null}
      {used.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md }}>
          {used.map((role) => (
            <View key={role} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <View style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: tints[role] }} />
              <T variant="tiny" tone="ink2">
                {ROLE_NAMES[role]}: {roles.filter((r) => r.role === role).map((r) => nameOf(r.muscle_id as MuscleId).toLowerCase()).join(', ')}
              </T>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
