import { describe, expect, it } from 'vitest';
import { DEFAULT_ROLES, PERMISSION_KEYS, can, type Permission } from '@niinas/shared';
import { BUILT_PHASE, meFor, moneyFor, navFor } from './nav';

type Role = 'cashier' | 'manager' | 'owner';
const PERMISSIONS: Record<Role, readonly Permission[]> = { cashier: DEFAULT_ROLES.Cashier, manager: DEFAULT_ROLES.Manager, owner: PERMISSION_KEYS };
const canAs = (role: Role) => (p: Permission) => can(PERMISSIONS[role], p);
const labelsFor = (role: Role) => navFor(canAs(role)).map((i) => i.label);

describe('menu by role', () => {
  it('shows a cashier the daily screens only', () => {
    const labels = labelsFor('cashier');
    expect(labels).toEqual(expect.arrayContaining(['Dashboard', 'Jobs', 'Customers', 'Expenses', 'Tips', 'Daily close']));
    expect(labels).not.toContain('Reports');
    expect(labels).not.toContain('Commissions');
    expect(labels).not.toContain('Services');
    expect(labels).not.toContain('Texts');
  });

  it('shows a manager money screens and the users list, but not prices or reports', () => {
    const labels = labelsFor('manager');
    expect(labels).toEqual(expect.arrayContaining(['Commissions', 'Customers', 'Staff and users', 'Texts']));
    expect(labels).not.toContain('Reports');
    expect(labels).not.toContain('Services');
  });

  it('shows the owner everything', () => {
    expect(labelsFor('owner')).toEqual(expect.arrayContaining(['Reports', 'Services', 'Staff and users', 'Commissions']));
  });

  it('puts every finished screen on one of the phone tabs, none twice', () => {
    for (const role of ['cashier', 'manager', 'owner'] as const) {
      const items = navFor(canAs(role));
      // Home and Jobs are tabs of their own; Money and Me list the rest.
      const tabs = items.filter((i) => i.path === '/' || i.path === '/jobs').map((i) => i.label);
      const money = moneyFor(items).map((i) => i.label);
      const me = meFor(items).map((i) => i.label);
      const finished = items.filter((i) => i.phase <= BUILT_PHASE).map((i) => i.label);
      expect([...tabs, ...money, ...me].sort()).toEqual(finished.sort());
    }
    expect(moneyFor(navFor(canAs('cashier'))).map((i) => i.label)).toEqual(['Expenses', 'Tips', 'Daily close']);
    expect(meFor(navFor(canAs('cashier'))).map((i) => i.label)).toEqual(['Customers']);
  });

  it('never gives a cashier something a manager does not also have', () => {
    const manager = new Set(labelsFor('manager'));
    for (const label of labelsFor('cashier')) expect(manager.has(label)).toBe(true);
  });
});
