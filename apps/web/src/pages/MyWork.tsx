import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatGHS, type CommissionLedger } from '@niinas/shared';
import { EmptyRow, FormError, PAGE, ShowMore, SkeletonRows, errorMessage } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { LedgerRow } from './Commissions';

/** An attendant's own screen: what they are owed, and the washes and payouts behind it. Nothing about anyone else. */
export function MyWork() {
  const { user } = useAuth();
  const [limit, setLimit] = useState(PAGE);
  const query = useQuery({
    queryKey: ['commissions', 'mine', limit],
    queryFn: () => api<{ ledger: CommissionLedger | null }>(`/commissions/mine?limit=${limit}`),
    refetchInterval: 60_000,
    placeholderData: (previous) => previous,
  });
  const ledger = query.data?.ledger;

  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col gap-3 lg:gap-4">
      {query.isPending && <SkeletonRows count={3} />}
      <FormError message={query.isError ? errorMessage(query.error) : null} />
      {query.isSuccess && !ledger && (
        <p className="rounded-[14px] bg-surface p-4 text-ink-2 shadow-card lg:rounded-none lg:border lg:border-line lg:shadow-none">
          {user?.name}, your login is not linked to an attendant yet. Ask the manager to set it up.
        </p>
      )}
      {ledger && (
        <>
          <section aria-label="What you are owed" className="flex flex-col gap-3 rounded-[14px] bg-surface p-4 shadow-card lg:rounded-none lg:border lg:border-line lg:p-5 lg:shadow-none">
            <p className="text-xs font-medium text-ink-3">Owed to you</p>
            <p className="display num text-[34px] leading-none text-navy">{formatGHS(ledger.owed)}</p>
            <dl className="num flex gap-6 text-sm text-ink-2">
              <div>
                <dt className="text-xs text-ink-3">Earned</dt>
                <dd>{formatGHS(ledger.earned)}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-3">Paid out</dt>
                <dd>{formatGHS(ledger.paidOut)}</dd>
              </div>
            </dl>
          </section>
          <section aria-label="Your washes and payouts" className="overflow-hidden rounded-[14px] bg-surface shadow-card lg:rounded-none lg:border lg:border-line lg:shadow-none">
            <h2 className="border-b border-line px-4 py-3 text-sm font-medium text-ink-2">Recent</h2>
            {ledger.entries.length === 0 ? (
              <EmptyRow>Nothing yet. Washes show here once the car is marked complete.</EmptyRow>
            ) : (
              <ul className="divide-y divide-line-2">
                {ledger.entries.map((e) => (
                  <LedgerRow key={`${e.type}-${e.id}`} entry={e} />
                ))}
              </ul>
            )}
            <ShowMore shown={ledger.entries.length} total={ledger.total} busy={query.isFetching} onMore={() => setLimit((n) => n + PAGE)} />
          </section>
        </>
      )}
    </div>
  );
}
