import { useQuery } from '@tanstack/react-query';
import type { PayMethodDto } from '@niinas/shared';
import { api } from './api';

export const METHODS_KEY = ['payment-methods'] as const;

/** Every way of paying, switched off ones included (old records can still point at them). */
export function useMethods() {
  return useQuery({
    queryKey: METHODS_KEY,
    queryFn: () => api<{ methods: PayMethodDto[] }>('/payment-methods'),
    select: (d) => d.methods,
    staleTime: 60_000,
  });
}

/** The methods that can be picked for a new payment, expense or payout, and the one to start on. */
export function useActiveMethods() {
  const query = useMethods();
  const active = (query.data ?? []).filter((m) => m.active);
  return { ...query, active, first: active[0] ?? null };
}
