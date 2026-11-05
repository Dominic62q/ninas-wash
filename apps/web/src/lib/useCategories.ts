import { useQuery } from '@tanstack/react-query';
import type { ExpenseCategoryDto } from '@niinas/shared';
import { api } from './api';

export const CATEGORIES_KEY = ['expense-categories'] as const;

/** Every expense category, switched off ones included. */
export function useExpenseCategories() {
  return useQuery({
    queryKey: CATEGORIES_KEY,
    queryFn: () => api<{ categories: ExpenseCategoryDto[] }>('/expense-categories'),
    select: (d) => d.categories,
    staleTime: 60_000,
  });
}

/** The categories that can be picked for a new expense. */
export function useActiveCategories() {
  const query = useExpenseCategories();
  return { ...query, active: (query.data ?? []).filter((c) => c.active) };
}
