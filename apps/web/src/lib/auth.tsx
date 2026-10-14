import { createContext, useContext, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api';

export interface Me {
  id: string;
  email: string;
  personId: string | null;
  locale: 'de' | 'en';
  permissions: Record<string, string[]>;
  person: { firstName: string; lastName: string; preferredName: string | null } | null;
}

interface AuthState {
  me: Me | null;
  loading: boolean;
  can: (perm: string, scope?: 'all') => boolean;
  refresh: () => Promise<unknown>;
}

const Ctx = createContext<AuthState>({ me: null, loading: true, can: () => false, refresh: async () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api.get<Me>('/auth/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
  });
  const me = q.data ?? null;
  const can = (perm: string, scope?: 'all') => {
    const scopes = me?.permissions[perm] ?? [];
    return scope ? scopes.includes(scope) : scopes.length > 0;
  };
  return <Ctx.Provider value={{ me, loading: q.isLoading, can, refresh: () => qc.invalidateQueries({ queryKey: ['me'] }) }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
