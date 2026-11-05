import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { can as roleCan, type LoginInput, type Permission, type SessionUser } from '@niinas/shared';
import { useToast } from '../components/Toast';
import { ApiError, api } from './api';

interface Me {
  user: SessionUser;
  permissions: Permission[];
}

interface AuthState {
  /** True until we know whether anyone is signed in. */
  loading: boolean;
  user: SessionUser | null;
  /** Everything this person may do, as the server sees it right now. */
  permissions: Permission[];
  /** The server could not be reached, so we do not know. */
  offline: boolean;
  can: (permission: Permission) => boolean;
  login: (input: LoginInput) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);
const ME_KEY = ['me'] as const;

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const toast = useToast();

  const me = useQuery({
    queryKey: ME_KEY,
    queryFn: async (): Promise<Me | null> => {
      try {
        return await api<Me>('/auth/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
    retry: false,
  });

  const loginMutation = useMutation({
    mutationFn: (input: LoginInput) => api<Me>('/auth/login', { method: 'POST', body: input }),
    onSuccess: (data) => queryClient.setQueryData(ME_KEY, data),
  });

  const logoutMutation = useMutation({
    mutationFn: () => api<{ ok: true }>('/auth/logout', { method: 'POST' }),
    onSettled: () => {
      // Whatever happened, drop everything we cached for the last person.
      queryClient.clear();
      queryClient.setQueryData(ME_KEY, null);
    },
  });

  const value = useMemo<AuthState>(() => {
    const user = me.data?.user ?? null;
    return {
      loading: me.isPending,
      user,
      permissions: me.data?.permissions ?? [],
      offline: me.error instanceof ApiError && me.error.isOffline,
      // The server decides for real. This only hides buttons people cannot use.
      can: (permission) => (me.data ? roleCan(me.data.permissions, permission) : false),
      login: async (input) => {
        await loginMutation.mutateAsync(input);
      },
      logout: async () => {
        await logoutMutation.mutateAsync().catch(() => undefined);
        toast.success('Signed out');
      },
    };
  }, [me.data, me.isPending, me.error, loginMutation, logoutMutation, toast]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
