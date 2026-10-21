import { Modal, Pressable, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { T } from '@/components/ui/T';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

export type TemplateChoice = 'update' | 'new' | 'keep';

/**
 * Finishing a workout. With a template whose exercises differ from today's: update the template to
 * today's workout, save today's as a new template, or keep the template as it is. Without a
 * template (`templateName` null): finish, or finish and save today's workout as a routine. Each
 * choice saves the workout; Cancel goes back to it.
 */
export function FinishPrompt({ open, templateName, unticked, onChoose, onCancel }: {
  open: boolean;
  /** The template the workout started from, or null for a workout without one. */
  templateName: string | null;
  /** Filled-in sets that aren't ticked, kept as unfinished. */
  unticked: number;
  onChoose: (choice: TemplateChoice) => void;
  onCancel: () => void;
}) {
  const { palette } = useTheme();
  const untickedNote = unticked ? (
    <T variant="small" tone="mut">{unticked} filled-in set{unticked === 1 ? ' isn’t' : 's aren’t'} ticked and will be kept as unfinished.</T>
  ) : null;
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable onPress={onCancel} accessible={false} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', padding: space.lg }}>
        <Pressable onPress={() => undefined} accessible={false} aria-modal aria-label="Finish workout"
          style={{ backgroundColor: palette.surface, borderRadius: radius.lg, padding: space.lg, gap: space.md, maxWidth: 440, width: '100%', alignSelf: 'center' }}>
          {templateName ? (
            <>
              <View style={{ gap: space.xs }}>
                <T variant="h2">Finish workout</T>
                <T tone="ink2">You added or removed exercises from {templateName}. Your workout is saved either way. What about the template?</T>
                {untickedNote}
              </View>
              <Button title="Update template" onPress={() => onChoose('update')} />
              <T variant="tiny" tone="mut" style={{ marginTop: -space.sm }}>{templateName} becomes today’s exercises, sets and weights.</T>
              <Button title="Save as new template" variant="secondary" onPress={() => onChoose('new')} />
              <Button title="Keep template as is" variant="secondary" onPress={() => onChoose('keep')} />
            </>
          ) : (
            <>
              <View style={{ gap: space.xs }}>
                <T variant="h2">Finish workout</T>
                <T tone="ink2">Save this workout to your history?</T>
                {untickedNote}
              </View>
              <Button title="Finish" onPress={() => onChoose('keep')} />
              <Button title="Finish and save as routine" variant="secondary" onPress={() => onChoose('new')} />
              <T variant="tiny" tone="mut" style={{ marginTop: -space.sm }}>Today’s exercises, sets and weights become a routine to start from next time.</T>
            </>
          )}
          <Button title="Back to workout" variant="ghost" small onPress={onCancel} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}
