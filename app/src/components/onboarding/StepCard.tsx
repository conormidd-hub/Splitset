import { SymbolView } from 'expo-symbols';
import type { ReactNode } from 'react';
import { View } from 'react-native';

import { Card } from '@/components/ui/Card';
import { T } from '@/components/ui/T';
import { ICONS } from '@/lib/icons';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

type Props = {
  n: number;
  title: string;
  state: 'open' | 'done' | 'todo';
  /** The one line a finished step folds down to. */
  summary?: string;
  /** Tap a finished step to come back to it. */
  onOpen?: () => void;
  children?: ReactNode;
};

/**
 * One step of the connect wizard: a numbered circle, the title, and the body only while it is
 * the step in hand. Finished steps fold to a tick and a line; the ones still to come sit faded.
 */
export function StepCard({ n, title, state, summary, onOpen, children }: Props) {
  const { palette } = useTheme();
  const reopen = state === 'done' && onOpen ? onOpen : undefined;
  return (
    <Card onPress={reopen} style={state === 'todo' ? { opacity: 0.55 } : undefined}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <View
          style={{
            width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
            backgroundColor: state === 'open' ? palette.accent : 'transparent',
            borderWidth: state === 'todo' ? 1 : 0, borderColor: palette.hair,
          }}>
          {state === 'done' ? (
            <SymbolView name={ICONS.check} tintColor={palette.pos} size={26} />
          ) : (
            <T variant="small" tone={state === 'open' ? 'onAccent' : 'mut'} weight="700">{n}</T>
          )}
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <T variant="h3" tone={state === 'todo' ? 'mut' : 'ink'}>{title}</T>
          {state === 'done' && summary ? <T variant="small" tone="mut">{summary}</T> : null}
        </View>
        {reopen ? <T variant="small" tone="accent" weight="700">Change</T> : null}
      </View>
      {state === 'open' && children ? <View style={{ marginTop: space.md, gap: space.md }}>{children}</View> : null}
    </Card>
  );
}
