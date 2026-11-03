export const ROLES = ['cashier', 'manager', 'owner'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Every action the system can do, and which roles may do it.
 * The API checks this on every request. The web app reads the same table only to
 * hide buttons, so the screen and the server can never disagree.
 *
 * First-draft defaults. The ones marked (confirm) need the client's answer.
 */
export const PERMISSIONS = {
  // Selling
  'job.create': ['cashier', 'manager', 'owner'],
  'job.advance': ['cashier', 'manager', 'owner'],
  'job.void': ['manager', 'owner'],
  'job.dispatch': ['cashier', 'manager', 'owner'],
  'job.dispatch_with_balance': ['manager', 'owner'], // (confirm) override needs a note
  'payment.record': ['cashier', 'manager', 'owner'],
  'payment.void': ['manager', 'owner'],

  // Setup. Prices, staff and reports are owner-only, as on the approved "What each role can do" screen.
  'customer.manage': ['cashier', 'manager', 'owner'],
  'customer.export': ['owner'],
  'service.manage': ['owner'],
  'attendant.manage': ['owner'],
  'user.manage': ['owner'],
  // A manager can reset a cashier's password, never another manager's or the owner's (the API enforces who).
  'user.reset_password': ['manager', 'owner'],

  // Money out
  'expense.create': ['cashier', 'manager', 'owner'],
  'expense.void': ['manager', 'owner'],
  'commission.view': ['manager', 'owner'],
  'commission.payout': ['manager', 'owner'],
  'tip.record': ['cashier', 'manager', 'owner'],
  'tip.handout': ['manager', 'owner'],
  'tip.void': ['manager', 'owner'],

  // Control
  'dailyclose.close': ['cashier', 'manager', 'owner'],
  'dailyclose.reopen': ['manager', 'owner'], // (confirm) manager-only, with a reason
  // (confirm) A cashier counts the drawer without being told what it should hold, so the count is honest.
  'dailyclose.see_expected': ['manager', 'owner'],
  'dashboard.view': ['cashier', 'manager', 'owner'],
  'report.view': ['owner'],
  'audit.read': ['manager', 'owner'],

  // Customer texts. (confirm) A cashier cannot message customers by hand; the automatic texts go out whoever is at the till.
  'sms.view': ['manager', 'owner'],
  'sms.send': ['manager', 'owner'],
  'sms.manage': ['owner'], // wording, switching texts on or off, credit records
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

export function permissionsFor(role: Role): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(role, p));
}
