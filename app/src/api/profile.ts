import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { keys } from './keys';
import { useUserId } from '@/lib/session';
import type { Units } from '@/lib/units';
import { supabase } from '@/lib/supabase';
import type { Tables, TablesUpdate } from '@/types/database';

export type Profile = Tables<'profiles'>;
/** The columns a signed-in user may change (profiles grants update on exactly these). */
export type ProfilePatch = Pick<
  TablesUpdate<'profiles'>,
  'display_name' | 'timezone' | 'units' | 'birth_year' | 'sex' | 'onboarded_at' | 'home_layout' | 'bodyweight_kg' | 'bodyweight_updated_at'
  | 'rest_timer_on' | 'rest_seconds' | 'home_lat' | 'home_lng' | 'home_label'
>;

export function useProfile() {
  const uid = useUserId();
  return useQuery({
    queryKey: keys.profile(uid),
    enabled: !!uid,
    queryFn: async (): Promise<Profile> => {
      const { data, error } = await supabase.from('profiles').select('*').eq('id', uid).single();
      if (error) throw error;
      return data;
    },
  });
}

/** Display units with a metric fallback while the profile loads. */
export function useUnits(): Units {
  const { data } = useProfile();
  return data?.units === 'imperial' ? 'imperial' : 'metric';
}

/** The rest timer's settings: whether a new workout starts with it on, and its default length.
 *  Off and 90 s until the profile has loaded (or before the columns exist). */
export function useRestSettings(): { on: boolean; seconds: number } {
  const { data } = useProfile();
  return { on: data?.rest_timer_on ?? false, seconds: data?.rest_seconds ?? 90 };
}

export function useUpdateProfile() {
  const uid = useUserId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: ProfilePatch) => {
      const { error } = await supabase.from('profiles').update(patch).eq('id', uid);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.profile(uid) }),
  });
}

export function useDeleteAccount() {
  return useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('delete_my_account');
      if (error) throw error;
      await supabase.auth.signOut();
    },
  });
}
