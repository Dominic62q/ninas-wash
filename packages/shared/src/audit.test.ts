import { describe, expect, it } from 'vitest';
import { auditFields, auditLabel, auditSummary } from './audit.js';

describe('activity log wording', () => {
  it('names known actions in plain words and tidies unknown ones', () => {
    expect(auditLabel('payment.record')).toBe('Took a payment');
    expect(auditLabel('thing.do_something')).toBe('Thing do something');
  });

  it('shows money as cedis and never shows secrets', () => {
    const fields = auditFields({ amount: 2050, method: 'cash', passwordHash: 'x', idemKey: 'y', receipt: null });
    expect(fields).toEqual([
      ['amount', 'GH₵20.50'],
      ['method', 'cash'],
      ['receipt', 'empty'],
    ]);
  });

  it('summarises from what it became, or what it was when it was voided', () => {
    expect(auditSummary({ before: { amount: 500 }, after: null, note: 'Wrong amount' })).toBe('amount GH₵5.00 · Wrong amount');
    expect(auditSummary({ before: null, after: null, note: null })).toBe('');
  });
});
