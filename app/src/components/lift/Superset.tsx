import type { ReactNode } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { QuickView } from '@/components/recovery/FigureBubble';
import { Button } from '@/components/ui/Button';
import { T } from '@/components/ui/T';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

export const SUPERSET_GLYPH = '⟲';

/** The pill on an exercise card: "⟲" to link it, "⟲ A" once it is in superset A. */
export function SupersetPill({ letter, name, onPress }: { letter: string | null; name: string; onPress: () => void }) {
  const { palette } = useTheme();
  const on = !!letter;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={on ? `${name} is in superset ${letter}. Tap to change or unlink.` : `Superset ${name} with another exercise`}
      hitSlop={6}
      style={({ pressed }) => ({
        height: 28, minWidth: 34, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill,
        backgroundColor: on ? palette.accent : palette.surface2, borderWidth: 1, borderColor: on ? palette.accent : palette.hair,
        opacity: pressed ? 0.8 : 1,
      })}>
      <T variant="small" weight="700" tone={on ? 'onAccent' : 'ink2'}>{on ? `${SUPERSET_GLYPH} ${letter}` : SUPERSET_GLYPH}</T>
    </Pressable>
  );
}

export type SupersetOption = {
  id: string;
  name: string;
  /** The exercise right after this one: the natural partner. */
  suggested?: boolean;
  /** Already in another superset (joining it is allowed). */
  letter?: string | null;
};

/**
 * Pick the exercise to superset with: the other exercises in the workout, the next one marked as
 * suggested, plus "Add a new exercise" (the picker, which links the new one). A linked exercise
 * can be unlinked here.
 */
export function SupersetSheet({ open, name, letter, options, onPick, onUnlink, onAdd, onClose }: {
  open: boolean;
  name: string;
  letter: string | null;
  options: SupersetOption[];
  onPick: (id: string) => void;
  onUnlink: () => void;
  onAdd: () => void;
  onClose: () => void;
}) {
  const { palette } = useTheme();
  return (
    <QuickView visible={open} onClose={onClose} title={`Superset ${name}`}>
      <View>
        <T variant="h3">{letter ? `Superset ${letter}` : 'Superset'}</T>
        <T variant="small" tone="mut">{letter ? `${name} alternates with the exercises below it. Pick another to add, or unlink it.` : `Alternate ${name} set for set with…`}</T>
      </View>
      {options.length ? (
        <ScrollView style={{ maxHeight: 300 }}>
          {options.map((o, i) => (
            <Pressable
              key={o.id}
              onPress={() => onPick(o.id)}
              accessibilityRole="button"
              accessibilityLabel={`${o.name}${o.suggested ? ', suggested, the next exercise' : o.letter ? `, in superset ${o.letter}` : ''}`}
              style={({ pressed }) => ({
                flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 10, borderTopWidth: i ? 1 : 0, borderTopColor: palette.hair,
                opacity: pressed ? 0.7 : 1,
              })}>
              <T weight={o.suggested ? '700' : '500'} style={{ flex: 1 }} numberOfLines={1}>{o.name}</T>
              {o.suggested ? (
                <View style={{ backgroundColor: palette.accentSoft, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 }}>
                  <T variant="tiny" tone="accent" weight="700">Suggested · next</T>
                </View>
              ) : o.letter ? <T variant="tiny" tone="mut">{SUPERSET_GLYPH} {o.letter}</T> : null}
            </Pressable>
          ))}
        </ScrollView>
      ) : (
        <T variant="small" tone="mut">No other exercise in this workout yet.</T>
      )}
      <Button title="Add a new exercise" variant="secondary" small onPress={onAdd} />
      {letter ? <Button title="Unlink" variant="danger" small onPress={onUnlink} /> : null}
    </QuickView>
  );
}

/**
 * The exercises of one superset drawn as a block: a small "⟲ SUPERSET A" label, and an accent rail
 * down the left gutter joining the cards, which sit closer together than the rest of the list.
 */
export function SupersetRail({ letter, children }: { letter: string; children: ReactNode }) {
  const { palette } = useTheme();
  return (
    <View style={{ gap: space.xs }}>
      <T variant="tiny" tone="accent" weight="800" style={{ letterSpacing: 1 }}>{SUPERSET_GLYPH} SUPERSET {letter}</T>
      <View style={{ flexDirection: 'row' }}>
        {/* the rail lives in the page's left gutter, so the cards keep their full width */}
        <View style={{ width: space.lg - 4, marginLeft: -(space.lg - 4), alignItems: 'center' }}>
          <View style={{ flex: 1, width: 3, borderRadius: 2, backgroundColor: palette.accent, opacity: 0.7 }} />
        </View>
        <View style={{ flex: 1, gap: space.xs }}>{children}</View>
      </View>
    </View>
  );
}
