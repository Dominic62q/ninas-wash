import type { IconName } from '../lib/nav';

const PATHS: Record<IconName, string> = {
  home: 'M3 11.5 12 4l9 7.5M5.5 10v9.5h13V10',
  jobs: 'M4 7h16M4 12h16M4 17h10',
  users: 'M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-3A3.5 3.5 0 0 0 6 17.5V19M11 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm9 8v-1.2a3 3 0 0 0-2.2-2.9',
  receipt: 'M6 3.5h12v17l-3-2-3 2-3-2-3 2v-17ZM9 8.5h6M9 12h6',
  coin: 'M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm0-11v6m-2-4.5h3a1.5 1.5 0 0 1 0 3h-2a1.5 1.5 0 0 0 0 3h3',
  lock: 'M6.5 11h11v8.5h-11V11Zm2-0V8a3.5 3.5 0 0 1 7 0v3',
  chart: 'M5 19.5V11m5 8.5V5m5 14.5v-6m5 6V9',
  tag: 'M3.5 12.5V4.5h8l9 9-8 8-9-9Zm4-5.5h.01',
  chat: 'M4.5 5.5h15v10.5H10l-4.5 3.5V16h-1V5.5ZM8.5 10.8h.01M12 10.8h.01M15.5 10.8h.01',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  history: 'M4 12a8 8 0 1 0 2.5-5.8M4 5v4h4M12 8v4l2.5 1.5',
  staff: 'M12 12a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-7 8c.6-3.2 3.4-5 7-5s6.4 1.8 7 5',
};

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="flex-none"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
