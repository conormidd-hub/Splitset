import { router } from 'expo-router';
import { Pressable, View } from 'react-native';

import type { RecoveryMap, SessionMap } from '@/api/recovery';
import { useThresholds, useTrainNext } from '@/api/recovery';
import { Card } from '@/components/ui/Card';
import { T } from '@/components/ui/T';
import { fmtHours } from '@/lib/recovery/engine';
import type { MuscleId } from '@/lib/recovery/library';
import { nextReady, sessionRows } from '@/lib/recovery/screens';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, space } from '@/theme/tokens';

function Swatch({ colour }: { colour: string }) {
  const { palette } = useTheme();
  return <View style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: colour, borderWidth: 1, borderColor: palette.hair }} />;
}

/** "Next ready": muscles becoming trainable in the next 24 h, soonest first. */
export function NextReadyStrip({ map, nameOf }: { map: RecoveryMap; nameOf: (id: MuscleId) => string }) {
  const c = useThresholds();
  const { palette, name } = useTheme();
  const items = nextReady(c, map);
  return (
    <Card title="Next ready" subtitle="Trainable again within 24 h">
      {items.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {items.map((r) => (
            <View
              key={r.muscle}
              accessible
              accessibilityLabel={`${nameOf(r.muscle)}, ${r.label}, trainable in ${fmtHours(r.in_h)}`}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: palette.surface2, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 6 }}>
              <Swatch colour={name === 'night' ? map[r.muscle].fill_dark : map[r.muscle].fill} />
              <T variant="small" weight="600">{nameOf(r.muscle)}</T>
              <T variant="small" tone="mut">{fmtHours(r.in_h)}</T>
            </View>
          ))}
        </View>
      ) : (
        <T variant="small" tone="mut">Nothing becomes trainable in the next 24 h: everything is either trainable already or needs longer.</T>
      )}
    </Card>
  );
}

/** Train next: Ready muscles, biggest body regions first, each with three exercises where it is
 *  primary. Tapping an exercise opens it. */
export function TrainNextCard({ map, nameOf }: { map: RecoveryMap; nameOf: (id: MuscleId) => string }) {
  const { palette } = useTheme();
  const next = useTrainNext(map);
  if (!next) return null;
  return (
    <Card title="Train next" subtitle="Ready muscles, biggest first">
      {next.length ? (
        <View style={{ gap: space.md }}>
          {next.map((t) => (
            <View key={t.muscle} style={{ gap: 4 }}>
              <T variant="small" weight="700">{nameOf(t.muscle)} <T variant="tiny" tone="mut">{t.group}</T></T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
                {t.exercises.map((e) => (
                  <Pressable
                    key={e.id}
                    onPress={() => router.push(`/lift/exercises/${e.id}`)}
                    accessibilityRole="button"
                    hitSlop={4}
                    style={({ pressed }) => ({ backgroundColor: palette.surface2, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 10, opacity: pressed ? 0.7 : 1 })}>
                    <T variant="small" tone="ink2">{e.name}</T>
                  </Pressable>
                ))}
              </View>
            </View>
          ))}
        </View>
      ) : (
        <T variant="small" tone="mut">No muscle is fully ready yet.</T>
      )}
    </Card>
  );
}

/** The workout summary's rows: "Chest · load 2.48 · High · trainable in 24 h · ready in 2.2 days". */
export function SessionMuscleRows({ session, nameOf }: { session: SessionMap; nameOf: (id: MuscleId) => string }) {
  const { palette, name } = useTheme();
  const rows = sessionRows(session, nameOf);
  if (!rows.length) return <T variant="small" tone="mut">No scored sets, so no muscle took load.</T>;
  return (
    <View>
      {rows.map((r, i) => (
        <View key={r.muscle} style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 8, borderTopWidth: i ? 1 : 0, borderTopColor: palette.hair }}>
          <Swatch colour={name === 'night' ? session[r.muscle].fill_dark : session[r.muscle].fill} />
          <T variant="small" style={{ flex: 1 }}>{r.text}</T>
        </View>
      ))}
    </View>
  );
}
