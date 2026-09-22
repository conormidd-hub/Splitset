import { Link, Stack } from 'expo-router';

import { Screen } from '@/components/ui/Screen';
import { T } from '@/components/ui/T';

export default function NotFoundScreen() {
  return (
    <>
      <Stack.Screen options={{ title: 'Not found' }} />
      <Screen edges={['top', 'left', 'right']}>
        <T variant="h1">This screen does not exist.</T>
        <Link href="/">
          <T tone="accent">Go home</T>
        </Link>
      </Screen>
    </>
  );
}
