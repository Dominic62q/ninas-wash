import type { Permission } from '@niinas/shared';

export interface NavItem {
  path: string;
  label: string;
  icon: IconName;
  /** Needed to see this item. Leave out if every signed-in person can. */
  needs?: Permission;
  /** Only for a login that belongs to an attendant. */
  attendantOnly?: boolean;
  /** Any one of these is enough. For an item that gathers several screens, like Settings. */
  needsAny?: Permission[];
  /** Lives on the Settings screen instead of the menu. */
  inSettings?: { section: 'Business' | 'People' | 'Customers' | 'Records'; blurb: string };
  /** Which build phase delivers the real screen. */
  phase: number;
  group: 'Daily' | 'Money' | 'Setup';
}

export type IconName = 'home' | 'jobs' | 'users' | 'receipt' | 'coin' | 'lock' | 'chart' | 'tag' | 'staff' | 'chat' | 'more' | 'history' | 'settings';

/** The last build phase whose screens are finished. */
export const BUILT_PHASE = 9;

export const SETTINGS_SECTIONS = ['Business', 'People', 'Customers', 'Records'] as const;

export const NAV: NavItem[] = [
  { path: '/', label: 'Dashboard', icon: 'home', needs: 'dashboard.view', phase: 0, group: 'Daily' },
  { path: '/my-work', label: 'My work', icon: 'coin', needs: 'self.view', attendantOnly: true, phase: 9, group: 'Daily' },
  { path: '/jobs', label: 'Jobs', icon: 'jobs', needs: 'job.create', phase: 2, group: 'Daily' },
  { path: '/customers', label: 'Customers', icon: 'users', needs: 'customer.manage', phase: 1, group: 'Daily' },
  { path: '/expenses', label: 'Expenses', icon: 'receipt', needs: 'expense.create', phase: 5, group: 'Money' },
  { path: '/commissions', label: 'Commissions', icon: 'coin', needs: 'commission.view', phase: 4, group: 'Money' },
  { path: '/tips', label: 'Tips', icon: 'coin', needs: 'tip.record', phase: 4, group: 'Money' },
  { path: '/daily-close', label: 'Daily close', icon: 'lock', needs: 'dailyclose.close', phase: 5, group: 'Money' },
  { path: '/reports', label: 'Reports', icon: 'chart', needs: 'report.view', phase: 6, group: 'Money' },
  {
    path: '/settings',
    label: 'Settings',
    icon: 'settings',
    needsAny: ['service.manage', 'settings.manage', 'user.reset_password', 'role.manage', 'sms.view', 'audit.read'],
    phase: 9,
    group: 'Setup',
  },
  { path: '/services', label: 'Services', icon: 'tag', needs: 'service.manage', phase: 1, group: 'Setup', inSettings: { section: 'Business', blurb: 'What you sell, its price and the commission it earns' } },
  { path: '/payment-methods', label: 'Payment methods', icon: 'coin', needs: 'settings.manage', phase: 9, group: 'Setup', inSettings: { section: 'Business', blurb: 'Cash, MoMo and any other way money is paid' } },
  { path: '/expense-categories', label: 'Expense categories', icon: 'receipt', needs: 'settings.manage', phase: 9, group: 'Setup', inSettings: { section: 'Business', blurb: 'What money can be spent on, and which ones ask for a note' } },
  { path: '/staff', label: 'Staff and users', icon: 'staff', needs: 'user.reset_password', phase: 1, group: 'Setup', inSettings: { section: 'People', blurb: 'Attendants, and who can sign in' } },
  { path: '/roles', label: 'Roles and access', icon: 'lock', needs: 'role.manage', phase: 9, group: 'Setup', inSettings: { section: 'People', blurb: 'Make roles and choose what each may do' } },
  { path: '/sms', label: 'Texts', icon: 'chat', needs: 'sms.view', phase: 8, group: 'Setup', inSettings: { section: 'Customers', blurb: 'The texts customers get, and when' } },
  { path: '/activity', label: 'Activity log', icon: 'history', needs: 'audit.read', phase: 8, group: 'Setup', inSettings: { section: 'Records', blurb: 'Who changed what, and when' } },
];

/** What the phone's Money tab lists: every finished money screen this person may open. */
export function moneyFor(items: NavItem[]): NavItem[] {
  return items.filter((i) => i.group === 'Money' && i.phase <= BUILT_PHASE);
}

/** What the phone's Me tab lists besides the person's own details: customers and Settings. */
export function meFor(items: NavItem[]): NavItem[] {
  return items.filter((i) => ((i.group === 'Setup' && !i.inSettings) || i.path === '/customers') && i.phase <= BUILT_PHASE);
}

/** What the Settings screen lists. */
export function settingsFor(items: NavItem[]): NavItem[] {
  return items.filter((i) => i.inSettings && i.phase <= BUILT_PHASE);
}

/** The side rail: everything except the screens that live inside Settings. */
export function railFor(items: NavItem[]): NavItem[] {
  return items.filter((i) => !i.inSettings);
}

/** The menu for one person: only what their permissions allow. */
export function navFor(can: (p: Permission) => boolean, isAttendant = false): NavItem[] {
  return NAV.filter((item) => (!item.attendantOnly || isAttendant) && ((!item.needs && !item.needsAny) || (item.needs && can(item.needs)) || (item.needsAny?.some(can) ?? false)));
}
