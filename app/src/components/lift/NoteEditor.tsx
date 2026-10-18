import { useState } from 'react';
import { Modal, Pressable, TextInput, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { T } from '@/components/ui/T';
import { useTheme } from '@/theme/ThemeProvider';
import { fontSize, radius, space } from '@/theme/tokens';

export type NoteScope = 'template' | 'exercise' | 'workout';
export type ExerciseNotes = Record<NoteScope, string | null>;

export const NOTE_ICON: Record<NoteScope, string> = { template: '📌', exercise: '🔗', workout: '📝' };
const SCOPE_TEXT: Record<NoteScope, string> = {
  template: 'This template',
  exercise: 'Every workout with this exercise',
  workout: 'This workout only',
};

/** Where a note opens: the template's note when the workout has a template (unless only an
 *  exercise-wide note exists), else this workout's own. */
export function defaultScope(hasTemplate: boolean, notes: ExerciseNotes): NoteScope {
  if (!hasTemplate) return 'workout';
  return !notes.template && notes.exercise ? 'exercise' : 'template';
}

/**
 * An exercise's note, Strong-style. In a workout from a template, the 📌 / 🔗 switch says where it
 * lives: on the template, or on the exercise in every workout. With no template it stays with
 * this workout. An emptied note is removed.
 */
export function NoteEditor({ open, exerciseName, hasTemplate, notes, onSave, onClose }: {
  open: boolean;
  exerciseName: string;
  hasTemplate: boolean;
  notes: ExerciseNotes;
  onSave: (scope: NoteScope, text: string) => void;
  onClose: () => void;
}) {
  const { palette } = useTheme();
  const [scope, setScope] = useState<NoteScope>('workout');
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [shownFor, setShownFor] = useState<string | null>(null);
  // each opening starts from the note where it lives (adjusting state during render)
  const key = open ? exerciseName : null;
  if (key !== shownFor) {
    setShownFor(key);
    const s = defaultScope(hasTemplate, notes);
    setScope(s);
    setText(notes[s] ?? '');
    setDirty(false);
  }
  const pick = (s: NoteScope) => {
    setScope(s);
    // an untouched note follows the scope; one being written moves with it
    if (!dirty) setText(notes[s] ?? '');
  };

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable onPress={onClose} accessible={false} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', padding: space.lg }}>
        <Pressable onPress={() => undefined} accessible={false} aria-modal aria-label={`Note for ${exerciseName}`}
          style={{ backgroundColor: palette.surface, borderRadius: radius.lg, padding: space.lg, gap: space.md, maxWidth: 480, width: '100%', alignSelf: 'center' }}>
          <View>
            <T variant="label" tone="mut">Note</T>
            <T variant="h2" numberOfLines={2}>{exerciseName}</T>
          </View>
          {hasTemplate ? (
            <View style={{ flexDirection: 'row', gap: space.sm }}>
              {(['template', 'exercise'] as const).map((s) => (
                <Pressable
                  key={s}
                  onPress={() => pick(s)}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: scope === s }}
                  aria-checked={scope === s}
                  accessibilityLabel={SCOPE_TEXT[s]}
                  style={{ flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: space.sm,
                    borderRadius: radius.md, borderWidth: 1.5, borderColor: scope === s ? palette.accent : palette.hair,
                    backgroundColor: scope === s ? palette.accentSoft : palette.surface2 }}>
                  <T>{NOTE_ICON[s]}</T>
                  <T variant="small" weight="600" tone={scope === s ? 'accent' : 'ink2'} numberOfLines={2} style={{ flexShrink: 1 }}>
                    {s === 'template' ? 'This template' : 'All workouts'}
                  </T>
                </Pressable>
              ))}
            </View>
          ) : null}
          <T variant="small" tone="mut">
            {NOTE_ICON[scope]} {SCOPE_TEXT[scope]}
            {scope === 'template' ? ': shows whenever you start this template.' : scope === 'exercise' ? ': shows in every template and workout.' : '.'}
          </T>
          <TextInput
            value={text}
            onChangeText={(v) => { setText(v); setDirty(true); }}
            placeholder="Seat height 4, pause at the bottom…"
            placeholderTextColor={palette.mut}
            multiline
            autoFocus
            maxLength={2000}
            accessibilityLabel="Note"
            style={{ minHeight: 110, textAlignVertical: 'top', color: palette.ink, fontSize: fontSize.body, padding: space.md,
              borderRadius: radius.md, borderWidth: 1, borderColor: palette.hair, backgroundColor: palette.surface2 }}
          />
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Button title="Save" onPress={() => { onSave(scope, text); onClose(); }} style={{ flex: 1 }} />
            <Button title="Cancel" variant="secondary" onPress={onClose} style={{ flex: 1 }} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
