import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { REPORT_MAX_DAYS, formatAmount, formatGHS, type ReportDto } from '@niinas/shared';
import { useToast } from '../components/Toast';
import { EmptyRow, Field, FormError, Pill, SkeletonRows, errorMessage } from '../components/ui';
import { api } from '../lib/api';
import { cedis, downloadCsv, type CsvCell } from '../lib/csv';
import { addDays, dayName, plural, ymd } from '../lib/format';

const startOfMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const endOfMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));

const RANGES = [
  { value: 'week', label: 'Last 7 days', span: (now: Date) => [addDays(now, -6), now] },
  { value: 'month', label: 'Last 30 days', span: (now: Date) => [addDays(now, -29), now] },
  { value: 'this', label: 'This month', span: (now: Date) => [startOfMonth(now), now] },
  { value: 'last', label: 'Last month', span: (now: Date) => {
    const prev = addDays(startOfMonth(now), -1);
    return [startOfMonth(prev), endOfMonth(prev)];
  } },
  { value: 'custom', label: 'Pick dates', span: (now: Date) => [addDays(now, -6), now] },
] as const;
type Range = (typeof RANGES)[number]['value'];

interface Col<T> {
  head: string;
  /** Amounts and counts line up on the right. */
  num?: boolean;
  /** `value` is pesewas: shown as GH₵ on screen and as a plain number in the CSV. */
  money?: boolean;
  /** What the cell holds, for the screen and for the CSV. */
  value: (row: T) => string | number;
  /** A richer cell on screen only (a link, a pill). */
  show?: (row: T) => ReactNode;
}

interface Spec<T> {
  label: string;
  cols: Col<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** One value per column, for the total row. */
  foot?: (string | number)[];
  empty?: string;
}

/** A table together with the CSV rows it was drawn from, so what you see is what you export. */
interface Part {
  label: string;
  node: ReactNode;
  csv: () => CsvCell[][];
}

interface Section {
  title: string;
  aside?: string;
  parts: Part[];
}

/** `bare`: a table with several amount columns drops the GH₵ sign from each cell (its card says GH₵), so it fits a phone. */
const text = <T,>(c: Col<T>, v: string | number, bare = false) => (c.money && typeof v === 'number' ? (bare ? formatAmount(v) : formatGHS(v)) : String(v));

/** Every report is a plain table: a row per thing, amounts on the right, a total row at the foot when it adds up. */
function ReportTable<T>({ label, cols, rows, rowKey, foot }: Spec<T>) {
  const align = (num?: boolean) => (num ? 'text-right' : 'text-left');
  const bare = cols.filter((c) => c.money).length > 1;
  return (
    <div className="overflow-x-auto">
      <table aria-label={label} className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-band">
            {cols.map((c) => (
              <th key={c.head} scope="col" className={`whitespace-nowrap px-2.5 first:pl-4 last:pr-4 lg:px-4 py-2 text-xs font-medium text-ink-3 ${align(c.num)}`}>
                {c.head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className="border-t border-line-2">
              {cols.map((c, i) => {
                const cell = c.show ? c.show(row) : text(c, c.value(row), bare);
                return i === 0 ? (
                  <th key={c.head} scope="row" className="px-2.5 first:pl-4 last:pr-4 lg:px-4 py-2.5 text-left font-medium text-ink">
                    {cell}
                  </th>
                ) : (
                  <td key={c.head} className={`num whitespace-nowrap px-2.5 first:pl-4 last:pr-4 lg:px-4 py-2.5 text-ink-2 ${align(c.num)}`}>
                    {cell}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        {foot && (
          <tfoot>
            <tr className="border-t-2 border-line bg-band font-medium text-ink">
              {cols.map((c, i) =>
                i === 0 ? (
                  <th key={c.head} scope="row" className="px-2.5 first:pl-4 last:pr-4 lg:px-4 py-2.5 text-left">
                    {text(c, foot[i]!, bare)}
                  </th>
                ) : (
                  <td key={c.head} className={`num whitespace-nowrap px-2.5 first:pl-4 last:pr-4 lg:px-4 py-2.5 ${align(c.num)}`}>
                    {text(c, foot[i]!, bare)}
                  </td>
                ),
              )}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function part<T>(spec: Spec<T>): Part {
  const cell = (c: Col<T>, v: string | number): CsvCell => (c.money && typeof v === 'number' ? cedis(v) : v);
  return {
    label: spec.label,
    node: spec.rows.length === 0 && spec.empty ? <EmptyRow>{spec.empty}</EmptyRow> : <ReportTable {...spec} />,
    csv: () =>
      spec.rows.length === 0
        ? []
        : [
            spec.cols.map((c) => (c.money ? `${c.head} (GH₵)` : c.head)),
            ...spec.rows.map((row) => spec.cols.map((c) => cell(c, c.value(row)))),
            ...(spec.foot ? [spec.cols.map((c, i) => cell(c, spec.foot![i]!))] : []),
          ],
  };
}

const sum = <T,>(rows: T[], pick: (row: T) => number) => rows.reduce((n, row) => n + pick(row), 0);

/** Short names for the tabs. */
const TAB: Record<string, string> = { Summary: 'Summary', 'Takings by day': 'Takings', Cars: 'Cars', 'Who earned': 'Staff', Spending: 'Spending', 'The drawer': 'Drawer' };

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function sections(r: ReportDto): Section[] {
  const daysToLookAt = [
    ...r.cash.notClosed.map((day) => ({ key: `n-${day}`, day, difference: null as number | null })),
    ...r.cash.differences.map((x) => ({ key: `d-${x.day}`, day: x.day, difference: x.difference as number | null })),
  ];
  const outcome = (x: (typeof daysToLookAt)[number]) => (x.difference === null ? 'Never closed' : x.difference < 0 ? `${formatGHS(-x.difference)} short` : `${formatGHS(x.difference)} over`);

  return [
    {
      title: 'Summary',
      parts: [
        part({
          label: 'Summary',
          rowKey: (x) => x.label,
          cols: [
            { head: 'Item', value: (x) => x.label },
            { head: 'Amount', num: true, money: true, value: (x) => x.amount },
          ],
          rows: [
            { label: 'Taken', amount: r.takings.total },
            { label: 'Spent', amount: r.expenses.total },
            { label: 'Commission earned', amount: r.commission.earned },
            { label: 'Left over (taken, less spending and commission)', amount: r.net },
          ],
        }),
      ],
    },
    {
      title: 'Takings by day',
      aside: `GH₵ · ${plural(r.takings.payments, 'payment')}`,
      parts: [
        part({
          label: 'Takings by day',
          rowKey: (d) => d.day,
          cols: [
            { head: 'Day', value: (d) => dayName(d.day) },
            { head: 'Cash', num: true, money: true, value: (d) => d.cash },
            { head: 'MoMo', num: true, money: true, value: (d) => d.momo },
            { head: 'Total', num: true, money: true, value: (d) => d.total },
          ],
          rows: r.byDay,
          foot: ['Total', r.takings.cash, r.takings.momo, r.takings.total],
        }),
      ],
    },
    {
      title: 'Cars',
      aside: plural(r.jobs.count, 'car'),
      parts: [
        part({
          label: 'Cars',
          rowKey: (x) => x.label,
          cols: [
            { head: 'Item', value: (x) => x.label },
            { head: 'Amount', num: true, money: true, value: (x) => x.amount },
          ],
          rows: [
            { label: 'Sold', amount: r.jobs.sales },
            { label: 'Discounts', amount: r.jobs.discounts },
            { label: 'After discounts', amount: r.jobs.net },
            { label: 'Average car', amount: r.jobs.average },
            { label: r.jobs.owing.count > 0 ? `Still owed (${plural(r.jobs.owing.count, 'finished car')})` : 'Still owed', amount: r.jobs.owing.amount },
          ],
        }),
        part({
          label: 'By service',
          empty: 'No cars in this period',
          rowKey: (s) => s.name,
          cols: [
            { head: 'Service', value: (s) => s.name },
            { head: 'Times', num: true, value: (s) => s.count },
            { head: 'Sold', num: true, money: true, value: (s) => s.sales },
          ],
          rows: r.byService,
          foot: ['Total', sum(r.byService, (s) => s.count), sum(r.byService, (s) => s.sales)],
        }),
      ],
    },
    {
      title: 'Who earned',
      aside: `Paid out ${formatGHS(r.commission.paidOut)}`,
      parts: [
        part({
          label: 'Who earned',
          empty: 'No commission earned in this period',
          rowKey: (x) => x.name,
          cols: [
            { head: 'Attendant', value: (x) => x.name },
            { head: 'Cars', num: true, value: (x) => x.cars },
            { head: 'Earned', num: true, money: true, value: (x) => x.earned },
          ],
          rows: r.byAttendant,
          foot: ['Total', sum(r.byAttendant, (x) => x.cars), sum(r.byAttendant, (x) => x.earned)],
        }),
      ],
    },
    {
      title: 'Spending',
      aside: r.expenses.withoutReceipt > 0 ? `${plural(r.expenses.withoutReceipt, 'expense')} with no receipt` : undefined,
      parts: [
        part({
          label: 'Spending',
          empty: 'Nothing was spent in this period',
          rowKey: (c) => c.category,
          cols: [
            { head: 'Category', value: (c) => c.category },
            { head: 'Entries', num: true, value: (c) => c.count },
            { head: 'Amount', num: true, money: true, value: (c) => c.amount },
          ],
          rows: r.expenses.byCategory,
          foot: ['Total', sum(r.expenses.byCategory, (c) => c.count), sum(r.expenses.byCategory, (c) => c.amount)],
        }),
      ],
    },
    {
      title: 'The drawer',
      aside: plural(r.cash.closedDays, 'day') + ' closed',
      parts: [
        part({
          label: 'The drawer',
          rowKey: (x) => x.label,
          cols: [
            { head: 'Closed days', value: (x) => x.label },
            { head: 'Days', num: true, value: (x) => x.days },
          ],
          rows: [
            { label: 'Balanced', days: r.cash.balanced },
            { label: 'Short', days: r.cash.short },
            { label: 'Over', days: r.cash.over },
          ],
        }),
        part({
          label: 'Days to look at',
          empty: 'Every closed day balanced and no day was missed',
          rowKey: (x) => x.key,
          cols: [
            {
              head: 'Day',
              value: (x) => dayName(x.day),
              show: (x) => (
                <Link to={`/daily-close?day=${x.day}`} className="text-blue-d no-underline hover:underline">
                  {dayName(x.day)}
                </Link>
              ),
            },
            {
              head: 'What happened',
              num: true,
              value: outcome,
              show: (x) => (x.difference === null ? <Pill tone="amber">Never closed</Pill> : x.difference < 0 ? <Pill tone="amber">{outcome(x)}</Pill> : <Pill tone="blue">{outcome(x)}</Pill>),
            },
          ],
          rows: daysToLookAt,
        }),
      ],
    },
  ];
}

function ExportButton({ label, onClick, className = '' }: { label: string; onClick: () => void; className?: string }) {
  return (
    <button type="button" onClick={onClick} className={`btn h-9 shrink-0 gap-1.5 px-3 text-sm ${className}`}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 4v11M7 11l5 5 5-5M5 20h14" />
      </svg>
      {label}
    </button>
  );
}

export function Reports() {
  const toast = useToast();
  const [range, setRange] = useState<Range>('week');
  const now = new Date();
  const [pickFrom, setPickFrom] = useState(() => ymd(addDays(now, -6)));
  const [pickTo, setPickTo] = useState(() => ymd(now));

  const spec = RANGES.find((r) => r.value === range)!;
  const [a, b] = spec.span(now) as [Date, Date];
  const from = range === 'custom' ? pickFrom : ymd(a);
  const to = range === 'custom' ? pickTo : ymd(b);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to);
  const days = valid ? Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1 : 0;
  const rangeError = !valid ? 'Pick both dates' : days < 1 ? 'The end date is before the start date' : days > REPORT_MAX_DAYS ? `Pick at most ${REPORT_MAX_DAYS} days` : null;

  const query = useQuery({
    queryKey: ['report', from, to],
    queryFn: () => api<ReportDto>(`/reports?from=${from}&to=${to}`),
    enabled: !rangeError,
    placeholderData: (previous) => previous,
  });
  const r = query.data;
  const all = r ? sections(r) : [];
  const [tab, setTab] = useState('Summary');
  const current = all.find((x) => x.title === tab) ?? all[0];

  const exportOne = (s: Section) => {
    if (!r) return;
    const rows = s.parts.flatMap((p, i) => {
      const part = p.csv();
      return part.length > 0 && i > 0 ? [[], [p.label], ...part] : part;
    });
    if (rows.length === 0) {
      toast.error(`Nothing to export for ${s.title.toLowerCase()}.`);
      return;
    }
    downloadCsv(`niinas-${slug(s.title)}-${r.from}-to-${r.to}.csv`, rows);
    toast.success(`${s.title} saved as CSV.`);
  };

  const exportAll = () => {
    if (!r) return;
    const rows: CsvCell[][] = [['Niinas Wash report'], ['From', r.from], ['To', r.to]];
    for (const s of all) {
      for (const p of s.parts) {
        const part = p.csv();
        if (part.length === 0) continue;
        rows.push([], [p.label], ...part);
      }
    }
    downloadCsv(`niinas-report-${r.from}-to-${r.to}.csv`, rows);
    toast.success('Report saved as CSV');
  };

  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-col gap-3 lg:gap-4">
      <div className="flex items-center gap-2">
        <div role="radiogroup" aria-label="Period" className="flex min-w-0 flex-1 gap-2 overflow-x-auto max-lg:-ml-4 max-lg:pl-4">
          {RANGES.map((x) => (
            <button
              key={x.value}
              type="button"
              role="radio"
              aria-checked={range === x.value}
              onClick={() => setRange(x.value)}
              className={`btn h-9 shrink-0 px-3 text-sm ${range === x.value ? 'border-blue bg-blue-50 text-blue-d' : ''}`}
            >
              {x.label}
            </button>
          ))}
        </div>
        {r && <ExportButton label="Export all" onClick={exportAll} className="hidden lg:inline-flex" />}
      </div>

      {range === 'custom' && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="From">
            <input type="date" className="input" value={pickFrom} max={pickTo} onChange={(e) => setPickFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <input type="date" className="input" value={pickTo} min={pickFrom} max={ymd(now)} onChange={(e) => setPickTo(e.target.value)} />
          </Field>
        </div>
      )}

      <FormError message={rangeError ?? (query.isError ? errorMessage(query.error) : null)} />

      {!r ? (
        rangeError ? null : (
          <div className="border border-line bg-surface max-lg:overflow-hidden max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card">
            <SkeletonRows count={5} />
          </div>
        )
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-ink-3">
              {dayName(r.from)} to {dayName(r.to)} · {plural(r.days, 'day')}
            </p>
            <ExportButton label="Export all" onClick={exportAll} className="lg:hidden" />
          </div>

          <div role="tablist" aria-label="Reports" className="flex overflow-x-auto border-b border-line">
            {all.map((s) => {
              const on = s.title === current?.title;
              return (
                <button
                  key={s.title}
                  type="button"
                  role="tab"
                  id={`tab-${slug(s.title)}`}
                  aria-selected={on}
                  aria-controls={`panel-${slug(s.title)}`}
                  tabIndex={on ? 0 : -1}
                  onClick={() => setTab(s.title)}
                  onKeyDown={(e) => {
                    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
                    if (!step) return;
                    e.preventDefault();
                    const next = all[(all.indexOf(s) + step + all.length) % all.length]!;
                    setTab(next.title);
                    document.getElementById(`tab-${slug(next.title)}`)?.focus();
                  }}
                  className={`-mb-px flex-1 shrink-0 cursor-pointer whitespace-nowrap border-b-[3px] px-0.5 py-2.5 text-[13px] font-medium lg:px-3.5 lg:text-sm ${on ? 'border-blue text-blue-d' : 'border-transparent text-ink-3 hover:text-ink'}`}
                >
                  {TAB[s.title] ?? s.title}
                </button>
              );
            })}
          </div>

          {current && (
            <section
              key={current.title}
              role="tabpanel"
              id={`panel-${slug(current.title)}`}
              aria-labelledby={`tab-${slug(current.title)}`}
              className="border border-line bg-surface max-lg:overflow-hidden max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card"
            >
              <div className="flex items-baseline justify-between gap-3 border-b border-line px-4 py-2.5">
                <h3 className="text-sm font-medium text-ink-2">{current.title}</h3>
                <div className="flex items-baseline gap-3">
                  {current.aside && <p className="text-sm text-ink-2">{current.aside}</p>}
                  <button type="button" onClick={() => exportOne(current)} aria-label={`Export ${current.title} as CSV`} className="tap -my-2.5 -mr-3 text-sm text-blue-d">
                    CSV
                  </button>
                </div>
              </div>
              {current.parts.map((p, i) => (
                <div key={p.label} className={i > 0 ? 'border-t-2 border-line' : ''}>
                  {i > 0 && <h4 className="bg-surface px-4 pb-1 pt-3 text-sm font-medium text-ink-2">{p.label}</h4>}
                  {p.node}
                </div>
              ))}
            </section>
          )}

          <p className="px-1 text-xs text-ink-3">
            Tips of {formatGHS(r.tips.held + r.tips.direct)} belong to the attendants and are not counted above. Taken is money received in the period.
          </p>
        </>
      )}
    </div>
  );
}
