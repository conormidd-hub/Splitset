import { Pressable, View } from 'react-native';

import type { Exercise } from '@/api/lifting';
import type { MuscleRole } from '@/api/recovery';
import { ExerciseMuscles, LoadSplitBar } from '@/components/recovery/ExerciseMuscles';
import { T } from '@/components/ui/T';
import type { MuscleId } from '@/lib/recovery/library';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

type Props = {
  exercise: Exercise;
  first: boolean;
  /** The exercise's muscles by role (none for unmapped exercises). */
  roles: readonly MuscleRole[];
  /** Its PB source line, or null when it needs no reference. */
  reference: string | null;
  expanded: boolean;
  onToggle: () => void;
  onChoose: () => void;
  nameOf: (id: MuscleId) => string;
};

/**
 * One exercise in the picker (build phase 7): name and kind, where one set's load lands (the load
 * split bar) and the PB source line. The info button opens the mini figure underneath.
 */
export function PickerRow({ exercise, first, roles, reference, expanded, onToggle, onChoose, nameOf }: Props) {
  const { palette } = useTheme();
  const subtitle = [exercise.muscle_group ?? exercise.group, exercise.equipment, exercise.owner_id ? 'yours' : null].filter(Boolean).join(' · ');
  return (
    <View style={{ borderTopWidth: first ? 0 : 1, borderTopColor: palette.hair, paddingVertical: space.md, gap: space.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.md }}>
        <Pressable onPress={onChoose} accessibilityRole="button" accessibilityLabel={`Add ${exercise.name}`}
          style={({ pressed }) => ({ flex: 1, gap: 4, opacity: pressed ? 0.7 : 1 })}>
          <T variant="h3" numberOfLines={1}>{exercise.name}</T>
          {subtitle ? <T variant="small" tone="mut" numberOfLines={1}>{subtitle}</T> : null}
          {roles.length ? <LoadSplitBar split={exercise.load_split} roles={roles} nameOf={nameOf} height={6} /> : null}
          {reference ? <T variant="tiny" tone="ink2" numberOfLines={1}>{reference}</T> : null}
        </Pressable>
        {roles.length ? (
          <Pressable
            onPress={onToggle}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={expanded ? `Hide ${exercise.name}'s muscles` : `Show ${exercise.name}'s muscles`}
            style={({ pressed }) => ({ width: 30, height: 30, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center',
              backgroundColor: expanded ? palette.accentSoft : palette.surface2, opacity: pressed ? 0.7 : 1 })}>
            <T variant="small" tone={expanded ? 'accent' : 'ink2'} weight="700">i</T>
          </Pressable>
        ) : null}
      </View>
      {expanded ? <ExerciseMuscles split={exercise.load_split} roles={roles} nameOf={nameOf} figureWidth={64} showSplit={false} /> : null}
    </View>
  );
}
