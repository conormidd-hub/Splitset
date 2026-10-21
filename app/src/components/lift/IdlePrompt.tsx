import { Modal, Pressable, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { T } from '@/components/ui/T';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

/**
 * The workout's clock has paused for inactivity: carry on (the pause is left out of the time),
 * finish it (it ends at the last set), leave it paused for later, or discard it.
 */
export function IdlePrompt({ open, awayMinutes, onContinue, onFinish, onLater, onDiscard }: {
  open: boolean;
  awayMinutes: number;
  onContinue: () => void;
  onFinish: () => void;
  onLater: () => void;
  onDiscard: () => void;
}) {
  const { palette } = useTheme();
  const away = awayMinutes >= 120 ? `${Math.floor(awayMinutes / 60)} h ${awayMinutes % 60} min` : `${awayMinutes} min`;
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onLater}>
      <Pressable onPress={onLater} accessible={false} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', padding: space.lg }}>
        <Pressable onPress={() => undefined} accessible={false} aria-modal aria-label="Still lifting?"
          style={{ backgroundColor: palette.surface, borderRadius: radius.lg, padding: space.lg, gap: space.md, maxWidth: 440, width: '100%', alignSelf: 'center' }}>
          <View style={{ gap: space.xs }}>
            <T variant="h2">Still lifting?</T>
            <T tone="ink2">Nothing has been logged for {away}, so the clock is paused. Pick up where you left off, or wrap up.</T>
          </View>
          <Button title="Continue" onPress={onContinue} />
          <T variant="tiny" tone="mut" style={{ marginTop: -space.sm }}>The time away is left out of the workout&apos;s clock.</T>
          <Button title="Finish workout" variant="secondary" onPress={onFinish} />
          <T variant="tiny" tone="mut" style={{ marginTop: -space.sm }}>It ends at your last set, not now.</T>
          <Button title="Save for later" variant="secondary" onPress={onLater} />
          <Button title="Discard workout" variant="ghost" small onPress={onDiscard} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}
