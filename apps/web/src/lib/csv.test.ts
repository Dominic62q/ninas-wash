import { describe, expect, it } from 'vitest';
import { cedis, csvCell, toCsv } from './csv';

describe('csv', () => {
  it('quotes cells with commas, quotes and new lines', () => {
    expect(csvCell('Wash, wax')).toBe('"Wash, wax"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it('stops text being run as a formula but leaves numbers alone', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('-12.50')).toBe('-12.50');
    expect(csvCell(null)).toBe('');
  });

  it('writes one line per row', () => {
    expect(toCsv([['Day', 'Total'], ['Mon', cedis(1250)]])).toBe('Day,Total\r\nMon,12.50\r\n');
  });
});
