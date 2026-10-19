import { Modal, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';

import { useExerciseNotes, type RoutineWithStructure } from '@/api/lifting';
import { useUnits } from '@/api/profile';
import { Button } from '@/components/ui/Button';
import { T } from '@/components/ui/T';
import { setsSummary } from '@/lib/lifting/template';
import { formatLoad } from '@/lib/pbs';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

/**
 * A routine at a glance (the Lift tab's View): its exercises with their sets and notes, and
 * Start, Edit (the routine editor) and Close. A tap outside closes it.
 */
export function RoutineQuickView({ routine, startDisabled, onStart, onEdit, onClose }: {
  routine: RoutineWithStructure | null;
  startDisabled: boolean;
  onStart: (r: RoutineWithStructure) => void;
  onEdit: (r: RoutineWithStructure) => void;
  onClose: () => void;
}) {
  const { palette } = useTheme();
  const units = useUnits();
  const notes = useExerciseNotes();
  const { height } = useWindowDimensions();
  const r = routine;
  return (
    <Modal visible={!!r} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable onPress={onClose} accessible={false} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', padding: space.lg }}>
        {r ? (
          <Pressable onPress={() => undefined} accessible={false} aria-modal aria-label={r.name}
            style={{ backgroundColor: palette.surface, borderRadius: radius.lg, padding: space.lg, gap: space.md, maxWidth: 480, width: '100%', alignSelf: 'center', maxHeight: height * 0.8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm }}>
              <View style={{ flex: 1 }}>
                <T variant="h2">{r.name}</T>
                <T variant="small" tone="mut">{r.routine_exercises.length} exercise{r.routine_exercises.length === 1 ? '' : 's'}</T>
              </View>
              <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={10}>
                <T tone="mut" weight="700">✕</T>
              </Pressable>
            </View>
            {r.notes ? <T variant="small" tone="ink2">{r.notes}</T> : null}
            <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 0 }}>
              {r.routine_exercises.length ? r.routine_exercises.map((re, i) => {
                const everywhere = notes.data?.get(re.exercise_id);
                return (
                  <View key={re.id} style={{ paddingVertical: space.sm, gap: 2, borderTopWidth: i ? 1 : 0, borderTopColor: palette.hair }}>
                    <T weight="600">{re.exercise?.name ?? 'Exercise'}</T>
                    <T variant="small" tone="mut">{setsSummary(re.routine_sets, (kg) => formatLoad(kg, units))}</T>
                    {re.notes ? <T variant="small" tone="ink2">📌 {re.notes}</T> : null}
                    {everywhere ? <T variant="small" tone="ink2">🔗 {everywhere}</T> : null}
                  </View>
                );
              }) : <T tone="mut">No exercises yet. Edit it to add some.</T>}
            </ScrollView>
            <View style={{ flexDirection: 'row', gap: space.sm }}>
              <Button title="Start" disabled={startDisabled} onPress={() => onStart(r)} style={{ flex: 1 }} />
              <Button title="Edit" variant="secondary" onPress={() => onEdit(r)} style={{ flex: 1 }} />
            </View>
            {startDisabled ? <T variant="tiny" tone="mut" align="center">Finish the workout in progress to start another.</T> : null}
          </Pressable>
        ) : null}
      </Pressable>
    </Modal>
  );
}
