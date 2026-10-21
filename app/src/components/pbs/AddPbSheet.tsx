import { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from 'react-native';

import { useExercises, useRecords } from '@/api/lifting';
import { Button } from '@/components/ui/Button';
import { T } from '@/components/ui/T';
import { TextField } from '@/components/ui/TextField';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

import { KnownBestFields } from './KnownBestFields';

/**
 * "Add a PB" from the PBs tab: pick the lift (recently done first, searchable), then weight × reps
 * and a date, with the estimated 1RM shown as it is typed. Opened for one lift from its card, the
 * lift is already picked. The entry counts in the PB tables at once, marked manual, until a
 * heavier logged set beats it.
 */
export function AddPbSheet({ open, exerciseId, onClose }: { open: boolean; exerciseId: string | null; onClose: () => void }) {
  const { palette } = useTheme();
  const exercises = useExercises();
  const records = useRecords();
  const [picked, setPicked] = useState<string | null>(exerciseId);
  const [query, setQuery] = useState('');
  const exercise = exercises.data?.find((e) => e.id === picked) ?? null;

  // weight × reps lifts only (a known best is an e1RM), the ones done most recently first
  const lifts = useMemo(() => {
    const lastDone = new Map((records.data ?? []).map((r) => [r.exercise_id, r.last_completed_at ?? '']));
    const q = query.trim().toLowerCase();
    return (exercises.data ?? [])
      .filter((e) => e.measure === 'weight_reps' && (!q || e.name.toLowerCase().includes(q)))
      .sort((a, b) => (lastDone.get(b.id) ?? '').localeCompare(lastDone.get(a.id) ?? '') || a.name.localeCompare(b.name));
  }, [exercises.data, records.data, query]);

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <Pressable onPress={onClose} accessible={false} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', padding: space.lg }}>
          <Pressable onPress={() => undefined} accessible={false} aria-modal aria-label="Add a PB"
            style={{ backgroundColor: palette.surface, borderRadius: radius.lg, padding: space.lg, gap: space.md, maxWidth: 440, width: '100%', alignSelf: 'center' }}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm }}>
              <View style={{ flex: 1 }}>
                <T variant="h2">Add a PB</T>
                <T variant="small" tone="mut">{exercise ? exercise.name : 'A best you know from before Splitset, or from a day you didn’t log.'}</T>
              </View>
              <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={10}>
                <T tone="mut" weight="700">✕</T>
              </Pressable>
            </View>

            {exercise ? (
              <>
                <KnownBestFields exercise={exercise} buttonTitle="Add PB" onAdded={onClose} />
                {/* opened for a lift, there is nothing to change; opened blank, the lift can be swapped */}
                {exerciseId ? null : <Button title="Pick another lift" variant="ghost" small onPress={() => setPicked(null)} />}
              </>
            ) : (
              <>
                <TextField value={query} onChangeText={setQuery} placeholder="Find a lift" autoCapitalize="none" autoFocus />
                <ScrollView style={{ maxHeight: 280 }} keyboardShouldPersistTaps="handled">
                  {lifts.length ? lifts.map((e, i) => (
                    <Pressable
                      key={e.id}
                      onPress={() => setPicked(e.id)}
                      accessibilityRole="button"
                      style={({ pressed }) => ({ paddingVertical: 10, borderTopWidth: i ? 1 : 0, borderTopColor: palette.hair, opacity: pressed ? 0.7 : 1 })}>
                      <T weight="600">{e.name}</T>
                      {e.muscle_group || e.equipment ? <T variant="tiny" tone="mut">{[e.muscle_group, e.equipment].filter(Boolean).join(' · ')}</T> : null}
                    </Pressable>
                  )) : <T tone="mut" align="center">{query.trim() ? `No lift matches “${query.trim()}”.` : 'No weight × reps lifts in the library yet.'}</T>}
                </ScrollView>
              </>
            )}
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}
