import { SymbolView } from 'expo-symbols';
import { useMemo, useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { T } from './T';
import { TextField } from './TextField';
import { ICONS, type IconKey } from '@/lib/icons';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

export type PickOption = {
  id: string;
  label: string;
  subtitle?: string;
  icon?: IconKey;
  /** Already chosen: shown ticked and not chosen again. */
  added?: boolean;
  /** Greyed out, with the subtitle saying why. */
  disabled?: boolean;
};
export type PickSection = { title?: string; options: readonly PickOption[] };

const WIDE = 640;

/**
 * A bottom sheet of choices in titled sections (a centred card on a wide screen), searchable when
 * `search` names what it searches. `closeOnPick` closes it on a choice; otherwise it stays open so
 * several can be added in a row, each ticked as it goes. `children` sit above the list.
 */
export function PickSheet({ visible, title, sections, onPick, onClose, search, closeOnPick = false, children }: {
  visible: boolean; title: string; sections: readonly PickSection[]; onPick: (id: string) => void; onClose: () => void;
  search?: string; closeOnPick?: boolean; children?: ReactNode;
}) {
  const { palette, name } = useTheme();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const wide = width >= WIDE;
  const [query, setQuery] = useState('');
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sections.filter((s) => s.options.length);
    return sections
      .map((s) => ({ ...s, options: s.options.filter((o) => `${o.label} ${o.subtitle ?? ''}`.toLowerCase().includes(q)) }))
      .filter((s) => s.options.length);
  }, [sections, query]);
  const close = () => { setQuery(''); onClose(); };
  const scrim = name === 'night' ? palette.bg : palette.ink;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close} aria-label={title}>
      <View style={{ flex: 1 }}>
        <View aria-hidden onStartShouldSetResponder={() => true} onResponderRelease={close}
          style={[StyleSheet.absoluteFill, { backgroundColor: scrim, opacity: 0.5 }]} />
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          accessibilityViewIsModal
          onAccessibilityEscape={close}
          style={{ flex: 1, justifyContent: wide ? 'center' : 'flex-end', alignItems: wide ? 'center' : 'stretch', pointerEvents: 'box-none' }}>
          <View style={{
            backgroundColor: palette.bg, maxHeight: '80%', width: wide ? 520 : undefined,
            borderRadius: wide ? radius.lg : 0, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
            borderWidth: 1, borderColor: palette.hair, paddingBottom: wide ? 0 : insets.bottom,
          }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg, paddingBottom: space.sm }}>
              <T variant="h2" accessibilityRole="header" style={{ flex: 1 }}>{title}</T>
              <Pressable onPress={close} accessibilityRole="button" accessibilityLabel="Close" hitSlop={8}
                style={({ pressed }) => ({ width: 32, height: 32, borderRadius: 16, backgroundColor: palette.surface2, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.7 : 1 })}>
                <SymbolView name={ICONS.close} tintColor={palette.ink2} size={16} />
              </Pressable>
            </View>
            {search ? (
              <View style={{ paddingHorizontal: space.lg, paddingBottom: space.sm }}>
                <TextField value={query} onChangeText={setQuery} placeholder={search} autoCapitalize="none" autoCorrect={false}
                  clearButtonMode="while-editing" accessibilityLabel={search} />
              </View>
            ) : null}
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: space.lg, gap: space.sm }}>
              {children}
              {shown.length ? shown.map((s, si) => (
                <View key={s.title ?? si}>
                  {s.title ? <T variant="label" tone="mut" style={{ paddingVertical: space.sm }}>{s.title}</T> : null}
                  <View style={{ backgroundColor: palette.surface, borderRadius: radius.md, borderWidth: 1, borderColor: palette.hair, paddingHorizontal: space.md }}>
                    {s.options.map((o, i) => {
                      const inert = o.disabled || o.added;
                      return (
                        <Pressable
                          key={o.id}
                          onPress={inert ? undefined : () => { onPick(o.id); if (closeOnPick) close(); }}
                          accessibilityRole="button"
                          accessibilityState={inert ? { disabled: true } : undefined}
                          accessibilityLabel={o.added ? `${o.label}, added` : o.disabled ? `${o.label}, not available` : o.label}
                          style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md,
                            borderTopWidth: i ? 1 : 0, borderTopColor: palette.hair, opacity: o.disabled ? 0.5 : pressed ? 0.7 : 1 })}>
                          {o.icon ? <SymbolView name={ICONS[o.icon]} tintColor={o.added ? palette.accent : palette.mut} size={20} /> : null}
                          <View style={{ flex: 1, gap: 2 }}>
                            <T variant="h3" numberOfLines={1}>{o.label}</T>
                            {o.subtitle ? <T variant="small" tone="mut" numberOfLines={2}>{o.subtitle}</T> : null}
                          </View>
                          {o.added ? (
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                              <SymbolView name={ICONS.check} tintColor={palette.pos} size={18} />
                              <T variant="small" tone="pos" weight="700">Added</T>
                            </View>
                          ) : o.disabled ? null : closeOnPick ? (
                            <SymbolView name={ICONS.chevron} tintColor={palette.mut} size={16} />
                          ) : (
                            <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: palette.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
                              <SymbolView name={ICONS.plus} tintColor={palette.accent} size={18} />
                            </View>
                          )}
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              )) : (
                <T tone="mut" align="center" style={{ paddingVertical: space.xl }}>{query.trim() ? `Nothing matches “${query.trim()}”.` : 'Nothing to add.'}</T>
              )}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}
