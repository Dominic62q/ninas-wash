import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router';
import { formatGHS, type ReceiptDto } from '@niinas/shared';
import logoDark from '../assets/niinas-logo-tight-dark.png';
import logo from '../assets/niinas-logo-tight.png';
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
    <main className="min-h-screen bg-band px-4 py-8 print:min-h-0 print:bg-white print:p-0">
      {/* One A5 page, the same size as the PDF. A full-height page would spill a blank second sheet. */}
      <style>{'@media print { @page { size: A5; margin: 12mm; } }'}</style>
      <div className="mx-auto flex w-full max-w-[420px] flex-col gap-4">
        <div className="overflow-hidden border border-line bg-surface max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card print:border-0 print:shadow-none">
          {/* The brand bar: blue, with a short red sweep at the end, like the paper receipt. */}
          <div aria-hidden className="flex h-[6px]">
            <span className="flex-1 bg-[#036fdb]" />
            <span className="w-[22%] bg-[#f3020b]" />
          </div>
          <div className="p-5 print:px-0">
            <div className="flex items-start justify-between gap-3">
              <div className="w-[150px] flex-none">
                <img src={logo} alt="Niinas Wash: interior, exterior, deep clean" width={150} className="logo-light h-auto w-full" />
                <img src={logoDark} alt="Niinas Wash: interior, exterior, deep clean" width={150} className="logo-dark h-auto w-full" />
              </div>
              {r && (
                <div className="min-w-0 text-right">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-3">Receipt</p>
                  <p className="display num text-lg leading-tight text-navy">{r.number}</p>
                  <p className="num mt-0.5 text-xs text-ink-3">{shortDateTime(r.at)}</p>
                </div>
              )}
            </div>
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
                <div className="mt-4 flex items-center justify-between gap-3 border-l-4 border-l-[#036fdb] bg-band px-4 py-3 max-lg:rounded-r-[10px]">
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-3">{r.plate ? 'Vehicle' : 'Customer'}</p>
                    <div className="mt-1">
                      <Plate plate={r.plate} size="lg" walkIn="Walk-in customer" />
                    </div>
                  </div>
                  <span
                    className={`flex-none rounded-full px-3 py-1 text-xs font-semibold text-white ${
                      r.voided ? 'bg-red' : r.balance > 0 ? 'bg-amber' : 'bg-green'
                    }`}
                  >
                    {r.voided ? 'Cancelled' : r.balance > 0 ? 'Part paid' : 'Paid in full'}
                  </span>
                </div>
                {r.voided && <p className="mt-4 border-l-4 border-red bg-red-50 px-3 py-2.5 text-sm text-red-d">This job was cancelled. Nothing is owed.</p>}

                <div className="mt-5 flex items-center justify-between border-b-2 border-navy pb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-3">
                  <span className="flex-1">Item</span>
                  <span className="w-12 text-right">Qty</span>
                  <span className="w-24 text-right">Amount</span>
                </div>
                <ul className="divide-y divide-line-2">
                  {r.lines.map((l, i) => (
                    <li key={i} className="flex items-baseline justify-between gap-3 py-3">
                      <span className="min-w-0 flex-1 text-ink">{l.name}</span>
                      <span className="num w-12 text-right text-ink-3">{l.quantity}</span>
                      <span className="num w-24 text-right font-medium text-ink">{formatGHS(l.price)}</span>
                    </li>
                  ))}
                </ul>

                <dl className="num mt-3 flex flex-col gap-1 text-sm sm:ml-auto sm:max-w-[260px]">
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
                  <div className="mt-1 flex items-center justify-between bg-[#1c2d4f] px-4 py-3 text-white max-lg:rounded-[10px]">
                    <dt className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#c9d6ee]">Total</dt>
                    <dd className="display text-[26px] leading-none">{formatGHS(r.total)}</dd>
                  </div>
                  {!r.voided && (
                    <>
                      <div className="flex justify-between pt-2 text-ink-2">
                        <dt>Paid</dt>
                        <dd>{formatGHS(r.paid)}</dd>
                      </div>
                      {r.balance > 0 && (
                        <div className="flex justify-between font-medium text-amber">
                          <dt>Still to pay</dt>
                          <dd>{formatGHS(r.balance)}</dd>
                        </div>
                      )}
                    </>
                  )}
                </dl>
                <p className="mt-6 border-t border-line pt-4 text-center text-sm text-ink-3">Thank you for choosing Niinas Wash</p>
              </>
            )}
          </div>
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
