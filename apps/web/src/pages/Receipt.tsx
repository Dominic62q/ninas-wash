import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router';
import { formatGHS, type ReceiptDto } from '@niinas/shared';
import { Plate } from '../components/Plate';
import { api, ApiError } from '../lib/api';
import { shortDateTime } from '../lib/format';

/** The page a customer opens from the link they were sent. No sign-in, and nothing on it but the bill. */
export function Receipt() {
  const { token = '' } = useParams();
  const [params] = useSearchParams();
  const query = useQuery({
    queryKey: ['receipt', token],
    queryFn: () => api<{ receipt: ReceiptDto }>(`/receipts/${encodeURIComponent(token)}`),
    retry: (count, error) => !(error instanceof ApiError && error.status < 500 && error.status !== 0) && count < 2,
  });
  const r = query.data?.receipt;

  // Opened from "Share receipt" on a computer: the print dialog is what was asked for.
  const printNow = params.get('print') === '1';
  useEffect(() => {
    if (!r || !printNow) return;
    const timer = window.setTimeout(() => window.print(), 400);
    return () => window.clearTimeout(timer);
  }, [r, printNow]);

  return (
    <main className="min-h-screen bg-band px-4 py-8 print:bg-white print:py-0">
      <div className="mx-auto flex w-full max-w-[420px] flex-col gap-4">
        <div className="border border-line bg-surface p-5 max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card print:border-0 print:p-0 print:shadow-none">
          <p className="display text-xl text-navy">Niinas Wash</p>
          {query.isPending && <div className="skeleton mt-6 h-40" />}
          {query.isError && (
            <p className="mt-6 text-ink-2">
              {query.error instanceof ApiError && query.error.status === 404
                ? 'This receipt link is not valid. Ask the wash to send it again.'
                : 'The receipt could not be loaded. Check the internet connection and try again.'}
            </p>
          )}
          {r && (
            <>
              <p className="mt-1 text-sm text-ink-3">Receipt {r.number}</p>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                <Plate plate={r.plate} size="lg" />
                <p className="text-sm text-ink-2">{shortDateTime(r.at)}</p>
              </div>
              {r.voided && <p className="mt-4 border-l-4 border-red bg-red-50 px-3 py-2.5 text-sm text-red-d">This job was cancelled. Nothing is owed.</p>}

              <ul className="mt-5 divide-y divide-line-2 border-y border-line">
                {r.lines.map((l, i) => (
                  <li key={i} className="flex items-baseline justify-between gap-3 py-3">
                    <span className="min-w-0 flex-1 text-ink">
                      {l.name}
                      {l.quantity > 1 && <span className="num text-ink-3"> × {l.quantity}</span>}
                    </span>
                    <span className="num font-medium text-ink">{formatGHS(l.price)}</span>
                  </li>
                ))}
              </ul>

              <dl className="num mt-3 flex flex-col gap-1 text-sm">
                {r.discount > 0 && (
                  <>
                    <div className="flex justify-between text-ink-2">
                      <dt>Subtotal</dt>
                      <dd>{formatGHS(r.subtotal)}</dd>
                    </div>
                    <div className="flex justify-between text-ink-2">
                      <dt>Discount</dt>
                      <dd>− {formatGHS(r.discount)}</dd>
                    </div>
                  </>
                )}
                <div className="flex items-baseline justify-between pt-1">
                  <dt className="font-medium text-ink">Total</dt>
                  <dd className="display text-[26px] leading-none text-navy">{formatGHS(r.total)}</dd>
                </div>
                {!r.voided && (
                  <>
                    <div className="flex justify-between pt-2 text-ink-2">
                      <dt>Paid</dt>
                      <dd>{formatGHS(r.paid)}</dd>
                    </div>
                    <div className={`flex justify-between font-medium ${r.balance > 0 ? 'text-amber' : 'text-green'}`}>
                      <dt>{r.balance > 0 ? 'Still to pay' : 'Paid in full'}</dt>
                      <dd>{r.balance > 0 ? formatGHS(r.balance) : ''}</dd>
                    </div>
                  </>
                )}
              </dl>
              <p className="mt-5 text-center text-sm text-ink-3">Thank you for choosing Niinas Wash</p>
            </>
          )}
        </div>
        {r && (
          <div className="flex flex-col gap-2 print:hidden">
            <a className="btn btn-primary" href={`/api/receipts/${encodeURIComponent(token)}/pdf`} download={`Receipt ${r.number}.pdf`}>
              Download PDF
            </a>
            <button type="button" className="btn" onClick={() => window.print()}>
              Print
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
