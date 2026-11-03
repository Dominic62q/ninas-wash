import type { Permission } from '@niinas/shared';

export interface NavItem {
  path: string;
  label: string;
  icon: IconName;
  /** Needed to see this item. Leave out if every signed-in person can. */
  needs?: Permission;
  /** Which build phase delivers the real screen. */
  phase: number;
  group: 'Daily' | 'Money' | 'Setup';
}

export type IconName = 'home' | 'jobs' | 'users' | 'receipt' | 'coin' | 'lock' | 'chart' | 'tag' | 'staff' | 'chat' | 'more';

/** The last build phase whose screens are finished. */
export const BUILT_PHASE = 8;

export const NAV: NavItem[] = [
  { path: '/', label: 'Dashboard', icon: 'home', needs: 'dashboard.view', phase: 0, group: 'Daily' },
  { path: '/jobs', label: 'Jobs', icon: 'jobs', needs: 'job.create', phase: 2, group: 'Daily' },
  { path: '/customers', label: 'Customers', icon: 'users', needs: 'customer.manage', phase: 1, group: 'Daily' },
  { path: '/expenses', label: 'Expenses', icon: 'receipt', needs: 'expense.create', phase: 5, group: 'Money' },
  { path: '/commissions', label: 'Commissions', icon: 'coin', needs: 'commission.view', phase: 4, group: 'Money' },
  { path: '/tips', label: 'Tips', icon: 'coin', needs: 'tip.record', phase: 4, group: 'Money' },
  { path: '/daily-close', label: 'Daily close', icon: 'lock', needs: 'dailyclose.close', phase: 5, group: 'Money' },
  { path: '/reports', label: 'Reports', icon: 'chart', needs: 'report.view', phase: 6, group: 'Money' },
  { path: '/sms', label: 'Texts', icon: 'chat', needs: 'sms.view', phase: 8, group: 'Setup' },
  { path: '/services', label: 'Services', icon: 'tag', needs: 'service.manage', phase: 1, group: 'Setup' },
  { path: '/staff', label: 'Staff and users', icon: 'staff', needs: 'user.reset_password', phase: 1, group: 'Setup' },
];

/** What the phone's Money tab lists: every finished money screen this person may open. */
export function moneyFor(items: NavItem[]): NavItem[] {
  return items.filter((i) => i.group === 'Money' && i.phase <= BUILT_PHASE);
}

/** What the phone's Me tab lists besides the person's own details: customers and setup. */
export function meFor(items: NavItem[]): NavItem[] {
  return items.filter((i) => (i.group === 'Setup' || i.path === '/customers') && i.phase <= BUILT_PHASE);
}

/** The menu for one person: only what their permissions allow. */
export function navFor(can: (p: Permission) => boolean): NavItem[] {
  return NAV.filter((item) => !item.needs || can(item.needs));
}
