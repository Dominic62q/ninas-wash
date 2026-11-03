import { describe, expect, it } from 'vitest';
import { formatPhone, normalizePhone } from './phone.js';
import {
  changePasswordInput,
  createUserInput,
  customerInput,
  serviceInput,
  vehicleInput,
} from './setup.js';

describe('phone numbers', () => {
  it('saves the same Ghana number one way however it is typed', () => {
    for (const typed of ['024 551 0932', '0245510932', '+233 24 551 0932', '233245510932', '(024) 551-0932']) {
      expect(normalizePhone(typed)).toBe('0245510932');
    }
  });

  it('keeps foreign numbers and rejects rubbish', () => {
    expect(normalizePhone('+44 7700 900123')).toBe('+447700900123');
    expect(normalizePhone('12345')).toBeUndefined();
    expect(normalizePhone('abc')).toBeUndefined();
    expect(normalizePhone('024551093')).toBeUndefined(); // one digit short
  });

  it('shows a stored number with spaces', () => {
    expect(formatPhone('0245510932')).toBe('024 551 0932');
    expect(formatPhone(null)).toBe('');
  });
});

describe('service input', () => {
  const ok = { name: 'Exterior wash', price: 4000, commissionKind: 'percent', commissionValue: 1800, active: true } as const;

  it('accepts a normal service', () => {
    expect(serviceInput.safeParse(ok).success).toBe(true);
  });

  it('stops a percentage over 100% and a fixed commission above the price', () => {
    expect(serviceInput.safeParse({ ...ok, commissionValue: 10001 }).success).toBe(false);
    const fixed = serviceInput.safeParse({ ...ok, commissionKind: 'fixed', commissionValue: 5000 });
    expect(fixed.success).toBe(false);
    expect(serviceInput.safeParse({ ...ok, commissionKind: 'fixed', commissionValue: 1000 }).success).toBe(true);
  });

  it('refuses fractional pesewas and negative prices', () => {
    expect(serviceInput.safeParse({ ...ok, price: 40.5 }).success).toBe(false);
    expect(serviceInput.safeParse({ ...ok, price: -1 }).success).toBe(false);
  });
});

describe('people input', () => {
  it('lowercases usernames and rejects odd ones', () => {
    expect(createUserInput.parse({ name: 'Esi', username: ' Esi.Cashier ', role: 'cashier' }).username).toBe('esi.cashier');
    expect(createUserInput.safeParse({ name: 'Esi', username: 'a b', role: 'cashier' }).success).toBe(false);
    expect(createUserInput.safeParse({ name: 'Esi', username: 'ab', role: 'cashier' }).success).toBe(false);
    expect(createUserInput.safeParse({ name: 'Esi', username: 'esi', role: 'boss' }).success).toBe(false);
  });

  it('wants a new password of at least 8 characters', () => {
    expect(changePasswordInput.safeParse({ currentPassword: 'x', newPassword: 'short' }).success).toBe(false);
    expect(changePasswordInput.safeParse({ currentPassword: 'x', newPassword: 'long enough' }).success).toBe(true);
  });
});

describe('customer input', () => {
  it('treats a blank phone as none and cleans a typed one', () => {
    expect(customerInput.parse({ name: 'Abena', phone: '' }).phone).toBeNull();
    expect(customerInput.parse({ name: 'Abena', phone: '020 411 8392' }).phone).toBe('0204118392');
    expect(customerInput.safeParse({ name: 'Abena', phone: '123' }).success).toBe(false);
  });

  it('asks for a real plate', () => {
    expect(vehicleInput.safeParse({ plate: '--' }).success).toBe(false);
    expect(vehicleInput.parse({ plate: 'GN 8806-23' }).plate).toBe('GN 8806-23');
  });

  it('does not consent to texts unless told', () => {
    expect(customerInput.parse({ name: 'Abena' }).okToText).toBe(false);
  });
});
