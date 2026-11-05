/**
 * Everything a person can be allowed to do. A role is a name plus a list of these.
 * The API checks the list on every request. The web app reads the same list only to hide buttons,
 * so the screen and the server can never disagree.
 *
 * `needs` are permissions that make no sense without another (you cannot pay out commission you cannot see).
 * Ticking one ticks what it needs, and unticking a needed one unticks what depends on it.
 */
export const PERMISSION_CATALOG = [
  // Selling
  { key: 'job.create', label: 'Book cars and see the jobs board', group: 'Selling' },
  { key: 'job.advance', label: 'Start and finish washes', group: 'Selling', needs: ['job.create'] },
  { key: 'job.dispatch', label: 'Release cars', group: 'Selling', needs: ['job.create'] },
  { key: 'job.dispatch_with_balance', label: 'Release a car that still owes money', group: 'Selling', needs: ['job.dispatch'] },
  { key: 'job.void', label: 'Void jobs', group: 'Selling', needs: ['job.create'] },
  { key: 'payment.record', label: 'Take payments', group: 'Selling', needs: ['job.create'] },
  { key: 'payment.void', label: 'Void payments', group: 'Selling', needs: ['payment.record'] },
  { key: 'customer.manage', label: 'Add and change customers', group: 'Selling' },
  { key: 'customer.export', label: 'Download the customer list', group: 'Selling', needs: ['customer.manage'] },

  // Money out
  { key: 'expense.create', label: 'Record expenses', group: 'Money out' },
  { key: 'expense.void', label: 'Void expenses', group: 'Money out', needs: ['expense.create'] },
  { key: 'commission.view', label: 'See commission', group: 'Money out' },
  { key: 'commission.payout', label: 'Pay out commission', group: 'Money out', needs: ['commission.view'] },
  { key: 'tip.record', label: 'Record tips', group: 'Money out' },
  { key: 'tip.handout', label: 'Hand tips to attendants', group: 'Money out', needs: ['tip.record'] },
  { key: 'tip.void', label: 'Void tips', group: 'Money out', needs: ['tip.record'] },

  // Control
  { key: 'dailyclose.close', label: 'Close the day', group: 'Control' },
  { key: 'dailyclose.see_expected', label: 'See what the drawer should hold before counting', group: 'Control', needs: ['dailyclose.close'] },
  { key: 'dailyclose.reopen', label: 'Reopen a closed day', group: 'Control', needs: ['dailyclose.close'] },
  { key: 'dashboard.view', label: 'See the dashboard', group: 'Control' },
  { key: 'report.view', label: 'See reports', group: 'Control' },
  { key: 'audit.read', label: 'See the activity log', group: 'Control' },

  // Their own work, for attendants who sign in
  { key: 'self.view', label: 'See their own washes and what they have earned', group: 'Own work' },

  // Customer texts
  { key: 'sms.view', label: 'See texts sent to customers', group: 'Texts' },
  { key: 'sms.send', label: 'Send texts to customers', group: 'Texts', needs: ['sms.view'] },
  { key: 'sms.manage', label: 'Change text wording and switches', group: 'Texts', needs: ['sms.view'] },

  // Setup
  { key: 'service.manage', label: 'Change services and prices', group: 'Setup' },
  { key: 'attendant.manage', label: 'Add and change attendants', group: 'Setup' },
  { key: 'user.manage', label: 'Add users and change their role', group: 'Setup', needs: ['user.reset_password'] },
  { key: 'user.reset_password', label: 'Reset passwords of people with less access', group: 'Setup' },
  { key: 'role.manage', label: 'Create roles and choose what they can do', group: 'Setup', needs: ['user.manage'] },
  { key: 'settings.manage', label: 'Change payment methods and expense categories', group: 'Setup' },
] as const satisfies readonly { key: string; label: string; group: string; needs?: readonly string[] }[];

export type Permission = (typeof PERMISSION_CATALOG)[number]['key'];
export type PermissionGroup = (typeof PERMISSION_CATALOG)[number]['group'];

export const PERMISSION_KEYS = PERMISSION_CATALOG.map((p) => p.key) as readonly Permission[];
export const PERMISSION_GROUPS = ['Selling', 'Money out', 'Control', 'Own work', 'Texts', 'Setup'] as const satisfies readonly PermissionGroup[];

const NEEDS: Record<string, readonly Permission[]> = Object.fromEntries(PERMISSION_CATALOG.map((p) => [p.key, ('needs' in p ? p.needs : []) as readonly Permission[]]));

const isKey = (p: string): p is Permission => p in NEEDS;

/** Drops anything unknown and adds everything a ticked permission needs. Order follows the catalog. */
export function withNeeded(picked: readonly string[]): Permission[] {
  const have = new Set<Permission>(picked.filter(isKey));
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of [...have]) {
      for (const n of NEEDS[p] ?? []) {
        if (!have.has(n)) {
          have.add(n);
          grew = true;
        }
      }
    }
  }
  return PERMISSION_KEYS.filter((k) => have.has(k));
}

/** What a role is given when it is first made. The owner role is not here: it always has everything. */
export const DEFAULT_ROLES = {
  Manager: withNeeded([
    'job.create', 'job.advance', 'job.void', 'job.dispatch', 'job.dispatch_with_balance', 'payment.record', 'payment.void',
    'customer.manage', 'user.reset_password',
    'expense.create', 'expense.void', 'commission.view', 'commission.payout', 'tip.record', 'tip.handout', 'tip.void',
    'dailyclose.close', 'dailyclose.reopen', 'dailyclose.see_expected', 'dashboard.view', 'audit.read',
    'sms.view', 'sms.send',
  ]),
  Cashier: withNeeded([
    'job.create', 'job.advance', 'job.dispatch', 'payment.record', 'customer.manage',
    'expense.create', 'tip.record', 'dailyclose.close', 'dashboard.view',
  ]),
} as const satisfies Record<string, readonly Permission[]>;

export type DefaultRoleName = keyof typeof DEFAULT_ROLES;
export const OWNER_ROLE_NAME = 'Owner';

/** The role's list, with the owner's rule applied: a locked role can do everything. */
export function permissionsOf(role: { locked: boolean; permissions: readonly string[] }): Permission[] {
  return role.locked ? [...PERMISSION_KEYS] : withNeeded(role.permissions);
}

export function can(permissions: readonly Permission[] | ReadonlySet<Permission>, permission: Permission): boolean {
  return permissions instanceof Set ? permissions.has(permission) : (permissions as readonly Permission[]).includes(permission);
}

/** True when everything `a` can do, `b` can do too. */
export function isWithin(a: readonly Permission[], b: readonly Permission[]): boolean {
  return a.every((p) => b.includes(p));
}

/**
 * You may look after someone only if they can do nothing you cannot. Nobody can take over a more powerful account,
 * and (apart from whoever can do everything) nobody looks after an equal.
 */
export function outranks(actor: readonly Permission[], target: readonly Permission[]): boolean {
  return isWithin(target, actor) && (target.length < actor.length || actor.length === PERMISSION_KEYS.length);
}

/** A role as the Roles screen and the user form see it. */
export interface RoleDto {
  id: number;
  name: string;
  /** The owner role. It can do everything and cannot be changed or removed. */
  locked: boolean;
  permissions: Permission[];
  /** People with this role who can still sign in. */
  members: number;
}
