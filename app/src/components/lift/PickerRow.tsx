import { Pressable, View } from 'react-native';

import type { Exercise } from '@/api/lifting';
import type { MuscleRole } from '@/api/recovery';
import { ExerciseMuscles, NOT_ON_MAP, NotOnMap, useLoadSplit } from '@/components/recovery/ExerciseMuscles';
import { T } from '@/components/ui/T';
import type { MuscleId } from '@/lib/recovery/library';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

type Props = {
  exercise: Exercise;
  first: boolean;
  /** The exercise's muscles by role (none for unmapped exercises), or null while they load. */
  roles: readonly MuscleRole[] | null;
  /** Its PB source line, or null when it needs no reference. */
  reference: string | null;
  expanded: boolean;
  onToggle: () => void;
  onChoose: () => void;
  nameOf: (id: MuscleId) => string;
};

/**
 * One exercise in the picker: just its name, to scan the list fast, and an info button. The info
 * button opens the detail underneath: where it lands on the body (the mini figure with its
 * primary, secondary and tertiary muscles), what kind of exercise it is, and the PB source line.
 * An unmapped exercise (a legacy or older custom one) says it is not on the recovery map.
 */
export function PickerRow({ exercise, first, roles, reference, expanded, onToggle, onChoose, nameOf }: Props) {
  const { palette } = useTheme();
  const split = useLoadSplit(roles ?? [], nameOf);
  const unmapped = roles?.length === 0;
  // no session of an unmapped exercise reaches the map, so "calibrating" would mislead; a PB it
  // already has still stands (notes D4)
  const line = unmapped && reference?.startsWith('calibrating') ? null : reference;
  const subtitle = [exercise.muscle_group ?? exercise.group, exercise.equipment, exercise.owner_id ? 'yours' : null].filter(Boolean).join(' · ');
  // the label replaces the row's text for a screen reader, so it carries the detail too
  const label = [`Add ${exercise.name}`, subtitle, unmapped ? NOT_ON_MAP : split.parts.length ? split.label : null, line]
    .filter((s): s is string => !!s).map((s) => s.replace(/ · /g, ', ')).join('. ');
  return (
    <View style={{ borderTopWidth: first ? 0 : 1, borderTopColor: palette.hair, paddingVertical: space.sm, gap: space.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <Pressable onPress={onChoose} accessibilityRole="button" accessibilityLabel={label}
          style={({ pressed }) => ({ flex: 1, minHeight: 40, justifyContent: 'center', opacity: pressed ? 0.7 : 1 })}>
          <T variant="h3" numberOfLines={1}>{exercise.name}</T>
        </Pressable>
        <Pressable
          onPress={onToggle}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel={expanded ? `Hide ${exercise.name}'s details` : `Show ${exercise.name}'s details`}
          style={({ pressed }) => ({ width: 30, height: 30, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center',
            backgroundColor: expanded ? palette.accentSoft : palette.surface2, opacity: pressed ? 0.7 : 1 })}>
          <T variant="small" tone={expanded ? 'accent' : 'ink2'} weight="700">i</T>
        </Pressable>
      </View>
      {expanded ? (
        <View style={{ gap: space.sm, paddingBottom: space.xs }}>
          {subtitle ? <T variant="small" tone="mut">{subtitle}</T> : null}
          {unmapped ? <NotOnMap /> : roles?.length ? <ExerciseMuscles roles={roles} nameOf={nameOf} figureWidth={64} showSplit={false} /> : null}
          {line ? <T variant="tiny" tone="ink2">{line}</T> : null}
        </View>
      ) : null}
    </View>
  );
}
