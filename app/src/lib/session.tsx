import type { Session } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { queryClient } from './query';
import { supabase } from './supabase';

type SessionState = {
  session: Session | null;
  isLoading: boolean;
  signOut: () => Promise<void>;
};

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (mounted) {
          setSession(data.session);
          setLoading(false);
        }
      })
      .catch(() => {
        if (mounted) setLoading(false);
      });
    // the query cache holds the last account's data (some of it keyed without a user), so a
    // sign-out, or a different account signing in, starts from an empty one
    let userId: string | undefined;
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      const nextId = next?.user.id;
      if (userId !== undefined && nextId !== userId) queryClient.clear();
      userId = nextId;
      setSession(next);
      setLoading(false);
    });
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const value = useMemo(() => ({ session, isLoading, signOut }), [session, isLoading, signOut]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}

/** The signed-in user's id. Screens under (app) can assume it is present. */
export function useUserId(): string {
  const { session } = useSession();
  return session?.user.id ?? '';
}
