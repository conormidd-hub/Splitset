import { ActivityIndicator, View } from 'react-native';

import { Button } from './Button';
import { T } from './T';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

export function Loading({ label }: { label?: string }) {
  const { palette } = useTheme();
  return (
    <View style={{ padding: space.xl, alignItems: 'center', gap: space.sm }}>
      <ActivityIndicator color={palette.mut} />
      {label ? <T variant="small" tone="mut">{label}</T> : null}
    </View>
  );
}

export function EmptyState({
  title, body, action,
}: { title: string; body?: string; action?: { title: string; onPress: () => void } }) {
  const { palette } = useTheme();
  return (
    <View style={{ padding: space.xl, alignItems: 'center', gap: space.sm, backgroundColor: palette.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: palette.hair }}>
      <T variant="h2" align="center">{title}</T>
      {body ? <T tone="mut" align="center">{body}</T> : null}
      {action ? <Button title={action.title} onPress={action.onPress} small style={{ marginTop: space.sm }} /> : null}
    </View>
  );
}

export function ErrorBanner({ message }: { message: string | null | undefined }) {
  const { palette } = useTheme();
  if (!message) return null;
  return (
    <View style={{ backgroundColor: palette.negSoft, borderRadius: radius.md, padding: space.md }}>
      <T variant="small" tone="neg">{message}</T>
    </View>
  );
}

export function errorMessage(e: unknown): string {
  if (!e) return '';
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
    return (e as { message: string }).message;
  }
  return 'Something went wrong';
}
