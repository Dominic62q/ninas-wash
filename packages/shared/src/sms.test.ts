import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEMPLATES,
  EVENT_PLACEHOLDERS,
  SAMPLE_VALUES,
  AUTO_EVENTS,
  firstName,
  gatewayNumber,
  placeholdersIn,
  renderTemplate,
  smsMoney,
  smsSegments,
  templateInput,
  toPlainText,
  unsupportedChars,
} from './sms.js';

describe('how many texts a message costs', () => {
  it('counts 160 plain characters as one text and 161 as two', () => {
    expect(smsSegments('a'.repeat(160))).toBe(1);
    expect(smsSegments('a'.repeat(161))).toBe(2);
    expect(smsSegments('a'.repeat(306))).toBe(2);
    expect(smsSegments('a'.repeat(307))).toBe(3);
  });

  it('counts a character outside the basic alphabet as shrinking every text to 70', () => {
    expect(smsSegments(`${'a'.repeat(69)}₵`)).toBe(1);
    expect(smsSegments(`${'a'.repeat(70)}₵`)).toBe(2);
    expect(unsupportedChars('Hi ₵ 😀')).toEqual(['₵', '😀']);
  });

  it('costs nothing for no message', () => {
    expect(smsSegments('')).toBe(0);
  });
});

describe('plain text', () => {
  it('swaps curly quotes, dashes and the cedi sign', () => {
    expect(toPlainText('don’t – “wait” ₵5')).toBe('don\'t - "wait" GHS 5');
    expect(toPlainText('GH₵ 12')).toBe('GHS 12');
  });
});

describe('templates', () => {
  it('fills in every word, and leaves unknown ones alone', () => {
    expect(renderTemplate('Hi {name}, {plate} {nope}', { name: 'Kofi', plate: 'GR 1-26' })).toBe('Hi Kofi, GR 1-26 {nope}');
  });

  it('only uses words each event has a value for', () => {
    for (const event of AUTO_EVENTS) {
      const used = placeholdersIn(DEFAULT_TEMPLATES[event]);
      expect(used.every((p) => (EVENT_PLACEHOLDERS[event] as readonly string[]).includes(p))).toBe(true);
      // The standard wording fits in a single text even with the longest likely values.
      expect(smsSegments(renderTemplate(DEFAULT_TEMPLATES[event], SAMPLE_VALUES))).toBe(1);
    }
  });

  it('cleans up a template on the way in, and refuses emoji or an empty one', () => {
    expect(templateInput.parse({ body: ' Thanks, we got ₵{amount} ', enabled: true }).body).toBe('Thanks, we got GHS {amount}');
    expect(templateInput.safeParse({ body: 'Hi 😀', enabled: true }).success).toBe(false);
    expect(templateInput.safeParse({ body: '   ', enabled: true }).success).toBe(false);
    expect(templateInput.safeParse({ body: 'a'.repeat(481), enabled: true }).success).toBe(false);
  });
});

describe('names, money and numbers', () => {
  it('uses the first name, skipping titles', () => {
    expect(firstName('Kofi Mensah')).toBe('Kofi');
    expect(firstName('Mr. Kofi Mensah')).toBe('Kofi');
    expect(firstName('  ')).toBe('there');
    expect(firstName(null)).toBe('there');
  });

  it('spells the currency out', () => {
    expect(smsMoney(5000)).toBe('GHS 50.00');
    expect(smsMoney(5)).toBe('GHS 0.05');
    expect(smsMoney(123456)).toBe('GHS 1234.56');
  });

  it('gives the gateway Ghana numbers with the country code', () => {
    expect(gatewayNumber('0245510932')).toBe('233245510932');
    expect(gatewayNumber('+233245510932')).toBe('233245510932');
    expect(gatewayNumber('+4479460958')).toBe('4479460958');
    expect(gatewayNumber('12345')).toBeNull();
    expect(gatewayNumber(null)).toBeNull();
  });
});
