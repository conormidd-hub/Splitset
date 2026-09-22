import { Pressable, View } from 'react-native';

import { T } from './T';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

export function Chip({ label, selected, onPress }: { label: string; selected?: boolean; onPress?: () => void }) {
  const { palette } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: selected ? palette.accent : palette.surface2,
        borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 6,
        opacity: pressed ? 0.8 : 1,
      })}>
      <T variant="small" tone={selected ? 'onAccent' : 'ink2'} weight="600">{label}</T>
    </Pressable>
  );
}

export function ChipRow({ children }: { children: React.ReactNode }) {
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>{children}</View>;
}

/** A pill-shaped, two-to-four-way selector for settings. */
export function Segmented<T extends string>({
  options, value, onChange,
}: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  const { palette } = useTheme();
  return (
    <View style={{ flexDirection: 'row', backgroundColor: palette.surface2, borderRadius: radius.md, padding: 3 }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            style={{
              flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: radius.sm,
              backgroundColor: on ? palette.surface : 'transparent',
            }}>
            <T variant="small" tone={on ? 'ink' : 'mut'} weight={on ? '700' : '500'}>{o.label}</T>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Badge({ label, tone = 'mut' }: { label: string; tone?: 'mut' | 'accent' | 'pos' | 'neg' }) {
  const { palette } = useTheme();
  const bg = tone === 'accent' ? palette.accentSoft : tone === 'neg' ? palette.negSoft : tone === 'pos' ? palette.accentSoft : palette.surface3;
  return (
    <View style={{ backgroundColor: bg, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 }}>
      <T variant="tiny" tone={tone === 'mut' ? 'ink2' : tone} weight="700">{label}</T>
    </View>
  );
}
