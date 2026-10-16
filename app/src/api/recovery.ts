import { useQuery } from '@tanstack/react-query';

import { DEFAULT_THRESHOLDS } from '@/lib/recovery/constants';
import { thresholdsFor, type Thresholds } from '@/lib/recovery/thresholds';
import { useUserId } from '@/lib/session';
import { supabase } from '@/lib/supabase';

export const recoveryKeys = {
  thresholds: (uid: string) => ['thresholds', uid] as const,
};

/** The signed-in user's thresholds: the constants file with their user_thresholds rows on top.
 *  The defaults stand in while the overrides load, or if they fail to. */
export function useThresholds(): Thresholds {
  const uid = useUserId();
  const q = useQuery({
    queryKey: recoveryKeys.thresholds(uid),
    enabled: !!uid,
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from('user_thresholds').select('user_id, key, value').eq('user_id', uid);
      if (error) throw error;
      return thresholdsFor(DEFAULT_THRESHOLDS, uid, data);
    },
  });
  return q.data ?? DEFAULT_THRESHOLDS;
}
