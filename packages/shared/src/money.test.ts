import { describe, expect, it } from 'vitest';
import { formatAmount, formatGHS, parseGHS, percentOf, splitEvenly } from './money.js';
import { can, permissionsFor } from './roles.js';
import { normalizePlate } from './plate.js';

describe('money', () => {
  it('formats pesewas as cedis', () => {
    expect(formatGHS(1250)).toBe('GH₵12.50');
    expect(formatGHS(0)).toBe('GH₵0.00');
    expect(formatGHS(5)).toBe('GH₵0.05');
    expect(formatAmount(123456)).toBe('1,234.56');
    expect(formatGHS(-250)).toBe('-GH₵2.50');
  });

  it('parses typed amounts and rejects ambiguous ones', () => {
    expect(parseGHS('12.50')).toBe(1250);
    expect(parseGHS('12.5')).toBe(1250);
    expect(parseGHS('12')).toBe(1200);
    expect(parseGHS('1,234.56')).toBe(123456);
    expect(parseGHS('GH₵40')).toBe(4000);
    expect(parseGHS('12.505')).toBeNull();
    expect(parseGHS('abc')).toBeNull();
    expect(parseGHS('')).toBeNull();
    expect(parseGHS('-5')).toBeNull();
  });

  it('takes a percentage in basis points, rounding half up', () => {
    expect(percentOf(4000, 1800)).toBe(720); // 18% of GH₵40.00
    expect(percentOf(3333, 1800)).toBe(600); // 599.94 -> 600
    expect(percentOf(250, 1000)).toBe(25);
    expect(percentOf(5, 1000)).toBe(1); // 0.5 rounds up
  });

  it('splits an amount so the pieces add back up exactly', () => {
    expect(splitEvenly(1000, 3)).toEqual([334, 333, 333]);
    expect(splitEvenly(1000, 2)).toEqual([500, 500]);
    expect(splitEvenly(1, 3)).toEqual([1, 0, 0]);
    for (const [amount, parts] of [[9999, 7], [1, 1], [100, 3]] as const) {
      expect(splitEvenly(amount, parts).reduce((a, b) => a + b, 0)).toBe(amount);
    }
  });

  it('rejects fractional pesewas', () => {
    expect(() => formatGHS(12.5)).toThrow(RangeError);
    expect(() => splitEvenly(10.5, 2)).toThrow(RangeError);
  });
});

describe('plates', () => {
  it('ignores case, spaces and dashes', () => {
    expect(normalizePlate('GN 8806-23')).toBe('GN880623');
    expect(normalizePlate('gn8806-23')).toBe('GN880623');
    expect(normalizePlate('GN-8806 23')).toBe('GN880623');
  });
});

describe('roles', () => {
  it('lets only managers and the owner void a job', () => {
    expect(can('cashier', 'job.void')).toBe(false);
    expect(can('manager', 'job.void')).toBe(true);
    expect(can('owner', 'job.void')).toBe(true);
  });

  it('keeps user management with the owner', () => {
    expect(can('manager', 'user.manage')).toBe(false);
    expect(can('owner', 'user.manage')).toBe(true);
  });

  it('gives the owner at least everything a manager has, and a manager everything a cashier has', () => {
    const owner = new Set(permissionsFor('owner'));
    const manager = new Set(permissionsFor('manager'));
    for (const p of permissionsFor('cashier')) expect(manager.has(p)).toBe(true);
    for (const p of manager) expect(owner.has(p)).toBe(true);
  });
});
