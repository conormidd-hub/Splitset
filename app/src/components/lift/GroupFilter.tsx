import { ScrollView } from 'react-native';

import { Chip } from '@/components/ui/Chip';
import { EXERCISE_GROUPS } from '@/lib/recovery/library';
import { space } from '@/theme/tokens';

/** "All" plus the library's exercise groups, as one scrolling row of chips. */
export function GroupFilter({ value, onChange }: { value: string | null; onChange: (group: string | null) => void }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ gap: space.sm }}>
      <Chip label="All" selected={value === null} onPress={() => onChange(null)} />
      {EXERCISE_GROUPS.map((g) => (
        <Chip key={g} label={g} selected={value === g} onPress={() => onChange(value === g ? null : g)} />
      ))}
    </ScrollView>
  );
}
